import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { createSession } from "../src/api/sessions.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * `/v1/batches` — create, read, list, cancel.
 *
 * The shape is OpenAI's and the *sources* are not: everything a caller reads as
 * progress is folded over the member jobs at read time (`src/batches/fold.ts`),
 * and the row itself carries only what a fold cannot produce — the window, the
 * file ids, and the few stamps the worker owns. These tests are
 * mostly about that seam: seed jobs in a state, ask for the batch, and check the
 * answer came from the jobs rather than from a counter.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_batches_test";

const OWNER = Buffer.alloc(20, 0xc3);
const STRANGER = Buffer.alloc(20, 0xd4);
const CURSOR_BLOCK = 4242n;

/** Chain job states, as `0001_init.sql` numbers them. */
const OPEN = 0;
const CLAIMED = 1;
const SETTLED = 2;
const CANCELLED = 3;

function stubIndexer(): Indexer {
  const status = async (): Promise<IndexerStatus> => ({
    cursor: CURSOR_BLOCK,
    head: CURSOR_BLOCK,
    ready: true,
    forked: null,
  });
  return {
    coldStart: async () => undefined,
    poll: async () => undefined,
    status,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

describe.skipIf(!TEST_DATABASE_URL)("/v1/batches", () => {
  let db: Db;
  let app: FastifyInstance;
  let token: string;
  let strangerToken: string;

  const auth = (bearer = token) => ({ authorization: `Bearer ${bearer}` });

  const create = (body: Record<string, unknown>, bearer = token) =>
    app.inject({ method: "POST", url: "/v1/batches", headers: auth(bearer), payload: body });

  const get = (url: string, bearer = token) =>
    app.inject({ method: "GET", url, headers: auth(bearer) });

  /** A `files` row, standing in for an upload this suite does not need to perform. */
  async function seedFile(overrides: Record<string, unknown> = {}): Promise<string> {
    const fileId = `file-${randomBytes(12).toString("hex")}`;
    const row = {
      file_id: fileId,
      owner: OWNER,
      purpose: "batch",
      filename: "batch.jsonl",
      bytes: 4096,
      cid: "bafyinputfile",
      status: "uploaded",
      lines: 3,
      created_at: now(),
      // Attached: a batch names it, so it lives the retention window rather than
      // the 300 s an upload nobody claimed gets.
      expires_at: now() + 2_592_000n,
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO files (${columns.join(", ")}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`,
      Object.values(row),
    );
    return row.file_id as string;
  }

  /** One member job, and the `batch_lines` row that names it. */
  async function seedLine(
    batchId: string,
    lineNo: number,
    state: number | null,
    overrides: Record<string, unknown> = {},
  ): Promise<Buffer> {
    const jobId = randomBytes(32);
    if (state !== null) {
      await db.query(
        `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                           units_in, units_out, expires_at, state, task_cid, as_of_block,
                           gas_fee)
         VALUES ($1, $2, $3, 7, 3600, 0, 30000, 90000, 100, 200, $4, $5, $6, $7, 30000)`,
        [
          jobId,
          OWNER,
          randomBytes(32),
          overrides.expires_at ?? now() + 3600n,
          state,
          Buffer.from("bafkreitask", "utf8"),
          CURSOR_BLOCK,
        ],
      );
    }
    await db.query(
      "INSERT INTO batch_lines (batch_id, line_no, job_id, task_cid, skip_reason) VALUES ($1, $2, $3, $4, $5)",
      [
        batchId,
        lineNo,
        state === null ? null : jobId,
        state === null ? null : "bafkreitask",
        overrides.skip_reason ?? null,
      ],
    );
    return jobId;
  }

  /** A batch row already past `validating`, so the fold is what answers. */
  async function seedBatch(overrides: Record<string, unknown> = {}): Promise<string> {
    const batchId = `batch_${randomBytes(8).toString("hex")}`;
    const created = now();
    const row = {
      batch_id: batchId,
      owner: OWNER,
      endpoint: "/v1/responses",
      completion_window: 86400n,
      input_file_id: await seedFile(),
      status: "in_progress",
      created_at: created,
      expires_at: created + 86400n,
      in_progress_at: created,
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO batches (${columns.join(", ")}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`,
      Object.values(row),
    );
    return batchId;
  }

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    app = buildApp({ db, indexer: stubIndexer(), config: testConfig({ dbUrl: url }) });
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["batch_lines", "batches", "files", "jobs", "sessions"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    await db.query(
      "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') " +
        "ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number",
      [CURSOR_BLOCK],
    );
    token = (await createSession(db, OWNER, "client", null)).token;
    strangerToken = (await createSession(db, STRANGER, "client", null)).token;
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  describe("POST /v1/batches", () => {
    const body = async (over: Record<string, unknown> = {}) => ({
      input_file_id: await seedFile(),
      endpoint: "/v1/responses",
      completion_window: "24h",
      ...over,
    });

    it("answers a BatchObject that starts at validating with nothing counted", async () => {
      // `validating` is not decoration: at 50 000 lines the split, the pins and
      // the postMany run behind this answer, and a batch reporting `completed`
      // because zero of zero lines are terminal would be the alternative.
      const response = await create(await body());
      expect(response.statusCode).toBe(200);
      const created = response.json();
      expect(created.id).toMatch(/^batch_[0-9a-f]{24}$/);
      expect(created.object).toBe("batch");
      expect(created.status).toBe("validating");
      expect(created.request_counts).toEqual({ completed: 0, failed: 0, total: 0 });
      expect(created.output_file_id).toBeNull();
      expect(created.error_file_id).toBeNull();
      expect(created.errors).toBeNull();
    });

    it("stamps the expiry from the window the caller asked for", async () => {
      const created = (await create(await body({ completion_window: "1h" }))).json();
      expect(created.completion_window).toBe("1h");
      expect(created.expires_at - created.created_at).toBe(3600);
    });

    it("refuses a create with no session", async () => {
      expect((await create(await body(), "not-a-token")).statusCode).toBe(401);
    });

    it("accepts exactly the two endpoints this network serves", async () => {
      expect((await create(await body({ endpoint: "/v1/embeddings" }))).statusCode).toBe(200);
      // `/v1/chat/completions` is OpenAI's own batch endpoint and is deliberately
      // not one of ours: the client submits through `/v1/responses`.
      const refused = await create(await body({ endpoint: "/v1/chat/completions" }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("invalid_endpoint");
      expect(refused.json().error.param).toBe("endpoint");
    });

    it("answers a body with no input file with the plan: providers, asks and line counts", async () => {
      for (const table of ["provider_presence", "asks_chain", "providers"]) {
        await db.query(`DELETE FROM ${table}`);
      }
      await db.query(
        `INSERT INTO providers (provider_id, operator, box_key, reputation, capacity_ceiling,
                                capacity_requested, listed, allow_all_models)
         VALUES (4, $1, $2, 1000, 2, 2, true, true)`,
        [Buffer.alloc(20, 4), Buffer.alloc(32, 4)],
      );
      await db.query(
        "INSERT INTO asks_chain (provider_id, model_id, sla, rate_in, rate_out) VALUES (4, 7, 86400, 10, 20)",
      );
      await db.query("INSERT INTO provider_presence (provider_id, model_id, free_slots) VALUES (4, 7, 1)");

      const planned = await create({
        completion_window: "24h",
        models: [{ model_id: 7, lines: 3, units_in: 100, units_out: 200 }],
      });

      expect(planned.statusCode).toBe(402);
      expect(planned.json()).toEqual({
        plan: [
          {
            model_id: 7,
            lines: 3,
            // effectiveCap 2: two of the three lines fit, and the client refuses the batch.
            allocation: [
              { provider_id: 4, box_key: `0x${"04".repeat(32)}`, rate_in: "0.00001", rate_out: "0.00002", lines: 2 },
            ],
          },
        ],
      });
      // Nothing was created.
      expect((await db.query("SELECT count(*)::int AS n FROM batches")).rows[0].n).toBe(0);
    });

    it("plans within an entry's ceilings: an ask above one takes no lines", async () => {
      for (const table of ["provider_presence", "asks_chain", "providers"]) {
        await db.query(`DELETE FROM ${table}`);
      }
      await db.query(
        `INSERT INTO providers (provider_id, operator, box_key, reputation, capacity_ceiling,
                                capacity_requested, listed, allow_all_models)
         VALUES (4, $1, $2, 1000, 2, 2, true, true)`,
        [Buffer.alloc(20, 4), Buffer.alloc(32, 4)],
      );
      await db.query(
        "INSERT INTO asks_chain (provider_id, model_id, sla, rate_in, rate_out) VALUES (4, 7, 86400, 10, 20)",
      );
      await db.query("INSERT INTO provider_presence (provider_id, model_id, free_slots) VALUES (4, 7, 1)");

      const entry = { model_id: 7, lines: 1, units_in: 100, units_out: 200 };
      const planned = await create({
        completion_window: "24h",
        models: [
          { ...entry, max_rate_in: "0.000009" },
          { ...entry, max_rate_in: "0.00001" },
        ],
      });

      expect(planned.statusCode).toBe(402);
      expect(planned.json().plan.map((p: { allocation: unknown[] }) => p.allocation.length)).toEqual([0, 1]);
    });

    it("refuses a plan that names no models", async () => {
      const refused = await create({ completion_window: "24h", models: [] });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.param).toBe("models");
    });

    it("refuses a plan that names more models than one plan may", async () => {
      const model = { model_id: 7, lines: 1, units_in: 1, units_out: 1 };
      const refused = await create({ completion_window: "24h", models: Array(17).fill(model) });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.param).toBe("models");
    });

    it("refuses a plan total sent as a string: every integer is a JSON integer", async () => {
      const refused = await create({
        completion_window: "24h",
        models: [{ model_id: 7, lines: 1, units_in: "100", units_out: 1 }],
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.param).toBe("models[0].units_in");
    });

    it("refuses a window it cannot sign an SLA for", async () => {
      const refused = await create(await body({ completion_window: "7d" }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("invalid_completion_window");
    });

    it("refuses an input file it never minted", async () => {
      const refused = await create(await body({ input_file_id: "file-000000000000000000000000" }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("invalid_input_file");
    });

    it("refuses another caller's input file with the same answer as a missing one", async () => {
      // A distinguishable refusal would turn this door into an oracle for whether
      // a file id exists, which is the only thing protecting one client's batch
      // input from another's.
      const theirs = await seedFile({ owner: STRANGER });
      const refused = await create(await body({ input_file_id: theirs }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("invalid_input_file");
    });

    it("refuses a file uploaded for something other than a batch", async () => {
      const output = await seedFile({ purpose: "batch_output" });
      expect((await create(await body({ input_file_id: output }))).json().error.code).toBe(
        "invalid_input_file",
      );
    });

    it("carries metadata through and bounds it the way OpenAI does", async () => {
      const created = (await create(await body({ metadata: { run: "nightly" } }))).json();
      expect(created.metadata).toEqual({ run: "nightly" });

      const tooMany = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]),
      );
      const refused = await create(await body({ metadata: tooMany }));
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.param).toBe("metadata");
    });

    it("records the batch against its input file, validating for the worker to pick up", async () => {
      const inputFileId = await seedFile();
      const created = (await create(await body({ input_file_id: inputFileId }))).json();
      expect(created.input_file_id).toBe(inputFileId);
      const { rows } = await db.query<{ status: string }>(
        "SELECT status FROM batches WHERE batch_id = $1",
        [created.id],
      );
      expect(rows[0]?.status).toBe("validating");
    });

    it("attaches the input file, so the sweep stops counting it as an unclaimed upload", async () => {
      // An upload nobody names is deleted after 300 s. The batch row names this
      // one the moment it exists, so create is where that window has to close —
      // otherwise the worker finds a batch whose input object is gone and fails
      // it. Seeded at the orphan expiry rather than the retention one, so the
      // assertion is about this door and not about the fixture.
      const created = now();
      const inputFileId = await seedFile({ created_at: created, expires_at: created + 300n });

      await create(await body({ input_file_id: inputFileId }));

      const { rows } = await db.query<{ created_at: string; expires_at: string }>(
        "SELECT created_at, expires_at FROM files WHERE file_id = $1",
        [inputFileId],
      );
      expect(BigInt(rows[0].expires_at) - BigInt(rows[0].created_at)).toBe(
        BigInt(testConfig().fileRetentionSeconds),
      );
    });

    it("refuses when the sweep takes the input file after the ownership check, and records no batch", async () => {
      // The ownership select and the attach are two statements, and the sweep's
      // `DELETE` can commit between them — a 300 s window closing on the very
      // file this create is claiming. `attachFile` answers `false` for it, and
      // ignoring that answer is what leaves a batch stuck in `validating` over
      // an object that no longer exists.
      //
      // Driven through a handle that deletes the row the instant the select has
      // answered: the window is microseconds wide and nothing else can land
      // inside it deterministically.
      const inputFileId = await seedFile();
      const racing: Db = {
        ...db,
        query: (async (text: string, params?: readonly unknown[]) => {
          const result = await db.query(text, params);
          if (text.includes("FROM files WHERE file_id")) {
            await db.query("DELETE FROM files WHERE file_id = $1", [inputFileId]);
          }
          return result;
        }) as Db["query"],
      };
      const racingApp = buildApp({
        db: racing,
        indexer: stubIndexer(),
        config: testConfig({ dbUrl: TEST_DATABASE_URL as string }),
      });
      try {
        const refused = await racingApp.inject({
          method: "POST",
          url: "/v1/batches",
          headers: auth(),
          payload: {
            input_file_id: inputFileId,
            endpoint: "/v1/responses",
            completion_window: "24h",
          },
        });

        expect(refused.statusCode).toBe(400);
        // The same answer a file that was never there gets: the remedy is the
        // same upload either way.
        expect(refused.json().error.code).toBe("invalid_input_file");
      } finally {
        await racingApp.close();
      }

      const { rows } = await db.query("SELECT batch_id FROM batches");
      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  describe("GET /v1/batches/{id}", () => {
    it("folds counts out of the member jobs rather than a stored tally", async () => {
      const batchId = await seedBatch();
      await seedLine(batchId, 0, SETTLED);
      await seedLine(batchId, 1, SETTLED);
      await seedLine(batchId, 2, CLAIMED);
      await seedLine(batchId, 3, CANCELLED);

      const response = await get(`/v1/batches/${batchId}`);
      expect(response.statusCode).toBe(200);
      expect(response.json().request_counts).toEqual({
        completed: 2,
        failed: 1,
        total: 4,
      });
      expect(response.json().status).toBe("in_progress");
    });

    it("counts a line the chain skipped, which has no job at all", async () => {
      const batchId = await seedBatch();
      await seedLine(batchId, 0, SETTLED);
      await seedLine(batchId, 1, null, { skip_reason: "0xdeadbeef" });

      // A skipped line is terminal the moment `postMany` answers `PostSkipped`:
      // nothing on chain will ever move it, so a batch whose counts left it out
      // would read as still running forever.
      const body = (await get(`/v1/batches/${batchId}`)).json();
      expect(body.request_counts).toEqual({ completed: 1, failed: 1, total: 2 });
      // `finalizing` rather than `completed`: nothing has run the worker in this test, so
      // the files are not frozen — and `completed` is a promise that they are.
      expect(body.status).toBe("finalizing");
    });

    it("reads an open line past its expiry as terminal, the way the chain does", async () => {
      // `state = 0` with `expires_at` in the past is the one job state that is
      // computed rather than stored: nothing writes it back, and a fold that read
      // the column alone would hold the batch open forever.
      const batchId = await seedBatch();
      await seedLine(batchId, 0, OPEN, { expires_at: now() - 10n });
      expect((await get(`/v1/batches/${batchId}`)).json().request_counts).toEqual({
        completed: 0,
        failed: 1,
        total: 1,
      });
    });

    it("stamps the block it answered from", async () => {
      const batchId = await seedBatch();
      expect((await get(`/v1/batches/${batchId}`)).json().as_of_block).toBe(Number(CURSOR_BLOCK));
    });

    it("does not serve one caller's batch to another", async () => {
      const batchId = await seedBatch();
      expect((await get(`/v1/batches/${batchId}`, strangerToken)).statusCode).toBe(404);
    });

    it("answers 404 for an id it never minted", async () => {
      expect((await get("/v1/batches/batch_000000000000000000000000")).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  describe("GET /v1/batches", () => {
    it("lists a caller's own batches, newest first, in OpenAI's list envelope", async () => {
      const first = await seedBatch({ created_at: now() - 300n });
      const second = await seedBatch({ created_at: now() - 200n });
      const third = await seedBatch({ created_at: now() - 100n });
      await seedBatch({ owner: STRANGER });

      const body = (await get("/v1/batches")).json();
      expect(body.object).toBe("list");
      expect(body.data.map((batch: { id: string }) => batch.id)).toEqual([third, second, first]);
      expect(body.first_id).toBe(third);
      expect(body.last_id).toBe(first);
      expect(body.has_more).toBe(false);
    });

    it("pages with limit and after, and says when there is more", async () => {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        ids.push(await seedBatch({ created_at: now() - BigInt(300 - index * 100) }));
      }
      const newestFirst = [...ids].reverse();

      const page = (await get("/v1/batches?limit=2")).json();
      expect(page.data.map((batch: { id: string }) => batch.id)).toEqual(newestFirst.slice(0, 2));
      expect(page.has_more).toBe(true);

      const next = (await get(`/v1/batches?limit=2&after=${page.last_id}`)).json();
      expect(next.data.map((batch: { id: string }) => batch.id)).toEqual(newestFirst.slice(2));
      expect(next.has_more).toBe(false);
    });

    it("answers an empty list rather than a 404 when a caller has none", async () => {
      const body = (await get("/v1/batches")).json();
      expect(body).toMatchObject({ object: "list", data: [], first_id: null, last_id: null, has_more: false });
    });
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  describe("POST /v1/batches/{id}/cancel", () => {
    const cancel = (batchId: string, bearer = token) =>
      app.inject({ method: "POST", url: `/v1/batches/${batchId}/cancel`, headers: auth(bearer) });

    it("moves to cancelling while a claimed line is still winding down", async () => {
      // A line a provider already holds runs to its own end — settlement, failure
      // or SLA reclaim — exactly as a standalone claimed job does. Nothing here
      // can take it back.
      const batchId = await seedBatch();
      await seedLine(batchId, 0, SETTLED);
      await seedLine(batchId, 1, CLAIMED);

      const response = await cancel(batchId);
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("cancelling");
      expect(response.json().cancelling_at).not.toBeNull();
    });

    it("reads as cancelled once the last in-flight line has landed", async () => {
      // The whole lifecycle, because it cannot be reached any other way: a batch
      // whose lines are already terminal folds to `completed` and is refused, so
      // `cancelled` is only ever the state a `cancelling` batch arrives at.
      const batchId = await seedBatch();
      await seedLine(batchId, 0, SETTLED);
      const claimed = await seedLine(batchId, 1, CLAIMED);
      expect((await cancel(batchId)).json().status).toBe("cancelling");

      await db.query("UPDATE jobs SET state = $2 WHERE job_id = $1", [claimed, CANCELLED]);
      // Every line has landed, but the pass that freezes the files has not run — so the
      // batch is finalizing, not cancelled. A `cancelled` here would name an output file
      // that does not exist yet.
      expect((await get(`/v1/batches/${batchId}`)).json().status).toBe("finalizing");

      await db.query("UPDATE batches SET cancelled_at = $2 WHERE batch_id = $1", [batchId, 42]);
      expect((await get(`/v1/batches/${batchId}`)).json().status).toBe("cancelled");
    });

    it("is idempotent — a second cancel does not move the stamp", async () => {
      const batchId = await seedBatch();
      await seedLine(batchId, 0, CLAIMED);
      const first = (await cancel(batchId)).json();
      const second = (await cancel(batchId)).json();
      expect(second.cancelling_at).toBe(first.cancelling_at);
    });

    it("refuses to cancel a batch that already finished", async () => {
      const batchId = await seedBatch();
      await seedLine(batchId, 0, SETTLED);
      const refused = await cancel(batchId);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("batch_not_cancellable");
    });

    it("does not let one caller cancel another's batch", async () => {
      const batchId = await seedBatch();
      await seedLine(batchId, 0, CLAIMED);
      expect((await cancel(batchId, strangerToken)).statusCode).toBe(404);
      const { rows } = await db.query<{ cancelling_at: bigint | null }>(
        "SELECT cancelling_at FROM batches WHERE batch_id = $1",
        [batchId],
      );
      expect(rows[0]?.cancelling_at).toBeNull();
    });
  });
});
