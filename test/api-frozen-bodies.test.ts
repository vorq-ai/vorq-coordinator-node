import type { FastifyInstance } from "fastify";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { PAGE_MAX_BYTES } from "../src/api/paging.js";
import { rawJson, toJsonText } from "../src/api/serialize.js";
import type { Addresses, Config } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";

/**
 * Two guards that had no test, written **before** `app.ts` was split into
 * `src/api/routes/*.ts` so they protect the move rather than describe its result.
 *
 *   * **R63.** Nothing asserted the exact shape of an `/evm/jobs` **list**
 *     element, nor `param: "id"` on a malformed `/v1/jobs/{id}`. Both bodies are
 *     supposed to be frozen; only the *detail* route actually was, so a refactor
 *     could have dropped or renamed a field of a list element and every existing
 *     test would still have passed (`api-reads.test.ts` reads the listing through
 *     `.map(j => j.job_id)` and a length).
 *   * **R60.** `budgeted()` summed **row** bytes and charged nothing for the
 *     commas between them or for the envelope around them, so the emitted body
 *     could exceed `PAGE_MAX_BYTES` — measured 1 032 bytes over at a forced
 *     boundary. `api-paging.test.ts` already asserts
 *     `byteLength(body) <= PAGE_MAX_BYTES`, which was stronger than the code
 *     guaranteed and passed only because its fixture sits off the boundary. The
 *     test below sits *on* the boundary, which is where the assertion has teeth.
 *
 * Kept out of `api-reads.test.ts` and `api-paging.test.ts` deliberately: those
 * two are the frozen-behaviour evidence for the split and were not touched.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_frozen_test";

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
  status: async (): Promise<IndexerStatus> => ({ cursor: 4242n, head: 4242n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

const bytes = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);
const hex = (buffer: Buffer): string => `0x${buffer.toString("hex")}`;

describe.skipIf(!TEST_DATABASE_URL)("frozen bodies and the page byte budget", () => {
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
    for (const table of ["jobs", "allowlist", "cursor"]) await db.query(`DELETE FROM ${table}`);
    await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 4242, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')");
  });

  // -------------------------------------------------------------------------
  // R63
  // -------------------------------------------------------------------------

  it("freezes the exact shape of an /evm/jobs list element", async () => {
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, state, ended_because, provider_id,
                         claimed_at, completion_tok, task_cid, result_cid, posted_block, as_of_block,
                         gas_fee, fee)
       VALUES ($1,$2,$3,7,3600,0,'30000','90000',1000,2000,4102444800,2,1,9,
               1700000000,4294967295,$4,$5,11,12,'30000','2500')`,
      [
        bytes(0x04),
        bytes(0xaa, 20),
        bytes(0xbb),
        Buffer.from("bafkreitaskcid", "utf8"),
        Buffer.from("bafkreiresultcid", "utf8"),
      ],
    );

    const res = await get("/evm/jobs");

    expect(res.statusCode).toBe(200);
    // Exact equality on the element, not just on `job_id`. `as_of_block` belongs
    // to the envelope and must NOT be repeated per row.
    expect(res.json()).toEqual({
      jobs: [
        {
          job_id: hex(bytes(0x04)),
          owner: hex(bytes(0xaa, 20)),
          c: hex(bytes(0xbb)),
          model_id: 7,
          sla_secs: 3600,
          designated: 0,
          rate_in: "0.03",
          rate_out: "0.09",
          units_in: 1000,
          units_out: 2000,
          expires_at: 4102444800,
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
        },
      ],
      as_of_block: 4242,
    });
  });

  it("names the parameter the caller actually sent on a malformed /v1/jobs/{id}", async () => {
    const res = await get("/v1/jobs/not-a-job-id");

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        message: "id must be a 0x-prefixed hex string of the right length",
        type: "invalid_request_error",
        param: "id",
        code: null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // R60
  // -------------------------------------------------------------------------

  describe("the page byte budget, at the boundary", () => {
    // One row is built to weigh exactly `PAGE_MAX_BYTES / limit` bytes, so
    // `limit` rows sum to just **under** the budget and a row-only accounting
    // admits every one of them. What then puts the body over the line is the
    // 999 commas between the rows and the envelope around them — the bytes the
    // old accounting charged to nobody.
    const LIMIT = 1000;
    const ROW_BYTES = Math.floor(PAGE_MAX_BYTES / LIMIT); // 4194

    /** The wire shape `/evm/allowlist` builds, measured through the real serializer. */
    const wireSize = (entry: string): number =>
      Buffer.byteLength(toJsonText({ key: bytes(0x01), status: 1, entry: rawJson(entry) }));

    /**
     * A jsonb **string**, not an object: Postgres re-prints a jsonb object with a
     * space after every `:` and `,`, so an object's stored text would not be the
     * text this test sized. A string round-trips byte for byte.
     */
    const padded = (length: number): string => `"${"x".repeat(length)}"`;

    it("keeps the emitted body inside PAGE_MAX_BYTES when the rows sum to just under it", async () => {
      // Solve for the pad length rather than asserting a hand-computed one: the
      // relationship is exactly one byte of wire per byte of pad.
      const probe = 1000;
      const pad = probe + (ROW_BYTES - wireSize(padded(probe)));
      const entry = padded(pad);
      expect(wireSize(entry)).toBe(ROW_BYTES);

      const values: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < LIMIT; i++) {
        const key = Buffer.alloc(32);
        key.writeUInt32BE(i, 28);
        params.push(key, entry);
        values.push(`($${params.length - 1}, 1, $${params.length}::jsonb)`);
      }
      await db.query(`INSERT INTO allowlist (key, status, entry) VALUES ${values.join(",")}`, params);

      // Every row would fit if only rows were counted: 1000 × 4194 = 4 194 000
      // against a 4 194 304 budget, 304 bytes of headroom.
      expect(LIMIT * ROW_BYTES).toBeLessThan(PAGE_MAX_BYTES);

      const res = await get(`/evm/allowlist?limit=${LIMIT}`);

      expect(res.statusCode).toBe(200);
      // The assertion `api-paging.test.ts` already makes — here it is load-bearing.
      expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
      // And the page has to say it stopped early, or a client reads 999 of 1000
      // and believes it is done (R58, R61).
      expect(res.headers["x-vorq-page-truncated"]).toBe("true");
      expect(res.headers["x-vorq-next-offset"]).toBe(String(res.json().entries.length));
      expect(res.json().entries.length).toBeLessThan(LIMIT);
    });

    it("charges the envelope too: rows plus commas landing exactly on the budget still fit", async () => {
      // The test above pins **half** of R60. Uniform rows are too coarse to
      // reach the boundary: 1000 × 4194 + 999 commas overshoots by 999 bytes
      // whatever the envelope does, so deleting `let bytes = PAGE_ENVELOPE_BYTES`
      // leaves it green while a real body goes 35 B over the budget.
      //
      // Mixed sizes can land on it exactly. These rows sum, **with their
      // commas**, to precisely `PAGE_MAX_BYTES` — so a row-and-comma accounting
      // admits all 1000 (nothing ever exceeds the budget) and emits a body over
      // it by the whole envelope. Only the seed makes the last row not fit.
      const smallBytes = Math.floor((PAGE_MAX_BYTES - (LIMIT - 1)) / LIMIT);
      const bigCount = PAGE_MAX_BYTES - (LIMIT - 1) - smallBytes * LIMIT;
      const smallCount = LIMIT - bigCount;
      const sizes = [
        ...Array.from({ length: smallCount }, () => smallBytes),
        ...Array.from({ length: bigCount }, () => smallBytes + 1),
      ];
      // 695 × 4193 + 305 × 4194 + 999 commas = 4 194 304, on the nose.
      expect(sizes.reduce((sum, size) => sum + size, 0) + (LIMIT - 1)).toBe(PAGE_MAX_BYTES);

      const entryOf = (size: number): string => {
        const probe = 1000;
        return padded(probe + (size - wireSize(padded(probe))));
      };
      expect(wireSize(entryOf(smallBytes))).toBe(smallBytes);

      const values: string[] = [];
      const params: unknown[] = [];
      sizes.forEach((size, i) => {
        const key = Buffer.alloc(32);
        key.writeUInt32BE(i, 28);
        params.push(key, entryOf(size));
        values.push(`($${params.length - 1}, 1, $${params.length}::jsonb)`);
      });
      await db.query(`INSERT INTO allowlist (key, status, entry) VALUES ${values.join(",")}`, params);

      const res = await get(`/evm/allowlist?limit=${LIMIT}`);

      expect(res.statusCode).toBe(200);
      // The whole point: the body, not the rows, is what the budget bounds.
      expect(Buffer.byteLength(res.body)).toBeLessThanOrEqual(PAGE_MAX_BYTES);
      expect(res.json().entries.length).toBeLessThan(LIMIT);
      expect(res.headers["x-vorq-page-truncated"]).toBe("true");
    });
  });
});
