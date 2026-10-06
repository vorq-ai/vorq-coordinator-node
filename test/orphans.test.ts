import type { FastifyInstance } from "fastify";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Addresses, Config, EscrowMode } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import { orphanBookFilter, orphanFilterApplies } from "../src/escrow/orphans.js";
import type { KeyEpochStart } from "../src/escrow/release.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";

/**
 * Task 6 — the escrow-orphan **book filter**.
 *
 * A job whose `Posted` predates this node's custody of its key material can only
 * carry a wrap naming a key this node no longer holds. Advertising it as claimable
 * costs a provider a claim it can only escape through `fail`, so the book stops
 * advertising it. The chain rows are untouched: this is not a delete, and the
 * detail routes still serve every one of them.
 *
 * The database half takes R25/P16's gate — `npm test` must run with no Postgres:
 *
 *     docker compose -f compose.dev.yml up -d
 *     TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm run test:ci
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_orphans_test";

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

function config(mode: EscrowMode): Config {
  return {
    rpcUrl: "http://localhost:8545",
    getLogsCap: 5000,
    dbUrl: TEST_DATABASE_URL ?? "postgres://unused",
    relayerKey: DUMMY_KEY,
    blockTimeMs: 60_000,
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
    match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
    jobRateLimit: 0,
    escrow: {
      mode,
      releaseOrdinal: 1,
      sweepIntervalMs: 300_000,
      peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [],
      clockOffsetMs: 0,
    },
    addresses: ADDRESSES,
  };
}

const ready = (cursor: bigint): IndexerStatus => ({
  cursor,
  head: cursor,
  ready: true,
  forked: null,
});

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async () => ready(4242n),
  start: async () => undefined,
  stop: async () => undefined,
});

const bytes = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);
const hex = (buffer: Buffer): string => `0x${buffer.toString("hex")}`;

/** One id per fixture, so a listing's contents can be named rather than counted. */
const JOB = {
  /** Open, undesignated, posted before the epoch — the orphan. */
  orphan: bytes(0x01),
  /** Open, undesignated, posted after it. */
  fresh: bytes(0x02),
  /** Open, **designated**, posted before it — escrow was never in its path. */
  designated: bytes(0x03),
  /** Open, undesignated, `posted_block = 0` — unknown, never ancient (I9). */
  unknown: bytes(0x04),
  /** Open, undesignated, posted in the epoch block itself — the boundary. */
  boundary: bytes(0x05),
  /** Claimed, undesignated, posted before the epoch — no longer advertised anyway. */
  claimed: bytes(0x06),
  /** Open-but-expired, undesignated, posted before the epoch. */
  expired: bytes(0x07),
};

const OWNER = bytes(0xaa, 20);
const FAR_FUTURE = 4_102_444_800n;
const LONG_PAST = 1_000_000_000n;

/** The head when this node's custody began. */
const EPOCH: KeyEpochStart = { time: 1_760_000_000_000, block: 100n };

// ---------------------------------------------------------------------------
// The predicate itself. No database: these run in every `npm test`.
// ---------------------------------------------------------------------------

describe("orphanBookFilter", () => {
  /** A binder that records what the clause would send to Postgres. */
  function binder(): { bind: (value: unknown) => string; params: unknown[] } {
    const params: unknown[] = [];
    return { bind: (value) => `$${params.push(value)}`, params };
  }

  const OPEN = "state = 0 AND expires_at >= now";

  it("is inactive when the escrow is off, whatever the epoch says", () => {
    // `keyEpochStart` does not exist in local mode, and a local node must not
    // hide jobs.
    expect(orphanFilterApplies("off", EPOCH)).toBe(false);
    expect(orphanBookFilter("off", EPOCH, OPEN, binder().bind)).toBeNull();
  });

  it("is inactive when custody start is unknown", () => {
    expect(orphanFilterApplies("mock", null)).toBe(false);
    expect(orphanBookFilter("mock", null, OPEN, binder().bind)).toBeNull();
  });

  it("is active only with an escrow and an epoch", () => {
    expect(orphanFilterApplies("mock", EPOCH)).toBe(true);
  });

  it("binds the epoch block as a parameter and never as text", () => {
    const { bind, params } = binder();
    const sql = orphanBookFilter("mock", EPOCH, OPEN, bind);

    expect(params).toEqual([100n]);
    expect(sql).toContain("$1");
    expect(sql).not.toContain("100");
  });

  it("carries every clause the filter's correctness rests on", () => {
    const sql = orphanBookFilter("mock", EPOCH, OPEN, binder().bind) as string;

    // Openness comes from the caller, so the book and this clause cannot drift.
    expect(sql).toContain(OPEN);
    // Escrow was never in a designated job's path.
    expect(sql).toContain("designated = 0");
    // I9: `posted_block = 0` is unknown, never ancient.
    expect(sql).toContain("posted_block > 0");
    // Strictly before: a job posted in the epoch block itself is served.
    expect(sql).toContain("posted_block < $1");
    // A suppression, not a selection: the whole conjunction is negated.
    expect(sql.startsWith("NOT (")).toBe(true);
  });
});

describe("the orphan book filter at mode static", () => {
  /**
   * A derived key set survives a restart, so there is no custody boundary and
   * nothing to filter. This is the property the whole mode rests on: with a boot
   * epoch instead, every open job posted before the last redeploy would stop
   * being advertised.
   */
  it("does not apply, because a static node has no epoch", () => {
    expect(orphanFilterApplies("static" as EscrowMode, null)).toBe(false);
  });

  it("produces no clause, so the book advertises jobs posted before this process", () => {
    expect(
      orphanBookFilter("static" as EscrowMode, null, "expires_at >= 0", () => "$1"),
    ).toBeNull();
  });

  it("still applies at mode mock with an epoch, which is the premise", () => {
    const epoch: KeyEpochStart = { time: 1_700_000_000_000, block: 500n };
    expect(orphanFilterApplies("mock" as EscrowMode, epoch)).toBe(true);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("the escrow-orphan book filter", () => {
  let db: Db;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  /** Mutable so one built app can answer both "custody known" and "not known". */
  let epoch: KeyEpochStart | null = EPOCH;

  async function seedJob(overrides: Record<string, unknown> = {}): Promise<void> {
    const row: Record<string, unknown> = {
      job_id: JOB.orphan,
      owner: OWNER,
      c: bytes(0xbb),
      model_id: 7,
      sla_secs: 3600,
      designated: 0,
      rate_in: "30000",
      rate_out: "90000",
      units_in: 1000,
      units_out: 2000,
      expires_at: FAR_FUTURE,
      task_cid: Buffer.from("bafkreitaskcid", "utf8"),
      posted_block: 11,
      as_of_block: 4242,
      gas_fee: "30000",
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO jobs (${columns.join(", ")}) VALUES (` +
        `${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      Object.values(row),
    );
  }

  /** The whole fixture set, one row per case, seeded once per test. */
  async function seedBook(): Promise<void> {
    await seedJob({ job_id: JOB.orphan, posted_block: 11 });
    await seedJob({ job_id: JOB.fresh, posted_block: 150 });
    await seedJob({ job_id: JOB.designated, posted_block: 11, designated: 42 });
    await seedJob({ job_id: JOB.unknown, posted_block: 0 });
    await seedJob({ job_id: JOB.boundary, posted_block: 100 });
    await seedJob({ job_id: JOB.claimed, posted_block: 11, state: 1, provider_id: 9 });
    await seedJob({ job_id: JOB.expired, posted_block: 11, expires_at: LONG_PAST });
  }

  const ids = (res: { json: () => { jobs: { job_id: string }[] } }): string[] =>
    res.json().jobs.map((job) => job.job_id);

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    app = buildApp({
      db,
      indexer: stubIndexer(),
      config: config("mock"),
      escrowKeyEpochStart: () => epoch,
    });
    // The same projection, the same epoch, and the escrow off: a local node must
    // not hide jobs, because `keyEpochStart` does not exist for it at all.
    offApp = buildApp({
      db,
      indexer: stubIndexer(),
      config: config("off"),
      escrowKeyEpochStart: () => epoch,
    });
  });

  afterAll(async () => {
    await app?.close();
    await offApp?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    epoch = EPOCH;
    for (const table of ["jobs", "asks_chain", "providers", "cursor"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    await db.query(
      "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') " +
        "ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number",
      [4242n],
    );
  });

  it("serves the job posted after the epoch and drops the one posted before it", async () => {
    await seedJob({ job_id: JOB.orphan, posted_block: 11 });
    await seedJob({ job_id: JOB.fresh, posted_block: 150 });

    const res = await app.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(res.statusCode).toBe(200);
    expect(ids(res)).toEqual([hex(JOB.fresh)]);
  });

  it("does not filter a designated job posted before the epoch", async () => {
    // Escrow was never in its path: the wrap was sealed to the provider's own
    // key and this node never held it. "Lost" would be false about a key that
    // was never ours.
    await seedJob({ job_id: JOB.designated, posted_block: 11, designated: 42 });

    const res = await app.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(ids(res)).toEqual([hex(JOB.designated)]);
  });

  it("serves `posted_block = 0`, which means unknown and never ancient (I9)", async () => {
    // `reconcileJob` upserts from `getJob`, which carries no posting block, so a
    // row inserted ahead of its indexed log lands at the column default. That
    // fires on exactly the hot path for a freshly posted job — a client polling
    // right after its `201` — and reading the 0 as a block number would hide
    // every such job from the book forever.
    await seedJob({ job_id: JOB.unknown, posted_block: 0 });

    const res = await app.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(ids(res)).toEqual([hex(JOB.unknown)]);
  });

  it("serves a job posted in the epoch block itself: the comparison is strict", async () => {
    await seedJob({ job_id: JOB.boundary, posted_block: 100 });

    const res = await app.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(ids(res)).toEqual([hex(JOB.boundary)]);
  });

  it("filters only what it advertises: claimed and expired orphans still list", async () => {
    await seedBook();

    const claimed = await app.inject({ method: "GET", url: "/evm/jobs?state=Claimed" });
    expect(ids(claimed)).toEqual([hex(JOB.claimed)]);

    // Expired rows leave Open and reappear under Cancelled; the filter has
    // nothing to say about a job nobody can claim.
    const cancelled = await app.inject({ method: "GET", url: "/evm/jobs?state=Cancelled" });
    expect(ids(cancelled)).toEqual([hex(JOB.expired)]);
  });

  it("applies to the unfiltered listing too, not only to `state=Open`", async () => {
    await seedBook();

    const res = await app.inject({ method: "GET", url: "/evm/jobs" });

    // Everything but the orphan, whatever its state.
    expect(ids(res).sort()).toEqual(
      [JOB.fresh, JOB.designated, JOB.unknown, JOB.boundary, JOB.claimed, JOB.expired]
        .map(hex)
        .sort(),
    );
  });

  it("survives the other query filters rather than being replaced by them", async () => {
    await seedBook();

    const byModel = await app.inject({ method: "GET", url: "/evm/jobs?state=Open&model=7" });
    expect(ids(byModel)).not.toContain(hex(JOB.orphan));

    const byOwner = await app.inject({
      method: "GET",
      url: `/evm/jobs?state=Open&owner=${hex(OWNER)}`,
    });
    expect(ids(byOwner)).not.toContain(hex(JOB.orphan));
  });

  it("a dropped job is not a deleted job: the row stands and the detail routes serve it", async () => {
    await seedJob({ job_id: JOB.orphan, posted_block: 11 });

    const evm = await app.inject({ method: "GET", url: `/evm/jobs/${hex(JOB.orphan)}` });
    expect(evm.statusCode).toBe(200);
    expect(evm.json().job_id).toBe(hex(JOB.orphan));

    const client = await app.inject({ method: "GET", url: `/v1/jobs/${hex(JOB.orphan)}` });
    expect(client.statusCode).toBe(200);
    expect(client.json().status).toBe("queued");

    const stored = await db.query<{ count: bigint }>("SELECT count(*) AS count FROM jobs");
    expect(stored.rows[0]?.count).toBe(1n);
  });

  it("hides nothing when the escrow is off", async () => {
    await seedJob({ job_id: JOB.orphan, posted_block: 11 });
    await seedJob({ job_id: JOB.fresh, posted_block: 150 });

    const res = await offApp.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(ids(res).sort()).toEqual([hex(JOB.orphan), hex(JOB.fresh)].sort());
  });

  it("hides nothing when custody start is unknown", async () => {
    // A node that cannot say when its keys began must never claim a job predates
    // them — absent is no information, never zero.
    epoch = null;
    await seedJob({ job_id: JOB.orphan, posted_block: 11 });

    const res = await app.inject({ method: "GET", url: "/evm/jobs?state=Open" });

    expect(ids(res)).toEqual([hex(JOB.orphan)]);
  });

  it("never filters asks: they are price-quote rows with no job columns", async () => {
    await db.query("INSERT INTO providers (provider_id, operator) VALUES (1, $1)", [
      bytes(0xcc, 20),
    ]);
    await db.query(
      "INSERT INTO asks_chain (provider_id, model_id, sla, rate_in, rate_out) " +
        "VALUES (1, 7, 3600, '30000', '90000')",
    );

    const res = await app.inject({ method: "GET", url: "/evm/asks" });

    expect(res.statusCode).toBe(200);
    expect(res.json().asks).toHaveLength(1);
  });
});
