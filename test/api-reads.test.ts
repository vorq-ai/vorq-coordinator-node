import type { FastifyInstance } from "fastify";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api/app.js";
import { rawJson, toJsonText } from "../src/api/serialize.js";
import type { Addresses, Config } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import { formatUsd } from "../src/money.js";
import { UINT128_MAX } from "../src/orders.js";
import { createSession } from "../src/api/sessions.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { bareRevert, stubChain } from "./support/stub-chain.js";

/**
 * The read API. Two halves, and only the second needs a database:
 *
 *   * the readiness gate, the envelopes and the JSON boundary, driven through
 *     `app.inject()` against a stubbed indexer — no chain, no Postgres;
 *   * the routes themselves, over a seeded projection, gated on `TEST_DATABASE_URL`
 *     and deliberately in the **unit** suite (R25) — the no-network rule is
 *     about chain access, not a local database:
 *
 *       docker compose -f compose.dev.yml up -d
 *       TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_api_test";

/** A valid secp256k1 scalar. Not a credential — no chain has ever used it. */
const DUMMY_KEY = `0x${"11".repeat(32)}` as const;

const ADDRESSES: Addresses = {
  chainId: 97,
  deployBlock: 0,
  jobRegistry: "0x1111111111111111111111111111111111111111",
  providerRegistry: "0x2222222222222222222222222222222222222222",
  askRegistry: "0x3333333333333333333333333333333333333333",
  usdc: "0x4444444444444444444444444444444444444444",
  decimals: 6,
  tokenDomain: { name: "USDC", version: "2" },
};

function config(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    getLogsCap: 5000,
    dbUrl: TEST_DATABASE_URL ?? "postgres://unused",
    relayerKey: DUMMY_KEY,
    blockTimeMs: 450,
    port: 8402,
    readyLagBlocks: 30,
    // No browser calls a node under test. Spec 02: an empty list registers no
    // CORS at all, which is the shipped default.
    corsOrigins: [],
    maxBlobBytes: MAX_BLOB_BYTES,
    fileRetentionSeconds: 2_592_000,
    pinS3: {
        endpoint: "http://127.0.0.1:1",
        key: "unused",
        secret: "unused",
        bucket: "unused",
        region: "us-east-1",
      },
    relayMaxDepth: 32,
    relayQueueTimeoutMs: 10_000,
    relayerLowBalanceGwei: 50_000_000,
    // Plan 3's escrow, off: the shipped default, and nothing here touches it.
    escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 },
    match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
    jobRateLimit: 0,
    addresses: ADDRESSES,
    ...overrides,
  };
}

/** An indexer that only answers `status()`; nothing here drives a poll loop. */
function stubIndexer(status: () => Promise<IndexerStatus>): Indexer {
  return {
    coldStart: async () => undefined,
    poll: async () => undefined,
    status,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

const ready = (cursor: bigint, head = cursor): IndexerStatus => ({
  cursor,
  head,
  ready: true,
  forked: null,
});

/** A database handle no test in the gate half ever reaches. */
const unreachableDb = (): Db => ({
  query: () => Promise.reject(new Error("the gate must answer before any query")),
  tx: () => Promise.reject(new Error("the gate must answer before any query")),
  migrate: () => Promise.reject(new Error("the gate must answer before any query")),
  close: async () => undefined,
});

/** Every route the readiness gate covers. `/healthz` and `/readyz` are not here. */
const GATED_ROUTES = [
  "/evm/jobs",
  `/evm/jobs/0x${"01".repeat(32)}`,
  `/v1/jobs/0x${"01".repeat(32)}`,
  "/evm/providers",
  "/evm/providers/1",
  "/evm/allowlist",
  "/evm/models",
  "/v1/models",
  "/evm/asks/floors",
  // Inlined rather than `hex(OWNER)`: both are defined below this constant, and
  // this list is only read inside a test body, so the literal is the small fix.
  `/evm/jobs/summary?owner=0x${"aa".repeat(20)}`,
  "/evm/jobs?state=Open&model=7&free=1",
];

// ---------------------------------------------------------------------------
// The JSON boundary
// ---------------------------------------------------------------------------

describe("toJsonText", () => {
  it("is needed at all because JSON.stringify throws on a BIGINT column (R46)", () => {
    // The failure this module exists to prevent, stated as an assertion so the
    // reason survives the next reader: 14 columns and `allowed_models` come back
    // as `bigint`, and `completion_tok` — uint32 on chain, BIGINT in the schema —
    // is the one nobody expects.
    expect(() => JSON.stringify({ completion_tok: 1n })).toThrow(TypeError);
  });

  it("writes every bigint as a JSON integer, exactly", () => {
    expect(toJsonText({ expires_at: 9007199254740991n })).toBe('{"expires_at":9007199254740991}');
    expect(toJsonText([1n, 2n])).toBe("[1,2]");
  });

  it("throws on a bigint a double cannot hold, rather than rounding it", () => {
    expect(() => toJsonText({ expires_at: 9007199254740992n })).toThrow(RangeError);
  });

  it("writes bytes as 0x hex rather than Buffer's own JSON shape", () => {
    // Buffer.toJSON() runs before a replacer sees the value, so `{type:"Buffer",
    // data:[…]}` is what a naive replacer would be handed. The holder is read
    // instead, which is the only way to see the Buffer itself.
    expect(toJsonText({ job_id: Buffer.from([0xde, 0xad]) })).toBe('{"job_id":"0xdead"}');
    expect(toJsonText({ key: Uint8Array.from([0x01]) })).toBe('{"key":"0x01"}');
  });

  it("splices raw jsonb text in unparsed, so a wide number is not rounded (R51)", () => {
    // The driver would parse this into a double and hand back
    // 12345678901234567000. The text never becomes a JS number at all.
    expect(toJsonText({ evidence: rawJson('{"n": 12345678901234567890}') })).toBe(
      '{"evidence":{"n": 12345678901234567890}}',
    );
  });

  it("cannot be spoofed by a string that looks like its splice marker", () => {
    // The marker is a per-call random token, so a chain-supplied string cannot
    // impersonate one and have arbitrary text spliced into the response.
    const text = toJsonText({ name: "0:0", evidence: rawJson("[1]") });
    expect(JSON.parse(text)).toEqual({ name: "0:0", evidence: [1] });
  });
});

// ---------------------------------------------------------------------------
// Readiness gate, envelopes, health
// ---------------------------------------------------------------------------

describe("readiness gate", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    await app?.close();
  });

  async function withStatus(
    status: () => Promise<IndexerStatus>,
    overrides: Partial<Config> = {},
  ): Promise<FastifyInstance> {
    await app?.close();
    app = buildApp({
      db: unreachableDb(),
      indexer: stubIndexer(status),
      config: config({ blockTimeMs: 60_000, ...overrides }),
    });
    return app;
  }

  const trailing = async (): Promise<IndexerStatus> => ({
    cursor: 100n,
    head: 900n,
    ready: false,
    forked: null,
  });
  const unreachable = (): Promise<IndexerStatus> =>
    Promise.reject(new Error("the RPC endpoint could not be reached"));

  it("answers 503 with the not_ready envelope on every route but health", async () => {
    const server = await withStatus(trailing);

    for (const url of GATED_ROUTES) {
      const res = await server.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toEqual({
        error: { message: "index catching up", type: "not_ready", param: null, code: null },
      });
      expect(res.headers["x-vorq-retryable"], url).toBe("true");
      expect(res.headers["x-request-id"], url).toMatch(/^req_[0-9a-f]{16}$/);
    }
  });

  it("keeps /healthz and /readyz answering while the index catches up", async () => {
    const server = await withStatus(trailing);

    const health = await server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const readiness = await server.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(503);
    // A 503 body carrying bigints proves the reply serializer runs on non-2xx
    // replies too — every later task's 402/409 bodies depend on that.
    expect(readiness.json()).toEqual({
      ready: false,
      reason: "trailing",
      cursor: 100,
      head_block: 900,
      lag: 800,
    });
  });

  it("answers /healthz even when the chain is unreachable", async () => {
    const server = await withStatus(unreachable);

    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps 'trailing the chain' and 'chain unreachable' distinguishable", async () => {
    // Flattening the rejection into ready:false would erase the difference
    // between a node that is catching up and a node that cannot see the chain at
    // all; the first heals itself, the second needs an operator.
    const server = await withStatus(unreachable);

    const readiness = await server.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({ ready: false, reason: "chain_unreachable" });

    const gated = await server.inject({ method: "GET", url: "/evm/jobs" });
    expect(gated.statusCode).toBe(503);
    expect(gated.json()).toEqual({
      error: {
        message: "chain unreachable; readiness cannot be determined",
        type: "chain_unreachable",
        param: null,
        code: null,
      },
    });
    expect(gated.headers["x-vorq-retryable"]).toBe("true");
  });

  it("reports a node that has indexed nothing as cold_start, not as trailing", async () => {
    const server = await withStatus(async () => ({
      cursor: null,
      head: 40n,
      ready: false,
      forked: null,
    }));

    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      reason: "cold_start",
      cursor: null,
      head_block: 40,
      lag: null,
    });
  });

  it("reports a forked node as reorg, not as trailing", async () => {
    // The distinction an operator acts on: `trailing` heals itself, `reorg`
    // never does. A forked node still has a cursor and may still be inside the
    // lag, so `reason` must be decided on `forked` before either of those.
    const server = await withStatus(async () => ({
      cursor: 120n,
      head: 125n,
      ready: false,
      forked: 120n,
    }));

    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      reason: "reorg",
      cursor: 120,
      head_block: 125,
      lag: 5,
    });
  });

  it("reports ready at cursor 0, where a truthiness check would report otherwise", async () => {
    // On a fresh chain the head sits at 0 for the first blocks and the cursor
    // legitimately rests there. `ready` is decided by the indexer, which tests
    // `cursor !== null`; nothing here may re-decide it with `if (cursor)`.
    const server = await withStatus(async () => ready(0n));

    const res = await server.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ready: true,
      reason: "ready",
      cursor: 0,
      head_block: 0,
      lag: 0,
    });
  });

  it("probes readiness at most once per poll interval, however many requests arrive", async () => {
    // The gate runs before every route. Without a cache each request would cost
    // a head round trip and a cursor read, and readiness cannot change
    // faster than the indexer polls anyway.
    const status = vi.fn(async () => ready(10n));
    const server = await withStatus(status, { blockTimeMs: 60_000 });

    for (let i = 0; i < 4; i++) await server.inject({ method: "GET", url: "/readyz" });

    expect(status).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the interval has passed", async () => {
    const status = vi.fn(async () => ready(10n));
    const server = await withStatus(status, { blockTimeMs: 1 });

    await server.inject({ method: "GET", url: "/readyz" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await server.inject({ method: "GET", url: "/readyz" });

    expect(status).toHaveBeenCalledTimes(2);
  });

  it("answers an unknown route in the error envelope", async () => {
    const server = await withStatus(async () => ready(10n));

    const res = await server.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        message: "Unknown route: GET /nope",
        type: "not_found",
        param: null,
        code: null,
      },
    });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// The routes, over a seeded projection
// ---------------------------------------------------------------------------

const bytes = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);

const JOB = {
  open: bytes(0x01),
  expired: bytes(0x02),
  claimed: bytes(0x03),
  settled: bytes(0x04),
  failed: bytes(0x05),
  cancelled: bytes(0x06),
};

const hex = (buffer: Buffer): string => `0x${buffer.toString("hex")}`;

const OWNER = bytes(0xaa, 20);
const OTHER_OWNER = bytes(0xab, 20);

/** Past the range a double holds exactly: never a count, and so never served. */
const BEYOND_SAFE_INTEGER = 9007199254740993n;

/**
 * A rate floor at the largest integer the wire carries, 2^53 − 1, and the value
 * one scaled unit below it: the filter is exact at the top of its range.
 */
const RATE_FLOOR = UINT128_MAX;
const RATE_BELOW_FLOOR = RATE_FLOOR - 1n;
/** The floor as the query spells it: USD per 1M units. */
const FLOOR_USD = formatUsd(RATE_FLOOR, 6);

const FAR_FUTURE = 4_102_444_800n;
const LONG_PAST = 1_000_000_000n;

describe.skipIf(!TEST_DATABASE_URL)("read API", () => {
  let db: Db;
  let app: FastifyInstance;

  async function seedJob(overrides: Record<string, unknown> = {}): Promise<void> {
    const row: Record<string, unknown> = {
      job_id: JOB.open,
      owner: OWNER,
      c: bytes(0xbb),
      model_id: 7,
      sla_secs: 3600,
      designated: 0,
      rate_in: 30000,
      rate_out: 90000,
      units_in: 1000,
      units_out: 2000,
      expires_at: FAR_FUTURE,
      task_cid: Buffer.from("bafkreitaskcid", "utf8"),
      posted_block: 11,
      as_of_block: 12,
      gas_fee: 30000,
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO jobs (${columns.join(", ")}) VALUES (` +
        `${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      Object.values(row),
    );
  }

  async function seedProvider(overrides: Record<string, unknown> = {}): Promise<void> {
    const row: Record<string, unknown> = {
      provider_id: 1,
      operator: bytes(0xcc, 20),
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO providers (${columns.join(", ")}) VALUES (` +
        `${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      Object.values(row),
    );
  }

  async function seedModel(modelId: number, name = `model-${modelId}`): Promise<void> {
    await db.query("INSERT INTO models (model_id, name) VALUES ($1, $2)", [modelId, name]);
  }

  async function seedAsk(row: {
    provider_id: number;
    model_id: number;
    sla: number;
    rate_in: number;
    rate_out: number;
  }): Promise<void> {
    await db.query(
      "INSERT INTO asks_chain (provider_id, model_id, sla, rate_in, rate_out) VALUES ($1, $2, $3, $4, $5)",
      [row.provider_id, row.model_id, row.sla, row.rate_in, row.rate_out],
    );
  }

  async function setCursor(block: bigint): Promise<void> {
    await db.query(
      "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') " +
        "ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number",
      [block],
    );
  }

  const get = (url: string) => app.inject({ method: "GET", url });

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    app = buildApp({
      db,
      indexer: stubIndexer(async () => ready(4242n)),
      config: config({ blockTimeMs: 60_000 }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of [
      "jobs", "providers", "models", "allowlist", "cursor", "asks_chain",
      "sessions", "provider_presence", "job_leases",
    ]) {
      await db.query(`DELETE FROM ${table}`);
    }
    await setCursor(4242n);
  });

  describe("GET /evm/jobs", () => {
    it("excludes expired rows from the Open book without any writer touching them", async () => {
      await seedJob({ job_id: JOB.open, expires_at: FAR_FUTURE });
      await seedJob({ job_id: JOB.expired, expires_at: LONG_PAST });

      const res = await get("/evm/jobs?state=Open");

      expect(res.statusCode).toBe(200);
      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([hex(JOB.open)]);

      // Openness is computed, never materialised (R3): the expired row is still
      // exactly what the reducer wrote.
      const stored = await db.query<{ state: number; ended_because: number }>(
        "SELECT state, ended_because FROM jobs WHERE job_id = $1",
        [JOB.expired],
      );
      expect(stored.rows[0]).toEqual({ state: 0, ended_because: 0 });
    });

    /**
     * **A-D / R78: the one place the book decides whether a job is open, at the
     * edge.**
     *
     * `state = 0 AND expires_at > now` and its complement `expires_at <= now`
     * (`routes/jobs.ts`) are this node's restatement of `JobRegistry`'s own
     * `now > expiresAt` and of `getJob`'s computed `state 3 / cause 5` pair (R3).
     * Every fixture in this file probed *past* both edges — `FAR_FUTURE` and
     * `LONG_PAST` — so moving either operator by one second changed which jobs a
     * client is shown without a single assertion going red.
     *
     * A row expiring at exactly `now` **is open**: `JobRegistry` derives an
     * ending only when `block.timestamp > j.expiresAt` (`:526`) and `claim`
     * explicitly lets a claim landing on the expiry second through (`:242`).
     * Writing this test is what found that the node said the opposite —
     * `expires_at > now` for Open, `expires_at <= now` for expired — and hid a
     * still-claimable job for one second while reporting it `Cancelled`. Both
     * operators moved; this asserts the edge from both sides.
     */
    it("puts a job expiring at exactly now in Open, and one a second earlier in Cancelled (R78)", async () => {
      // `now` as the SQL sees it, so the fixtures sit exactly on the boundary
      // rather than near it — and the whole probe is retried if the database's
      // second ticks over while it runs, because then the row was never on the
      // edge at query time and the observation would be about the clock instead
      // of about the operator.
      const clock = async (): Promise<bigint> =>
        (
          await db.query<{ now: bigint }>("SELECT floor(extract(epoch from now()))::bigint AS now")
        ).rows[0]!.now;

      let open!: Awaited<ReturnType<typeof get>>;
      let cancelled!: Awaited<ReturnType<typeof get>>;
      for (let attempt = 0; ; attempt += 1) {
        await db.query("DELETE FROM jobs");
        const now = await clock();
        await seedJob({ job_id: JOB.open, expires_at: now }); // at the edge
        await seedJob({ job_id: JOB.expired, expires_at: now - 1n }); // one second past it

        open = await get("/evm/jobs?state=Open");
        cancelled = await get("/evm/jobs?state=Cancelled");

        if ((await clock()) === now) break;
        expect(attempt).toBeLessThan(9); // a second boundary every attempt is not a clock
      }

      // `expires_at > now` — flipping it to `>=` drops this row out of Open.
      expect(open.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([hex(JOB.open)]);
      // `expires_at <= now` — flipping it to `<` loses this row from every
      // listing, which is worse than showing it in the wrong one.
      expect(cancelled.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([
        hex(JOB.expired),
      ]);
    });

    it("counts an expired open row as Cancelled, exactly as getJob does", async () => {
      // Every row belongs to exactly one state listing. An expired order that
      // fell out of Open has to reappear under Cancelled or it is invisible.
      await seedJob({ job_id: JOB.expired, expires_at: LONG_PAST });
      await seedJob({ job_id: JOB.cancelled, state: 3, ended_because: 2 });

      const res = await get("/evm/jobs?state=Cancelled");

      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id).sort()).toEqual(
        [hex(JOB.expired), hex(JOB.cancelled)].sort(),
      );
    });

    it("filters by claimed and settled state", async () => {
      await seedJob({ job_id: JOB.claimed, state: 1, provider_id: 9, claimed_at: 1700 });
      await seedJob({ job_id: JOB.settled, state: 2, ended_because: 1 });

      expect((await get("/evm/jobs?state=Claimed")).json().jobs).toHaveLength(1);
      expect((await get("/evm/jobs?state=Settled")).json().jobs).toHaveLength(1);
      expect((await get("/evm/jobs")).json().jobs).toHaveLength(2);
    });

    it("takes an integer model id, not a model name (R26)", async () => {
      await seedJob({ job_id: JOB.open, model_id: 7 });
      await seedJob({ job_id: JOB.claimed, model_id: 8, state: 1 });

      const res = await get("/evm/jobs?model=7");
      expect(res.json().jobs.map((job: { model_id: number }) => job.model_id)).toEqual([7]);

      const named = await get("/evm/jobs?model=model-a");
      expect(named.statusCode).toBe(400);
      expect(named.json().error).toMatchObject({ type: "invalid_request_error", param: "model" });
    });

    it("filters by provider and by owner", async () => {
      await seedJob({ job_id: JOB.claimed, state: 1, provider_id: 9 });
      await seedJob({ job_id: JOB.open, owner: OTHER_OWNER });

      expect((await get("/evm/jobs?provider=9")).json().jobs).toHaveLength(1);
      expect((await get(`/evm/jobs?owner=${hex(OTHER_OWNER)}`)).json().jobs).toHaveLength(1);
      expect((await get(`/evm/jobs?owner=${hex(OWNER)}`)).json().jobs).toHaveLength(1);
      expect((await get("/evm/jobs?owner=0xnothex")).statusCode).toBe(400);
      expect((await get("/evm/jobs?state=Unknown")).statusCode).toBe(400);
    });

    /**
     * The three filters a provider needs to see the bids it can act on.
     *
     * The listing is bounded (`PAGE_DEFAULT_LIMIT`) and ordered `posted_block,
     * job_id` — oldest first — so on a large book the cheap stale head of the
     * queue hides every profitable bid behind it from a caller that does not
     * page. Narrowing server-side is the answer paging cannot give.
     */
    it("filters by min_rate_out at the largest rate the wire carries", async () => {
      await seedJob({ job_id: JOB.open, rate_out: RATE_FLOOR });
      await seedJob({ job_id: JOB.claimed, rate_out: RATE_BELOW_FLOOR, state: 1 });

      const res = await get(`/evm/jobs?min_rate_out=${FLOOR_USD}`);

      expect(res.statusCode).toBe(200);
      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([hex(JOB.open)]);
      // And the served rate is still the exact integer, not a rounded one.
      expect(res.json().jobs[0].rate_out).toBe(FLOOR_USD);
    });

    it("filters by min_rate_in at the same width", async () => {
      await seedJob({ job_id: JOB.open, rate_in: RATE_FLOOR });
      await seedJob({ job_id: JOB.claimed, rate_in: RATE_BELOW_FLOOR, state: 1 });

      const res = await get(`/evm/jobs?min_rate_in=${FLOOR_USD}`);

      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([hex(JOB.open)]);
      expect(res.json().jobs[0].rate_in).toBe(FLOOR_USD);
    });

    /**
     * Bid age, in the only unit the row carries. `posted_block` is chain data
     * the indexer already stores and the listing already serves, and the
     * envelope carries `as_of_block`, so a caller has both ends of the interval
     * without this node deriving a time for it.
     */
    it("filters by posted_before, inclusive of the named block", async () => {
      await seedJob({ job_id: JOB.open, posted_block: 10 });
      await seedJob({ job_id: JOB.claimed, posted_block: 11, state: 1 });
      await seedJob({ job_id: JOB.settled, posted_block: 12, state: 2, ended_because: 1 });

      const res = await get("/evm/jobs?posted_before=11");

      // `<=`, so the boundary block is included — it is "posted by block 11".
      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([
        hex(JOB.open),
        hex(JOB.claimed),
      ]);
    });

    /**
     * **I9: `posted_block = 0` is *unknown*, never *ancient*.**
     *
     * The column is `DEFAULT 0` and `reconcileJob` inserts a row from `getJob`,
     * which carries no posting block, ahead of the reducer's `Posted` event —
     * the hot path for a client polling straight after its `201`. So block 0
     * marks the *newest* jobs in the book. Unguarded, `posted_block <= N`
     * satisfies every bound for exactly those rows and hands an age-filtering
     * caller the freshest bid in the book labelled as the oldest. Asserted from
     * both sides, because the fix must not cost the row its place in the
     * ordinary listing: excluded under any bound, present under none.
     */
    it("never reads an unknown posted_block as ancient (I9)", async () => {
      await seedJob({ job_id: JOB.open, posted_block: 0 }); // reconciled ahead of its log
      await seedJob({ job_id: JOB.claimed, posted_block: 10, state: 1 });

      const filtered = await get("/evm/jobs?posted_before=1000000");
      expect(filtered.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([
        hex(JOB.claimed),
      ]);
      // Not even a bound of 0 admits it — "unknown" is not a block number at all.
      expect((await get("/evm/jobs?posted_before=0")).json().jobs).toHaveLength(0);

      // And the unfiltered book is untouched: an unaged sweep still sees it,
      // first, because block 0 sorts ahead of everything.
      const unfiltered = await get("/evm/jobs");
      expect(unfiltered.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([
        hex(JOB.open),
        hex(JOB.claimed),
      ]);
    });

    it("composes the three with the existing state and model filters", async () => {
      // The one row that satisfies everything.
      await seedJob({ job_id: JOB.open, model_id: 7, rate_out: RATE_FLOOR, posted_block: 10 });
      // One miss each, so every clause is load-bearing in this assertion.
      await seedJob({ job_id: JOB.expired, model_id: 7, rate_out: RATE_FLOOR, posted_block: 10, expires_at: LONG_PAST });
      await seedJob({ job_id: JOB.claimed, model_id: 8, rate_out: RATE_FLOOR, posted_block: 10 });
      await seedJob({ job_id: JOB.settled, model_id: 7, rate_out: RATE_BELOW_FLOOR, posted_block: 10 });
      await seedJob({ job_id: JOB.failed, model_id: 7, rate_out: RATE_FLOOR, posted_block: 12 });

      const res = await get(
        `/evm/jobs?state=Open&model=7&min_rate_out=${FLOOR_USD}&min_rate_in=0.03&posted_before=11`,
      );

      expect(res.json().jobs.map((job: { job_id: string }) => job.job_id)).toEqual([hex(JOB.open)]);
    });

    it("refuses a malformed rate or block, naming the parameter", async () => {
      const refused = async (query: string, param: string): Promise<void> => {
        const res = await get(`/evm/jobs?${query}`);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatchObject({ type: "invalid_request_error", param });
      };

      await refused("min_rate_out=abc", "min_rate_out");
      await refused("min_rate_out=-1", "min_rate_out");
      await refused("min_rate_out=1e18", "min_rate_out");
      // Past the token's precision: rounding it would move the floor.
      await refused("min_rate_out=0.0000001", "min_rate_out");
      // Past the uint128 a rate is held in.
      await refused(`min_rate_out=${formatUsd(UINT128_MAX + 1n, 6)}`, "min_rate_out");
      await refused("min_rate_in=abc", "min_rate_in");
      await refused("posted_before=-1", "posted_before");
      await refused("posted_before=later", "posted_before");
    });

    /**
     * The response shape is frozen (R63) and this task adds request parameters,
     * not response fields. Bounds that exclude nothing must therefore produce
     * the same bytes as sending no bounds at all — same rows, same order, same
     * envelope — so the filters cannot have changed what an existing caller sees.
     */
    it("leaves an unfiltered listing byte-identical", async () => {
      await seedJob({ job_id: JOB.open, rate_in: RATE_FLOOR, rate_out: RATE_FLOOR, posted_block: 10 });
      await seedJob({ job_id: JOB.claimed, state: 1, posted_block: 11 });

      const unfiltered = await get("/evm/jobs");
      const bounded = await get("/evm/jobs?min_rate_out=0&min_rate_in=0&posted_before=4294967295");

      expect(unfiltered.json().jobs).toHaveLength(2);
      expect(bounded.body).toBe(unfiltered.body);
    });

    it("orders newest first on request, with an unknown block ahead of every known one", async () => {
      await seedJob({ job_id: JOB.open, posted_block: 5 });
      await seedJob({ job_id: JOB.claimed, posted_block: 9 });
      // `posted_block = 0` is UNKNOWN, never ancient: reconcile inserts the
      // newest jobs ahead of their logs (jobs.ts:285-296).
      await seedJob({ job_id: JOB.settled, posted_block: 0 });
      // Same block as JOB.claimed, higher id: the tie-break is job_id DESC.
      await seedJob({ job_id: JOB.failed, posted_block: 9 });

      const ids = async (url: string) =>
        (await get(url)).json().jobs.map((j: { job_id: string }) => j.job_id);

      expect(await ids("/evm/jobs?order=newest")).toEqual([
        hex(JOB.settled),
        hex(JOB.failed),
        hex(JOB.claimed),
        hex(JOB.open),
      ]);
      // The default and the explicit spelling are the same, unchanged, order.
      expect(await ids("/evm/jobs")).toEqual([
        hex(JOB.settled),
        hex(JOB.open),
        hex(JOB.claimed),
        hex(JOB.failed),
      ]);
      expect(await ids("/evm/jobs?order=oldest")).toEqual(await ids("/evm/jobs"));
    });

    it("refuses an order it does not know", async () => {
      const res = await get("/evm/jobs?order=sideways");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "order" });
    });

    /**
     * An empty value is a value, and this route's is refused: a query builder
     * that serialises an absent order as `order=` must hear about it rather
     * than be served a silently different page order.
     */
    it("refuses an empty order rather than defaulting it", async () => {
      const res = await get("/evm/jobs?order=");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "order" });
    });

    it("stamps the listing with the index cursor", async () => {
      await setCursor(4243n);
      const res = await get("/evm/jobs");
      expect(res.json().as_of_block).toBe(4243);
    });
  });

  describe("GET /evm/asks/floors", () => {
    beforeEach(async () => {
      await seedModel(7);
      await seedModel(8);
      await seedProvider({ provider_id: 1 });
      await seedProvider({ provider_id: 2 });
      await seedProvider({ provider_id: 3, listed: false });
      // Two listed providers on one (model, window): the cheaper INPUT rate is
      // provider 1's and the cheaper OUTPUT rate is provider 2's.
      await seedAsk({ provider_id: 1, model_id: 7, sla: 3600, rate_in: 30000, rate_out: 90000 });
      await seedAsk({ provider_id: 2, model_id: 7, sla: 3600, rate_in: 50000, rate_out: 20000 });
      // Unlisted: cheaper on both legs, and must not count.
      await seedAsk({ provider_id: 3, model_id: 7, sla: 3600, rate_in: 1, rate_out: 2 });
      // A second window and a second model, so the grouping is visible.
      await seedAsk({ provider_id: 1, model_id: 7, sla: 86400, rate_in: 10000, rate_out: 40000 });
      await seedAsk({ provider_id: 2, model_id: 8, sla: 3600, rate_in: 70000, rate_out: 80000 });
      // A model the catalog does not carry: nothing can be ordered against it.
      await seedAsk({ provider_id: 1, model_id: 99, sla: 3600, rate_in: 5, rate_out: 5 });
    });

    it("answers each leg's minimum over listed providers, per (model, window), in R18's shape", async () => {
      const res = await get("/evm/asks/floors");
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-vorq-page-truncated"]).toBe("false");
      expect(res.json()).toEqual({
        floors: [
          { model_id: 7, sla: 3600, rate_in: "0.03", rate_out: "0.02" },
          { model_id: 7, sla: 86400, rate_in: "0.01", rate_out: "0.04" },
          { model_id: 8, sla: 3600, rate_in: "0.07", rate_out: "0.08" },
        ],
        as_of_block: 4242,
      });
    });

    it("filters by model, before paging", async () => {
      const res = await get("/evm/asks/floors?model=8&limit=1");
      expect(res.json().floors).toEqual([
        { model_id: 8, sla: 3600, rate_in: "0.07", rate_out: "0.08" },
      ]);
    });

    /**
     * The money path reads ONE `(model, window)` row, so it must be able to ask
     * for one: `sla` bounds the window side the way `model` bounds the model
     * side, and how many junk windows a provider has published stops mattering.
     */
    it("filters by window, leaving every other window out", async () => {
      const res = await get("/evm/asks/floors?sla=86400");
      expect(res.statusCode).toBe(200);
      expect(res.json().floors).toEqual([
        { model_id: 7, sla: 86400, rate_in: "0.01", rate_out: "0.04" },
      ]);

      const one = await get("/evm/asks/floors?model=7&sla=3600");
      expect(one.json().floors).toEqual([
        { model_id: 7, sla: 3600, rate_in: "0.03", rate_out: "0.02" },
      ]);
    });

    it("refuses a window that is not a uint32", async () => {
      const res = await get("/evm/asks/floors?sla=4294967296");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "sla" });
    });

    /**
     * Offsets are absolute, not per-page: the second page of the three-group
     * fixture is the second group, with nothing repeated and nothing skipped.
     */
    it("pages by absolute offset", async () => {
      const res = await get("/evm/asks/floors?limit=1&offset=1");
      expect(res.json().floors).toEqual([
        { model_id: 7, sla: 86400, rate_in: "0.01", rate_out: "0.04" },
      ]);
      // A page the byte budget did not cut carries no resume point (R58): the
      // row bound ended this page, and `limit` alone is the caller's cursor.
      expect(res.headers["x-vorq-page-truncated"]).toBe("false");
      expect(res.headers["x-vorq-next-offset"]).toBeUndefined();

      const third = await get("/evm/asks/floors?limit=1&offset=2");
      expect(third.json().floors).toEqual([
        { model_id: 8, sla: 3600, rate_in: "0.07", rate_out: "0.08" },
      ]);
    });

    it("refuses a limit past the maximum rather than clamping it", async () => {
      const res = await get("/evm/asks/floors?limit=100000");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "limit" });
    });
  });

  describe("GET /evm/jobs/summary", () => {
    // Each job's escrow is what its claim locks: the ceiling, the live
    // `feeBps` (1% here) of it floored, and its gas fee (every seed carries
    // 30000). The fee is read off the chain, so this route needs one.
    let summary: FastifyInstance;
    const getSummary = (url: string) => summary.inject({ method: "GET", url });

    beforeAll(() => {
      const nodeConfig = config({ blockTimeMs: 60_000 });
      summary = buildApp({
        db,
        indexer: stubIndexer(async () => ready(4242n)),
        config: nodeConfig,
        chain: stubChain(nodeConfig, { views: { feeBps: 100 } }).chain,
      });
    });

    afterAll(async () => {
      await summary?.close();
    });

    beforeEach(async () => {
      // 30000·1000 + 90000·2000 = 210 000 000 → exactly 210 atomic units.
      await seedJob({ job_id: JOB.settled, model_id: 7, state: 2, ended_because: 1 });
      // 1 500 000·1 → 1.5, which CEILS to 2: truncation would answer 1.
      await seedJob({
        job_id: JOB.open,
        model_id: 7,
        rate_in: 1500000,
        rate_out: 0,
        units_in: 1,
        units_out: 0,
      });
      // The default terms again, on another model: 210.
      await seedJob({ job_id: JOB.claimed, model_id: 3 });
      // Zero-priced: the one-atomic-unit floor, not 0.
      await seedJob({
        job_id: JOB.cancelled,
        model_id: 3,
        rate_in: 0,
        rate_out: 0,
        units_in: 0,
        units_out: 0,
      });
      // Somebody else's job, excluded.
      await seedJob({ job_id: JOB.failed, owner: OTHER_OWNER, model_id: 7 });
    });

    it("sums one wallet's escrow the way the contract locks it at claim", async () => {
      const res = await getSummary(`/evm/jobs/summary?owner=${hex(OWNER)}`);
      expect(res.statusCode).toBe(200);
      // model 3: (210 + 2 + 30000) + (1 + 0 + 30000); model 7: (210 + 2 + 30000) + (2 + 0 + 30000).
      expect(res.json()).toEqual({
        jobs: 4,
        completed: 1,
        escrowed: "0.120427",
        by_model: [
          { model_id: 3, jobs: 2, completed: 0, escrowed: "0.060213" },
          { model_id: 7, jobs: 2, completed: 1, escrowed: "0.060214" },
        ],
        as_of_block: 4242,
      });
    });

    it("requires an owner: an aggregate over the whole book is not served", async () => {
      const res = await getSummary("/evm/jobs/summary");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "owner" });
    });

    it("answers an empty wallet with zeros, not a 404", async () => {
      const res = await getSummary(`/evm/jobs/summary?owner=0x${"cc".repeat(20)}`);
      expect(res.json()).toEqual({
        jobs: 0,
        completed: 0,
        escrowed: "0",
        by_model: [],
        as_of_block: 4242,
      });
    });

    it("503s, retryably, on a node with no chain or a feeBps read that reverts (R77)", async () => {
      const bare = await get(`/evm/jobs/summary?owner=${hex(OWNER)}`);
      expect(bare.statusCode).toBe(503);
      expect(bare.json().error.type).toBe("chain_unreachable");
      expect(bare.headers["x-vorq-retryable"]).toBe("true");

      const nodeConfig = config({ blockTimeMs: 60_000 });
      const reverting = buildApp({
        db,
        indexer: stubIndexer(async () => ready(4242n)),
        config: nodeConfig,
        chain: stubChain(nodeConfig, { callError: () => bareRevert() }).chain,
      });
      try {
        const res = await reverting.inject({ method: "GET", url: `/evm/jobs/summary?owner=${hex(OWNER)}` });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toMatchObject({ type: "relay_unavailable", code: "config_read" });
        expect(res.headers["x-vorq-retryable"]).toBe("true");
      } finally {
        await reverting.close();
      }
    });
  });

  describe("GET /evm/jobs as the provider poll (free=)", () => {
    const providerToken = () => createSession(db, bytes(0xcc, 20), "provider", 1n);
    const poll = async (url: string, token: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    const lease = (jobId: Buffer, providerId: number, live = true) =>
      db.query(
        "INSERT INTO job_leases (job_id, provider_id, expires_at) VALUES ($1, $2, now() + $3::interval)",
        [jobId, providerId, live ? "10 seconds" : "-10 seconds"],
      );
    const leases = async (): Promise<Array<[string, number]>> => {
      const { rows } = await db.query<{ job_id: Buffer; provider_id: bigint }>(
        "SELECT job_id, provider_id FROM job_leases WHERE expires_at > now() ORDER BY job_id",
      );
      return rows.map((row) => [hex(row.job_id), Number(row.provider_id)]);
    };
    const jobIds = (res: { json: () => { jobs: Array<{ job_id: string }> } }) =>
      res.json().jobs.map((job) => job.job_id);
    const presence = () =>
      db.query<{ free_slots: bigint; seen_at: Date; last_assigned_at: Date | null }>(
        "SELECT free_slots, seen_at, last_assigned_at FROM provider_presence WHERE provider_id = 1 AND model_id = 7",
      );

    it("needs a session", async () => {
      const res = await get("/evm/jobs?state=Open&model=7&free=1");
      expect(res.statusCode).toBe(401);
    });

    it("refuses a client session: only a provider has leases", async () => {
      const { token } = await createSession(db, bytes(0xdd, 20), "client", null);
      const res = await poll("/evm/jobs?state=Open&model=7&free=1", token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("not_registered");
    });

    it("needs state=Open and model, and names the one that is missing", async () => {
      const { token } = await providerToken();
      expect((await poll("/evm/jobs?model=7&free=1", token)).json().error.param).toBe("state");
      expect((await poll("/evm/jobs?state=Claimed&model=7&free=1", token)).json().error.param).toBe("state");
      expect((await poll("/evm/jobs?state=Open&free=1", token)).json().error.param).toBe("model");
    });

    it("refuses a model the catalog does not carry, so presence is bounded by providers x models", async () => {
      const { token } = await providerToken();
      const res = await poll("/evm/jobs?state=Open&model=4000000000&free=1", token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.param).toBe("model");
      const { rows } = await db.query("SELECT 1 FROM provider_presence");
      expect(rows).toEqual([]);
    });

    it("records the caller's presence: free slots and freshness, never the cursor", async () => {
      const { token } = await providerToken();
      await seedModel(7);
      await db.query(
        "INSERT INTO provider_presence (provider_id, model_id, free_slots, seen_at, last_assigned_at)" +
          " VALUES (1, 7, 0, now() - interval '1 minute', now() - interval '1 minute')",
      );

      const res = await poll(
        `/evm/jobs?state=Open&model=7&free=3&min_rate_in=${FLOOR_USD}&min_rate_out=${FLOOR_USD}`,
        token,
      );
      expect(res.statusCode).toBe(200);
      const [first] = (await presence()).rows;
      expect(first?.free_slots).toBe(3n);
      expect(Date.now() - (first?.seen_at.getTime() ?? 0)).toBeLessThan(10_000);
      expect(Date.now() - (first?.last_assigned_at?.getTime() ?? 0)).toBeGreaterThan(50_000);

      await poll("/evm/jobs?state=Open&model=7&free=0", token);
      expect((await presence()).rows[0]?.free_slots).toBe(0n);
    });

    it("leases the caller the oldest open jobs it can start, and answers exactly those", async () => {
      const { token } = await providerToken();
      await seedModel(7);
      const first = bytes(0x11);
      const second = bytes(0x12);
      const third = bytes(0x13);
      await seedJob({ job_id: third, posted_block: 13 });
      await seedJob({ job_id: first, posted_block: 11 });
      await seedJob({ job_id: second, posted_block: 12 });

      const res = await poll("/evm/jobs?state=Open&model=7&free=2", token);

      expect(res.statusCode).toBe(200);
      expect(jobIds(res)).toEqual([hex(first), hex(second)]);
      expect(res.json().jobs[0]).toEqual({
        job_id: hex(first),
        owner: hex(OWNER),
        c: hex(bytes(0xbb)),
        model_id: 7,
        sla_secs: 3600,
        designated: 0,
        rate_in: "0.03",
        rate_out: "0.09",
        units_in: 1000,
        units_out: 2000,
        expires_at: Number(FAR_FUTURE),
        state: 0,
        ended_because: 0,
        provider_id: 0,
        claimed_at: 0,
        completion_tok: 0,
        task_cid: "bafkreitaskcid",
        result_cid: null,
        posted_block: 11,
        gas_fee: "0.03",
        fee: "0",
      });
      expect(res.json().as_of_block).toBe(4242);
      expect(await leases()).toEqual([[hex(first), 1], [hex(second), 1]]);

      // Polled again before claiming: the same two, and nothing more taken.
      expect(jobIds(await poll("/evm/jobs?state=Open&model=7&free=2", token))).toEqual([
        hex(first),
        hex(second),
      ]);
      // The next provider gets what is left, and only that.
      const { token: other } = await createSession(db, bytes(0xce, 20), "provider", 2n);
      expect(jobIds(await poll("/evm/jobs?state=Open&model=7&free=5", other))).toEqual([hex(third)]);
      expect(await leases()).toEqual([[hex(first), 1], [hex(second), 1], [hex(third), 2]]);
    });

    it("leases nothing the caller may not take, and answers only its own live leases", async () => {
      const { token } = await providerToken();
      await seedModel(7);
      const mine = bytes(0x11);
      const theirs = bytes(0x12);
      const lapsed = bytes(0x13);
      const claimed = bytes(0x14);
      const otherModel = bytes(0x15);
      const pinnedElsewhere = bytes(0x16);
      const underFloor = bytes(0x17);
      await seedJob({ job_id: mine });
      await seedJob({ job_id: theirs });
      await seedJob({ job_id: lapsed });
      await seedJob({ job_id: claimed, state: 1, provider_id: 1, claimed_at: 1_700_000_000 });
      await seedJob({ job_id: otherModel, model_id: 8 });
      await seedJob({ job_id: pinnedElsewhere, designated: 2 });
      await seedJob({ job_id: underFloor, rate_out: 89999 });
      await lease(mine, 1);
      await lease(theirs, 2);
      await lease(lapsed, 2, false);
      await lease(claimed, 1);
      await lease(otherModel, 1);

      const res = await poll("/evm/jobs?state=Open&model=7&free=10&min_rate_out=0.09", token);

      // `mine` was held already; `lapsed` was free to take; the rest were not.
      expect(jobIds(res)).toEqual([hex(mine), hex(lapsed)]);
      expect(await leases()).toEqual([
        [hex(mine), 1],
        [hex(theirs), 2],
        [hex(lapsed), 1],
        [hex(claimed), 1],
        [hex(otherModel), 1],
      ]);
    });

    it("leaves the public book session-blind: without free the same URL lists every open job", async () => {
      const { token } = await providerToken();
      await seedModel(7);
      await seedJob({ job_id: bytes(0x11) });
      await seedJob({ job_id: bytes(0x12) });
      await poll("/evm/jobs?state=Open&model=7&free=1", token);

      const anonymous = await get("/evm/jobs?state=Open&model=7");
      const asClient = await poll("/evm/jobs?state=Open&model=7", token);

      expect(jobIds(anonymous)).toEqual([hex(bytes(0x11)), hex(bytes(0x12))]);
      expect(jobIds(asClient)).toEqual(jobIds(anonymous));
    });
  });

  describe("GET /evm/jobs/{job_id}", () => {
    it("serves the chain-shaped row, money as USD strings and every other integer as a number", async () => {
      await seedJob({
        job_id: JOB.settled,
        state: 2,
        ended_because: 1,
        provider_id: 9,
        claimed_at: 1_700_000_000,
        completion_tok: 4_294_967_295,
        result_cid: Buffer.from("bafkreiresultcid", "utf8"),
        expires_at: 18_446_744_073,
        rate_in: UINT128_MAX,
        fee: 2500,
      });

      const res = await get(`/evm/jobs/${hex(JOB.settled)}`);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        job_id: hex(JOB.settled),
        owner: hex(OWNER),
        c: hex(bytes(0xbb)),
        model_id: 7,
        sla_secs: 3600,
        designated: 0,
        rate_in: formatUsd(UINT128_MAX, 6),
        rate_out: "0.09",
        units_in: 1000,
        units_out: 2000,
        expires_at: 18446744073,
        state: 2,
        ended_because: 1,
        provider_id: 9,
        claimed_at: 1700000000,
        completion_tok: 4294967295,
        task_cid: "bafkreitaskcid",
        result_cid: "bafkreiresultcid",
        posted_block: 11,
        gas_fee: "0.03",
        fee: "0.0025",
        as_of_block: 4242,
      });
    });

    it("refuses to serve a count a double cannot hold, rather than rounding it", async () => {
      await seedJob({ job_id: JOB.settled, expires_at: BEYOND_SAFE_INTEGER });

      const res = await get(`/evm/jobs/${hex(JOB.settled)}`);

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("9007199254740992");
    });

    it("reads an expired open row as state 3 / ended_because 5, like getJob (R3)", async () => {
      await seedJob({ job_id: JOB.expired, expires_at: LONG_PAST });

      const res = await get(`/evm/jobs/${hex(JOB.expired)}`);

      expect(res.json()).toMatchObject({ state: 3, ended_because: 5 });
      const stored = await db.query<{ state: number; ended_because: number }>(
        "SELECT state, ended_because FROM jobs WHERE job_id = $1",
        [JOB.expired],
      );
      expect(stored.rows[0]).toEqual({ state: 0, ended_because: 0 });
    });

    it("reports an empty result_cid as null", async () => {
      await seedJob({ job_id: JOB.open });
      expect((await get(`/evm/jobs/${hex(JOB.open)}`)).json().result_cid).toBeNull();
    });

    it("404s an unknown id and 400s a malformed one", async () => {
      const unknown = await get(`/evm/jobs/0x${"09".repeat(32)}`);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error).toMatchObject({ type: "not_found" });

      const malformed = await get("/evm/jobs/not-a-job-id");
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toMatchObject({ param: "job_id" });
    });
  });

  describe("what a job paid on top of its charge", () => {
    // Atomic in the columns, a canonical USD string on every read that carries
    // them: no trailing zeros, and a zero fee is "0".
    const FEES: readonly [job: Buffer, column: "gas_fee" | "fee", atomic: number, usd: string][] = [
      [JOB.open, "gas_fee", 30_000, "0.03"],
      [JOB.claimed, "gas_fee", 1, "0.000001"],
      [JOB.settled, "gas_fee", 0, "0"],
      [JOB.open, "fee", 0, "0"],
      [JOB.claimed, "fee", 1, "0.000001"],
      [JOB.settled, "fee", 2_500, "0.0025"],
    ];
    const rows = [JOB.open, JOB.claimed, JOB.settled];

    it("serves gas_fee and fee as USD on /evm/jobs, /evm/jobs/{job_id} and /v1/jobs/{id}", async () => {
      for (const job of rows) {
        const own = FEES.filter(([j]) => j === job).map(([, column, atomic]) => [column, atomic]);
        await seedJob({ job_id: job, ...Object.fromEntries(own) });
      }

      const book = (await get("/evm/jobs")).json().jobs as Record<string, string>[];
      for (const [job, column, , usd] of FEES) {
        expect(book.find((row) => row.job_id === hex(job))?.[column], `${column} of ${hex(job)}`).toBe(usd);
        expect((await get(`/evm/jobs/${hex(job)}`)).json()[column]).toBe(usd);
        expect((await get(`/v1/jobs/${hex(job)}`)).json().vorq[column]).toBe(usd);
      }
    });
  });

  describe("GET /v1/jobs/{id}", () => {
    const statusOf = async (job: Buffer): Promise<string> =>
      (await get(`/v1/jobs/${hex(job)}`)).json().status;

    it("maps every view state onto the client surface", async () => {
      await seedJob({ job_id: JOB.open });
      await seedJob({ job_id: JOB.claimed, state: 1, provider_id: 9, claimed_at: 1_700_000_000 });
      await seedJob({ job_id: JOB.settled, state: 2, ended_because: 1 });
      await seedJob({ job_id: JOB.failed, state: 3, ended_because: 3 });
      await seedJob({ job_id: JOB.cancelled, state: 3, ended_because: 2 });

      expect(await statusOf(JOB.open)).toBe("queued");
      expect(await statusOf(JOB.claimed)).toBe("in_progress");
      expect(await statusOf(JOB.settled)).toBe("completed");
      expect(await statusOf(JOB.failed)).toBe("failed");
      expect(await statusOf(JOB.cancelled)).toBe("cancelled");
    });

    it("answers cancelled for an expired order, never queued", async () => {
      // The trap a literal port of the emulator's `clientStatus` falls into: it
      // reads the stored state, which for an expired order is still Open, and
      // answers `queued` for a job that can never be claimed.
      await seedJob({ job_id: JOB.expired, expires_at: LONG_PAST });

      const res = await get(`/v1/jobs/${hex(JOB.expired)}`);
      expect(res.json()).toMatchObject({
        status: "cancelled",
        vorq: { state: 3, ended_because: 5 },
      });
    });

    it("reads reclaim as a failure, and a plain cancellation as a cancellation", async () => {
      await seedJob({ job_id: JOB.failed, state: 3, ended_because: 4 });
      expect(await statusOf(JOB.failed)).toBe("failed");
    });

    it("resolves the model name and echoes the chain terms", async () => {
      await db.query("INSERT INTO models (model_id, name) VALUES (7, 'model-a')");
      await seedJob({ job_id: JOB.claimed, state: 1, provider_id: 9, claimed_at: 1_700_000_000 });

      const res = await get(`/v1/jobs/${hex(JOB.claimed)}`);

      expect(res.json()).toEqual({
        id: hex(JOB.claimed),
        object: "job",
        model: "model-a",
        status: "in_progress",
        in_progress_at: 1700000000,
        result_cid: null,
        vorq: {
          job_id: hex(JOB.claimed),
          owner: hex(OWNER),
          model_id: 7,
          sla_secs: 3600,
          rate_in: "0.03",
          rate_out: "0.09",
          units_in: 1000,
          units_out: 2000,
          designated: 0,
          provider_id: 9,
          expires_at: Number(FAR_FUTURE),
          task_cid: "bafkreitaskcid",
          completion_tok: 0,
          state: 1,
          ended_because: 0,
          gas_fee: "0.03",
          fee: "0",
        },
        as_of_block: 4242,
      });
    });

    it("serves a job whose model has never been registered", async () => {
      await seedJob({ job_id: JOB.open, model_id: 404 });
      expect((await get(`/v1/jobs/${hex(JOB.open)}`)).json().model).toBeNull();
    });

    it("404s an unknown id", async () => {
      expect((await get(`/v1/jobs/0x${"09".repeat(32)}`)).statusCode).toBe(404);
    });

    /**
     * A miss used to reconcile against `getJob`, so every random id cost two RPC
     * round trips. Both post doors now write the row from their receipt, and a
     * miss is answered from the projection alone — with a chain wired in.
     */
    it("answers a miss on either detail route without a single chain request", async () => {
      const nodeConfig = config({ blockTimeMs: 60_000 });
      const stub = stubChain(nodeConfig);
      const withChain = buildApp({
        db,
        indexer: stubIndexer(async () => ready(4242n)),
        config: nodeConfig,
        chain: stub.chain,
      });
      try {
        const unknown = `0x${"09".repeat(32)}`;
        expect((await withChain.inject({ method: "GET", url: `/v1/jobs/${unknown}` })).statusCode).toBe(404);
        expect((await withChain.inject({ method: "GET", url: `/evm/jobs/${unknown}` })).statusCode).toBe(404);
        expect(stub.requests).toEqual([]);
      } finally {
        await withChain.close();
      }
    });
  });

  describe("GET /evm/providers", () => {
    // R12: every input of the formula is load-bearing, and the test says so —
    // drop `reputation`, drop either capacity, or drop the floor, and a row here
    // changes. `capacity = GREATEST(1, reputation * LEAST(requested, ceiling) / 1000)`.
    const CAPACITY_CASES = [
      { reputation: 750, ceiling: 8, requested: 4, capacity: 3 },
      { reputation: 250, ceiling: 8, requested: 4, capacity: 1 },
      { reputation: 1000, ceiling: 2, requested: 9, capacity: 2 },
      { reputation: 1000, ceiling: 9, requested: 2, capacity: 2 },
      { reputation: 1000, ceiling: 9, requested: 8, capacity: 8 },
      { reputation: 100, ceiling: 0, requested: 0, capacity: 1 },
    ];

    it.each(CAPACITY_CASES)(
      "computes capacity $capacity from reputation $reputation, ceiling $ceiling, requested $requested",
      async ({ reputation, ceiling, requested, capacity }) => {
        await seedProvider({
          provider_id: 1,
          reputation,
          capacity_ceiling: ceiling,
          capacity_requested: requested,
        });

        const res = await get("/evm/providers/1");
        expect(res.json().capacity).toBe(capacity);
      },
    );

    it("counts only claimed jobs as active", async () => {
      await seedProvider({ provider_id: 1 });
      await seedJob({ job_id: JOB.claimed, state: 1, provider_id: 1 });
      await seedJob({ job_id: JOB.settled, state: 2, ended_because: 1, provider_id: 1 });
      await seedJob({ job_id: JOB.open, state: 1, provider_id: 2 });

      expect((await get("/evm/providers/1")).json().active_jobs).toBe(1);
    });

    it("serves the public record, with evidence unparsed and ids as integers", async () => {
      await seedProvider({
        provider_id: 4_294_967_295n,
        operator: bytes(0xcc, 20),
        box_key: bytes(0xdd),
        reputation: 600,
        capacity_ceiling: 10,
        capacity_requested: 5,
        listed: false,
        allow_all_models: false,
        allowed_models: [1, 4_294_967_295n],
        evidence: { raw: "0xdeadbeef" },
      });

      const res = await get("/evm/providers");

      expect(res.json()).toEqual({
        providers: [
          {
            provider_id: 4294967295,
            operator: hex(bytes(0xcc, 20)),
            box_key: hex(bytes(0xdd)),
            evidence: { raw: "0xdeadbeef" },
            listed: false,
            reputation: 600,
            allow_all_models: false,
            allowed_models: [1, 4294967295],
            capacity: 3,
            active_jobs: 0,
          },
        ],
        as_of_block: 4242,
      });
    });

    it("passes a jsonb number through as stored, without rounding it (R51)", async () => {
      // The driver parses jsonb into JS, where a number is a double: this value
      // comes back as 12345678901234567000 and nothing downstream can tell.
      await db.query(
        "INSERT INTO providers (provider_id, operator, evidence) VALUES (1, $1, $2::jsonb)",
        [bytes(0xcc, 20), '{"n": 12345678901234567890}'],
      );

      const res = await get("/evm/providers/1");

      expect(res.body).toContain("12345678901234567890");
      expect(res.body).not.toContain("12345678901234567000");
    });

    it("reports a provider with no identity as null, not as absent", async () => {
      await seedProvider({ provider_id: 1 });
      expect((await get("/evm/providers/1")).json()).toMatchObject({
        box_key: null,
        evidence: null,
      });
    });

    it("404s an unknown provider and 400s a malformed id", async () => {
      expect((await get("/evm/providers/12")).statusCode).toBe(404);
      expect((await get("/evm/providers/-1")).statusCode).toBe(400);
    });
  });

  describe("GET /evm/allowlist", () => {
    it("keeps revoked entries as tombstones with status 2", async () => {
      // An entry is never deleted on chain — revocation is a status flip — so a
      // client can tell "revoked" from "never listed".
      await db.query("INSERT INTO allowlist (key, status, entry) VALUES ($1, 1, $2::jsonb)", [
        bytes(0x01),
        '{"image":"a"}',
      ]);
      await db.query("INSERT INTO allowlist (key, status, entry) VALUES ($1, 2, $2::jsonb)", [
        bytes(0x02),
        '{"image":"b"}',
      ]);

      const res = await get("/evm/allowlist");

      expect(res.json()).toEqual({
        entries: [
          { key: hex(bytes(0x01)), status: 1, entry: { image: "a" } },
          { key: hex(bytes(0x02)), status: 2, entry: { image: "b" } },
        ],
        as_of_block: 4242,
      });
    });

    it("carries no signature: the chain is the authority", async () => {
      const body = (await get("/evm/allowlist")).json();
      expect(body).not.toHaveProperty("signature");
      expect(body).not.toHaveProperty("signer");
    });
  });

  describe("model catalog", () => {
    beforeEach(async () => {
      await db.query("INSERT INTO models (model_id, name) VALUES (7, 'model-a')");
      await db.query("INSERT INTO models (model_id, name, enabled) VALUES (8, 'model-b', FALSE)");
    });

    it("keeps the emulator's OpenAI shape on /v1/models (R27), enabled models only", async () => {
      const res = await get("/v1/models");

      expect(res.json()).toEqual({
        object: "list",
        data: [
          { id: "model-a", object: "model", owned_by: "vorq", vorq: { model_id: 7, enabled: true } },
        ],
        as_of_block: 4242,
      });
    });

    it("serves the whole catalog on /evm/models, disabled models included", async () => {
      const res = await get("/evm/models");

      expect(res.json()).toEqual({
        object: "list",
        data: [
          { id: "model-a", object: "model", owned_by: "vorq", vorq: { model_id: 7, enabled: true } },
          { id: "model-b", object: "model", owned_by: "vorq", vorq: { model_id: 8, enabled: false } },
        ],
        as_of_block: 4242,
      });
    });

    it("pages /v1/models over enabled rows, so a disabled one costs no slot", async () => {
      await db.query("INSERT INTO models (model_id, name) VALUES (9, 'model-c')");

      const res = await get("/v1/models?limit=1&offset=1");

      expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(["model-c"]);
    });

    it("retrieves one model by name, the OpenAI way", async () => {
      // `client.models.retrieve(...)` is an ordinary call on every OpenAI client, and
      // without this route it answers 404 — the list is served, the singular is not.
      // The id is the model **name**, which is what `/v1/models` puts in `id`.
      const res = await get("/v1/models/model-a");

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: "model-a",
        object: "model",
        owned_by: "vorq",
        vorq: { model_id: 7, enabled: true },
        as_of_block: 4242,
      });
    });

    it("serves a disabled model rather than hiding it", async () => {
      // Retired, not absent: a client holding the name needs to learn that it is disabled,
      // and a 404 says only that the name is unknown.
      const res = await get("/v1/models/model-b");
      expect(res.statusCode).toBe(200);
      expect(res.json().vorq).toEqual({ model_id: 8, enabled: false });
    });

    it("404s a name the catalog does not carry", async () => {
      const res = await get("/v1/models/nope");
      expect(res.statusCode).toBe(404);
    });

    it("does not mistake a slashed name for a nested route", async () => {
      // Model names are org-qualified (`org/model:fp8`), so the path segment contains a
      // slash. A route matching one segment would 404 every real name.
      await db.query("INSERT INTO models (model_id, name) VALUES (9, 'org/model-c:fp8')");
      const res = await get(`/v1/models/${encodeURIComponent("org/model-c:fp8")}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe("org/model-c:fp8");
    });
  });

  it("stamps every index-backed response with as_of_block", async () => {
    await seedJob({ job_id: JOB.open });
    await seedProvider({ provider_id: 1 });

    for (const url of [
      "/evm/jobs",
      `/evm/jobs/${hex(JOB.open)}`,
      `/v1/jobs/${hex(JOB.open)}`,
      "/evm/providers",
      "/evm/providers/1",
      "/evm/allowlist",
      "/evm/models",
      "/v1/models",
    ]) {
      expect((await get(url)).json().as_of_block, url).toBe(4242);
    }
  });
});
