import type { FastifyInstance } from "fastify";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Addresses, Config } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";

/**
 * Paging on the unauthenticated listings (R56).
 *
 * Kept out of `api-reads.test.ts` so that file stays exactly as the response
 * shapes were frozen: paging adds query parameters, never response fields, and
 * the reads suite asserts those bodies with exact equality.
 *
 * The bound matters because the row count is the caller's to choose — anyone can
 * register a provider or post a job — and an unbounded listing is the same
 * failure mode as an unbounded `uint32`: a value the chain does not bound
 * reaching a limit the node does not bound.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_paging_test";

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

const config = (): Config => ({
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
  // Plan 3's escrow, off: the shipped default, and nothing here touches it.
  escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 },
  match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
  jobRateLimit: 0,
  addresses: ADDRESSES,
});

const readyIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 7n, head: 7n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

// ---------------------------------------------------------------------------
// Validation, which never reaches the database
// ---------------------------------------------------------------------------

describe("paging parameters", () => {
  let app: FastifyInstance;

  // `paging()` runs before the first query on every listing, so a rejected page
  // is answered without a connection — which is what this database proves.
  const refusingDb = (): Db => ({
    query: () => Promise.reject(new Error("a rejected page must not reach the database")),
    tx: () => Promise.reject(new Error("a rejected page must not reach the database")),
    migrate: () => Promise.reject(new Error("a rejected page must not reach the database")),
    close: async () => undefined,
  });

  beforeAll(() => {
    app = buildApp({ db: refusingDb(), indexer: readyIndexer(), config: config() });
  });

  afterAll(async () => {
    await app?.close();
  });

  const LISTINGS = ["/evm/jobs", "/evm/providers", "/evm/allowlist", "/evm/models", "/v1/models"];

  const REJECTED = [
    { query: "limit=0", param: "limit" },
    { query: "limit=1001", param: "limit" },
    { query: "limit=-1", param: "limit" },
    { query: "limit=abc", param: "limit" },
    { query: "limit=1e3", param: "limit" },
    { query: "offset=-1", param: "offset" },
    { query: "offset=1000001", param: "offset" },
    { query: "offset=99999999999999999999", param: "offset" },
  ];

  it.each(REJECTED)("400s $query on every listing", async ({ query, param }) => {
    for (const url of LISTINGS) {
      const res = await app.inject({ method: "GET", url: `${url}?${query}` });
      expect(res.statusCode, `${url}?${query}`).toBe(400);
      expect(res.json().error, `${url}?${query}`).toMatchObject({
        type: "invalid_request_error",
        param,
      });
      expect(res.headers["x-vorq-retryable"], `${url}?${query}`).toBe("false");
    }
  });
});

// ---------------------------------------------------------------------------
// The bound itself
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("paging over a seeded projection", () => {
  let db: Db;
  let app: FastifyInstance;

  const get = (url: string) => app.inject({ method: "GET", url });

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    app = buildApp({ db, indexer: readyIndexer(), config: config() });
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM providers");
    await db.query("DELETE FROM models");
    await db.query("DELETE FROM allowlist");
    await db.query(
      "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 7, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') " +
        "ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number",
    );
  });

  /** 150 providers: more than the default page, fewer than the maximum. */
  async function seedProviders(count: number): Promise<void> {
    await db.query(
      "INSERT INTO providers (provider_id, operator) " +
        "SELECT i, decode(lpad(to_hex(i), 40, '0'), 'hex') FROM generate_series(1, $1) AS i",
      [count],
    );
  }

  const ids = (body: { providers: { provider_id: number }[] }): number[] =>
    body.providers.map((provider) => provider.provider_id);

  it("caps an unbounded listing at the default page rather than serving everything", async () => {
    await seedProviders(150);

    const res = await get("/evm/providers");

    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toHaveLength(100);
    // The first page, in the listing's documented total order — not an arbitrary
    // 100 of the 150.
    expect(ids(res.json())[0]).toBe(1);
    expect(ids(res.json())[99]).toBe(100);
  });

  it("pages with limit and offset, and a short page is the last page", async () => {
    await seedProviders(150);

    expect(ids((await get("/evm/providers?limit=100&offset=0")).json())).toHaveLength(100);

    const second = await get("/evm/providers?limit=100&offset=100");
    expect(ids(second.json())).toHaveLength(50);
    expect(ids(second.json())[0]).toBe(101);
  });

  it("never serves more than the maximum, whatever is asked for", async () => {
    await seedProviders(1200);

    const asked = await get("/evm/providers?limit=1000");
    expect(ids(asked.json())).toHaveLength(1000);

    // The cap is enforced by refusing, not by silently clamping: a client that
    // asked for 5000 and received 1000 would otherwise believe it had them all.
    const over = await get("/evm/providers?limit=5000");
    expect(over.statusCode).toBe(400);
  });

  it("still stamps a page with as_of_block", async () => {
    await seedProviders(150);
    expect((await get("/evm/providers?limit=1&offset=2")).json().as_of_block).toBe(7);
  });

  // -------------------------------------------------------------------------
  // The byte budget (R58)
  // -------------------------------------------------------------------------

  /**
   * The documented budget, restated here rather than imported: it is the
   * contract Plans 3 and 4 code against, and a test that imports the number it
   * is checking cannot notice the number changing.
   */
  const PAGE_MAX_BYTES = 4 * 1024 * 1024;

  /**
   * A `jsonb` value of roughly the size a provider can actually write.
   *
   * `evidence` is arbitrary bytes bounded by nothing but gas — R50a found
   * 32 730 bytes reachable for about 1 M gas — so this is the real adversarial
   * row, not a fixture scaled down until it is convenient. A budget test whose
   * values never approach the budget proves nothing.
   */
  const EVIDENCE_HEX_PAIRS = 16_000; // → a ~32 kB jsonb value
  const EVIDENCE_SQL = `('{"raw":"0x' || repeat('ab', ${EVIDENCE_HEX_PAIRS}) || '"}')::jsonb`;

  async function seedFatProviders(count: number): Promise<void> {
    await db.query(
      "INSERT INTO providers (provider_id, operator, evidence) " +
        `SELECT i, decode(lpad(to_hex(i), 40, '0'), 'hex'), ${EVIDENCE_SQL} ` +
        "FROM generate_series(1, $1) AS i",
      [count],
    );
  }

  it("ends a page on the byte budget, and says so in a header", async () => {
    // 200 rows of ~32 kB is ~6.4 MB — over the budget, and reachable by anyone
    // who can register 200 providers.
    await seedFatProviders(200);

    const res = await get("/evm/providers?limit=200");

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-vorq-page-truncated"]).toBe("true");

    const returned = res.json().providers.length;
    // Fewer than asked for — but still a page, not a trickle. A budget that
    // yielded a handful of rows would be a different kind of unusable.
    expect(returned).toBeLessThan(200);
    expect(returned).toBeGreaterThan(50);

    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    // The whole point of the header: `returned < limit` no longer means "end of
    // list", so the resume point has to be stated rather than inferred.
    expect(res.headers["x-vorq-next-offset"]).toBe(String(returned));
  });

  it("resumes exactly where a truncated page stopped, skipping and repeating nothing", async () => {
    await seedFatProviders(200);

    const first = await get("/evm/providers?limit=200");
    const resumeAt = Number(first.headers["x-vorq-next-offset"]);
    const firstIds = first.json().providers.map((p: { provider_id: number }) => p.provider_id);

    const second = await get(`/evm/providers?limit=200&offset=${resumeAt}`);
    const secondIds = second.json().providers.map((p: { provider_id: number }) => p.provider_id);

    expect(firstIds[firstIds.length - 1]).toBe(resumeAt);
    expect(secondIds[0]).toBe(resumeAt + 1);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
  });

  it("reports an untruncated page as untruncated, rather than by saying nothing", async () => {
    await seedProviders(10);

    const res = await get("/evm/providers?limit=200");

    expect(res.headers["x-vorq-page-truncated"]).toBe("false");
    expect(res.headers["x-vorq-next-offset"]).toBeUndefined();
    expect(res.json().providers).toHaveLength(10);
  });

  it("serves a single row larger than the whole budget, and lets a caller read past it", async () => {
    // 5 MB in one value: over the entire page budget by itself. Refusing it
    // would make this row permanently unreachable — and, because offset paging
    // cannot step over what it never returned, every row behind it too.
    await db.query(
      "INSERT INTO providers (provider_id, operator, evidence) VALUES " +
        `(1, decode('${"11".repeat(20)}', 'hex'), ('{"raw":"0x' || repeat('cd', 2500000) || '"}')::jsonb)`,
    );
    await db.query("INSERT INTO providers (provider_id, operator) VALUES (2, $1)", [
      Buffer.alloc(20, 0x22),
    ]);

    const first = await get("/evm/providers?limit=10");

    expect(first.statusCode).toBe(200);
    expect(first.json().providers).toHaveLength(1);
    expect(first.json().providers[0].provider_id).toBe(1);
    expect(Buffer.byteLength(first.body)).toBeGreaterThan(PAGE_MAX_BYTES);
    expect(first.headers["x-vorq-page-truncated"]).toBe("true");
    expect(first.headers["x-vorq-next-offset"]).toBe("1");

    const second = await get("/evm/providers?limit=10&offset=1");
    expect(second.json().providers.map((p: { provider_id: number }) => p.provider_id)).toEqual([
      2,
    ]);
    expect(second.headers["x-vorq-page-truncated"]).toBe("false");
  });

  it("budgets the allowlist too, where the same unbounded bytes live", async () => {
    await db.query(
      "INSERT INTO allowlist (key, status, entry) " +
        `SELECT decode(lpad(to_hex(i), 64, '0'), 'hex'), 1, ${EVIDENCE_SQL} ` +
        "FROM generate_series(1, 200) AS i",
    );

    const res = await get("/evm/allowlist?limit=200");

    expect(res.headers["x-vorq-page-truncated"]).toBe("true");
    expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
    expect(res.json().entries.length).toBeLessThan(200);
  });

  it("pages the model catalog, and both paths stay byte-identical", async () => {
    await db.query(
      "INSERT INTO models (model_id, name) SELECT i, 'model-' || i FROM generate_series(1, 150) AS i",
    );

    const evm = await get("/evm/models?limit=2&offset=1");
    const v1 = await get("/v1/models?limit=2&offset=1");

    expect(evm.body).toBe(v1.body);
    expect(evm.json().data.map((model: { id: string }) => model.id)).toEqual([
      "model-2",
      "model-3",
    ]);
  });
});
