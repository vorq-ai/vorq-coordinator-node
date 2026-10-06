import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { finalizeBatch } from "../src/batches/finalize.js";
import { openDb, type Db } from "../src/db/db.js";
import { pinnerFor, type Pinner } from "../src/pin/pinner.js";
import { startStubStore, type StubStore } from "./support/stub-store.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * The batch worker's **finalization pass**: the two files a caller downloads.
 *
 * They are frozen and pinned once, at the end, and that is a decision rather than
 * an omission. The old design allocated `output_file_id` early and served partial
 * JSONL with an `X-Incomplete` header; content-addressed storage cannot do that —
 * an append mints a different name — and `output_file_id: null` until terminal is
 * stock OpenAI behaviour anyway. What the old design had that this does not is a
 * `?offset=` resume, and nothing needs it: the file appears whole or not at all.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_batch_finalize_test";

const OWNER = Buffer.alloc(20, 0xc3);

/** Chain job states, as `0001_init.sql` numbers them. */
const OPEN = 0;
const CLAIMED = 1;
const SETTLED = 2;
const CANCELLED = 3;

/** `ended_because`, likewise: 0 none, 1 settled, 2 cancelled, 3 provider_fail, 4 reclaim. */
const BECAUSE_SETTLED = 1;
const BECAUSE_CANCELLED = 2;
const BECAUSE_PROVIDER_FAIL = 3;
const BECAUSE_RECLAIM = 4;

interface OutputRow {
  id: string;
  custom_id: string | null;
  response: { status_code: number; request_id: string; body: unknown } | null;
  error: { code: string; message: string } | null;
  vorq: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("freezing a batch's output", () => {
  let db: Db;
  let store: StubStore;
  let pinner: Pinner;
  let config: ReturnType<typeof testConfig>;

  const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

  async function seedBatch(overrides: Record<string, unknown> = {}): Promise<string> {
    const batchId = `batch_${randomBytes(8).toString("hex")}`;
    const created = now();
    const fileId = `file-${randomBytes(12).toString("hex")}`;
    await db.query(
      `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, status, lines,
                          created_at, expires_at)
       VALUES ($1, $2, 'batch', 'in.jsonl', 10, 'bafyinput', 'uploaded', 1, $3, $4)`,
      [fileId, OWNER, created, created + 2_592_000n],
    );
    const row = {
      batch_id: batchId,
      owner: OWNER,
      endpoint: "/v1/responses",
      completion_window: 86400n,
      input_file_id: fileId,
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

  interface LineOptions {
    state?: number;
    endedBecause?: number;
    resultCid?: string;
    expiresAt?: bigint;
    skipReason?: string;
    providerId?: number;
    completionTok?: number;
    gasFee?: bigint;
    fee?: bigint;
  }

  /** One member job and the `batch_lines` row that names it, or a skipped line. */
  async function seedLine(batchId: string, lineNo: number, options: LineOptions = {}) {
    if (options.skipReason !== undefined) {
      await db.query(
        "INSERT INTO batch_lines (batch_id, line_no, skip_reason) VALUES ($1, $2, $3)",
        [batchId, lineNo, options.skipReason],
      );
      return null;
    }
    const jobId = randomBytes(32);
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, state, ended_because, provider_id,
                         completion_tok, task_cid, result_cid, as_of_block, gas_fee, fee)
       VALUES ($1, $2, $3, 7, 3600, 0, 30000, 90000, 100, 200, $4, $5, $6, $7, $8, $9, $10, 1,
               $11, $12)`,
      [
        jobId,
        OWNER,
        randomBytes(32),
        options.expiresAt ?? now() + 3600n,
        options.state ?? SETTLED,
        options.endedBecause ?? BECAUSE_SETTLED,
        options.providerId ?? 7,
        options.completionTok ?? 128,
        Buffer.from("bafkreitask", "utf8"),
        Buffer.from(options.resultCid ?? "", "utf8"),
        options.gasFee ?? 30_000n,
        options.fee ?? 0n,
      ],
    );
    await db.query(
      "INSERT INTO batch_lines (batch_id, line_no, job_id, task_cid) VALUES ($1, $2, $3, 'bafkreitask')",
      [batchId, lineNo, jobId],
    );
    return jobId;
  }

  const batchRow = async (batchId: string) =>
    (
      await db.query<Record<string, string | null>>(
        `SELECT output_file_id, error_file_id, finalizing_at, completed_at, cancelled_at, expired_at
           FROM batches WHERE batch_id = $1`,
        [batchId],
      )
    ).rows[0];

  /** The rows of a pinned JSONL, read back out of the store by file id. */
  async function fileRows(fileId: string | null): Promise<OutputRow[]> {
    expect(fileId).not.toBeNull();
    const { rows } = await db.query<{ cid: string; purpose: string }>(
      "SELECT cid, purpose FROM files WHERE file_id = $1",
      [fileId],
    );
    const content = await pinner.fetch(rows[0].cid);
    expect(content).not.toBeNull();
    return (content as Buffer)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as OutputRow);
  }

  const purposeOf = async (fileId: string | null) =>
    (
      await db.query<{ purpose: string }>("SELECT purpose FROM files WHERE file_id = $1", [fileId])
    ).rows[0]?.purpose;

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
    store = await startStubStore();
    config = testConfig({ dbUrl: url, pinS3: store.config() });
    pinner = pinnerFor(config, db);
  });

  afterAll(async () => {
    await store?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["batch_lines", "batches", "files", "jobs", "pins"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    store.objects.clear();
  });

  const finalize = (batchId: string) => finalizeBatch({ db, config, pinner }, batchId);

  // -------------------------------------------------------------------------

  it("freezes one output row per settled line, naming the result rather than carrying it", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });
    await seedLine(batchId, 2, { resultCid: "bafyresult2" });

    const outcome = await finalize(batchId);
    expect(outcome).toEqual(expect.objectContaining({ succeeded: 2, errored: 0 }));

    const batch = await batchRow(batchId);
    expect(await purposeOf(batch.output_file_id)).toBe("batch_output");
    const rows = await fileRows(batch.output_file_id);

    expect(rows).toHaveLength(2);
    expect(rows[0].error).toBeNull();
    expect(rows[0].response?.status_code).toBe(200);
    expect(rows[0].vorq.result_cid).toBe("bafyresult1");
    // **`result_cid` is authoritative and there is no convenience copy.** The
    // bytes are sealed to the client's own result key; this node cannot read
    // them, so it names them and says nothing about what they contain.
    expect(rows[0].response?.body).toBeNull();
  });

  it("gives both frozen files the retention window, not the 300 s an upload gets", async () => {
    // The batch row names these files the instant they exist, so they are
    // attached by construction and there is no window in which nobody has
    // claimed them. Seeding them at the orphan expiry instead would hand the
    // file sweep the two objects a caller downloads its results from.
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });
    await seedLine(batchId, 2, { skipReason: "invalid_model" });

    await finalize(batchId);

    const batch = await batchRow(batchId);
    const { rows } = await db.query<{ created_at: string; expires_at: string }>(
      "SELECT created_at, expires_at FROM files WHERE file_id = ANY($1::text[])",
      [[batch.output_file_id, batch.error_file_id]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(BigInt(row.expires_at) - BigInt(row.created_at)).toBe(
        BigInt(config.fileRetentionSeconds),
      );
    }
  });

  it("mints no error file at all when every line settled", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });

    await finalize(batchId);

    expect((await batchRow(batchId)).error_file_id).toBeNull();
  });

  it("puts every line that never delivered in the error file, under the cause the chain gave", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });
    await seedLine(batchId, 2, {
      state: CANCELLED,
      endedBecause: BECAUSE_PROVIDER_FAIL,
    });
    await seedLine(batchId, 3, { state: CANCELLED, endedBecause: BECAUSE_RECLAIM });
    await seedLine(batchId, 4, { state: CANCELLED, endedBecause: BECAUSE_CANCELLED });
    await seedLine(batchId, 5, { skipReason: "invalid_order_signature" });

    const outcome = await finalize(batchId);
    expect(outcome).toEqual(expect.objectContaining({ succeeded: 1, errored: 4 }));

    const batch = await batchRow(batchId);
    // `batch_output`, not `batch_error`: `openai`'s FileObject.purpose Literal has
    // no such value, so a file object carrying it fails their own parse. The two
    // files are told apart by which column of the batch names them.
    expect(await purposeOf(batch.error_file_id)).toBe("batch_output");
    const rows = await fileRows(batch.error_file_id);

    // The one cause vocabulary every surface uses: a client cancel and an order
    // nobody claimed are different facts, and reporting both as "cancelled" lies
    // about the second.
    expect(rows.map((row) => row.error?.code)).toEqual([
      "provider_fail",
      "reclaim",
      "cancelled",
      "invalid_order_signature",
    ]);
    expect(rows.every((row) => row.response === null)).toBe(true);
  });

  it("reports a line nobody claimed before its deadline as expired, not cancelled", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { state: OPEN, endedBecause: 0, expiresAt: now() - 10n });

    await finalize(batchId);

    const rows = await fileRows((await batchRow(batchId)).error_file_id);
    // `state = 0` past its expiry is the one job state that is computed rather
    // than stored — `0001_init.sql` bounds cause 5 out on purpose — so a finalizer
    // reading the column alone would call this "open" and never finish.
    expect(rows[0].error?.code).toBe("expired");
  });

  it("does nothing at all while a line is still in flight", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });
    await seedLine(batchId, 2, { state: CLAIMED, endedBecause: 0 });

    expect(await finalize(batchId)).toBeNull();
    expect((await batchRow(batchId)).output_file_id).toBeNull();
  });

  it("finalizes a batch whose window closed even though a line is still open", async () => {
    const created = now() - 100_000n;
    const batchId = await seedBatch({ created_at: created, expires_at: created + 86_400n });
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });
    await seedLine(batchId, 2, { state: CLAIMED, endedBecause: 0, expiresAt: now() + 3600n });

    const outcome = await finalize(batchId);

    expect(outcome).toEqual(expect.objectContaining({ succeeded: 1, errored: 1 }));
    const batch = await batchRow(batchId);
    expect(batch.expired_at).not.toBeNull();
    expect(batch.completed_at).toBeNull();
    // A provider held this one and never settled it. That is a promise broken —
    // `reclaim` — and not the same fact as an order nobody ever claimed.
    expect((await fileRows(batch.error_file_id))[0].error?.code).toBe("reclaim");
  });

  it("stamps cancelled_at rather than completed_at for a batch its owner cancelled", async () => {
    const batchId = await seedBatch({ cancelling_at: now() });
    await seedLine(batchId, 1, { state: CANCELLED, endedBecause: BECAUSE_CANCELLED });

    await finalize(batchId);

    const batch = await batchRow(batchId);
    expect(batch.cancelled_at).not.toBeNull();
    expect(batch.completed_at).toBeNull();
  });

  it("stamps finalizing_at before the files it froze, and completed_at after", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });

    await finalize(batchId);

    const batch = await batchRow(batchId);
    expect(batch.finalizing_at).not.toBeNull();
    expect(batch.completed_at).not.toBeNull();
  });

  it("freezes once: a second pass over a finalized batch changes nothing", async () => {
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { resultCid: "bafyresult1" });

    await finalize(batchId);
    const first = await batchRow(batchId);

    expect(await finalize(batchId)).toBeNull();
    expect(await batchRow(batchId)).toEqual(first);
  });

  it("names the job on every row, which is what correlates a result to its line", async () => {
    const batchId = await seedBatch();
    const jobId = await seedLine(batchId, 1, { resultCid: "bafyresult1" });

    await finalize(batchId);

    const rows = await fileRows((await batchRow(batchId)).output_file_id);
    // `custom_id` is **null on every row**, and that is the sealed design rather
    // than a gap: it is the caller's own text, it rides sealed inside the
    // container, and it comes back inside the sealed result. This node never
    // holds it, so it cannot echo it — the client reads it out of the bytes
    // `result_cid` names, and correlates on `job_id` until it has.
    expect(rows[0].custom_id).toBeNull();
    expect(rows[0].vorq.job_id).toBe(`0x${(jobId as Buffer).toString("hex")}`);
  });

  it("freezes a settled line's vorq, both fees the job paid included, as USD", async () => {
    const batchId = await seedBatch();
    const jobId = await seedLine(batchId, 1, { resultCid: "bafyresult1", gasFee: 45_000n, fee: 2_500n });

    await finalize(batchId);

    const rows = await fileRows((await batchRow(batchId)).output_file_id);
    expect(rows[0].vorq).toEqual({
      job_id: `0x${(jobId as Buffer).toString("hex")}`,
      result_cid: "bafyresult1",
      provider: 7,
      rate_in: "0.03",
      rate_out: "0.09",
      gas_fee: "0.045",
      fee: "0.0025",
      completion_tok: 128,
    });
  });

  it("does not finalize a batch that is still validating", async () => {
    const batchId = await seedBatch({ status: "validating" });
    expect(await finalize(batchId)).toBeNull();
  });

  it("freezes a batch whose every line was refused exactly once", async () => {
    // The idempotence guard cannot be `output_file_id IS NULL`. A batch no line of
    // which delivered mints **no output file** — that is the deliberate behaviour a
    // client checks for, and it is what OpenAI does — so a guard reading that
    // column never latches, and the worker re-freezes the batch every fifteen
    // seconds for the rest of its life: a fresh `files` row and a fresh
    // `error_file_id` on each pass, each naming the same object, every earlier one
    // now dangling on a caller who had already read it.
    const batchId = await seedBatch();
    await seedLine(batchId, 1, { skipReason: "invalid_model" });
    await seedLine(batchId, 2, { skipReason: "insufficient_payment" });

    const first = await finalize(batchId);

    expect(first).toEqual(expect.objectContaining({ succeeded: 0, errored: 2 }));
    expect((await batchRow(batchId)).output_file_id).toBeNull();
    expect(await finalize(batchId)).toBeNull();
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            "SELECT count(*) AS n FROM files WHERE purpose = 'batch_output'",
          )
        ).rows[0].n,
      ),
    ).toBe(1);
  });
});
