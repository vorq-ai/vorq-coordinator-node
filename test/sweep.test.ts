import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { put, S3Pinner } from "../src/pin/pinner.js";
import { fileSweepTick, FILE_SWEEP_INTERVAL_MS, startFileSweep, SWEEP_BATCH } from "../src/pin/sweep.js";
import { startStubStore, type StubStore } from "./support/stub-store.js";

/**
 * The file sweep: the one thing in this node that deletes stored bytes.
 *
 * Two rules, and the tests are split the same way. An **upload nobody attached**
 * expires five minutes after it was made and takes its object with it — unless
 * something still names that object, which is the half that would otherwise
 * delete a live job's container. **Everything past retention** goes whatever
 * names it, which is what makes `FILE_RETENTION_SECONDS` a bound rather than a
 * setting nothing reads.
 *
 * Against a real Postgres and a real (loopback) object store, because both halves
 * are SQL — `convert_from` on two `bytea` columns, a `DELETE … RETURNING` — and a
 * predicate that matched nothing would pass every stub:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_sweep_test";

const OWNER = Buffer.alloc(20, 0xa1);
const RETENTION = 2_592_000;

describe.skipIf(!TEST_DATABASE_URL)("the file sweep", () => {
  let db: Db;
  let store: StubStore;
  let pinner: S3Pinner;
  /**
   * Every `(error, cid)` the sweep reported. Empty is the assertion in most
   * cases. `cid` is absent when the whole pass failed rather than one object.
   */
  let failures: { error: unknown; cid: string | undefined }[];

  const onError = (error: unknown, cid?: string): void => {
    failures.push({ error, cid });
  };

  const tick = () => fileSweepTick(db, pinner, RETENTION, onError);

  /** One upload, filed with the store and written down, expiring at `expiresAt`. */
  async function seedFile(options: {
    fileId: string;
    bytes: Buffer;
    expiresAt: number;
    purpose?: string;
  }): Promise<string> {
    const cid = await put(pinner, options.bytes);
    await db.query(
      `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, lines,
                          created_at, expires_at)
       VALUES ($1, $2, $3, 'upload', $4, $5, 0, $6, $7)`,
      [
        options.fileId,
        OWNER,
        options.purpose ?? "input",
        options.bytes.length,
        cid,
        Math.floor(Date.now() / 1000),
        options.expiresAt,
      ],
    );
    return cid;
  }

  /** The key the store filed `cid` under, or `undefined` once the row is gone. */
  const keyOf = async (cid: string): Promise<string | undefined> =>
    (
      await db.query<{ s3_key: string }>("SELECT s3_key FROM pins WHERE cid = $1", [cid])
    ).rows[0]?.s3_key;

  const past = (seconds: number): number => Math.floor(Date.now() / 1000) - seconds;
  const future = (seconds: number): number => Math.floor(Date.now() / 1000) + seconds;

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    store = await startStubStore();
    pinner = new S3Pinner(store.config(), db);
  });

  afterAll(async () => {
    await store?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["files", "pins", "batch_lines", "batches", "jobs"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    store.objects.clear();
    store.uploads.clear();
    store.deleteStatus = null;
    failures = [];
  });

  // -------------------------------------------------------------------------
  // An upload nobody attached
  // -------------------------------------------------------------------------

  it("deletes an expired upload, its pin and its object", async () => {
    const cid = await seedFile({
      fileId: "file-orphan",
      bytes: Buffer.from("nobody posted this"),
      expiresAt: past(1),
    });
    const key = (await keyOf(cid)) as string;
    expect(store.objects.has(key)).toBe(true);

    const run = await tick();

    expect(run).toEqual({ expired: 1, removed: 1, saturated: false });
    expect(failures).toEqual([]);
    const { rows } = await db.query("SELECT file_id FROM files");
    expect(rows).toEqual([]);
    expect(await keyOf(cid)).toBeUndefined();
    expect(store.objects.has(key)).toBe(false);
  });

  it("leaves an attached upload alone: its expiry was moved out to retention", async () => {
    const cid = await seedFile({
      fileId: "file-attached",
      bytes: Buffer.from("a job names this"),
      expiresAt: future(RETENTION),
    });

    const run = await tick();

    expect(run).toEqual({ expired: 0, removed: 0, saturated: false });
    const { rows } = await db.query<{ file_id: string }>("SELECT file_id FROM files");
    expect(rows.map((row) => row.file_id)).toEqual(["file-attached"]);
    expect(store.objects.has((await keyOf(cid)) as string)).toBe(true);
  });

  it("keeps the object when a job's task_cid still names it", async () => {
    // The row goes — the upload's own lifecycle is over — and the object stays,
    // because a provider is still going to fetch it by the name on chain. The
    // comparison decodes `task_cid` from bytea: one that matched nothing would
    // delete the container out from under every open job.
    const cid = await seedFile({
      fileId: "file-posted",
      bytes: Buffer.from("posted as a job"),
      expiresAt: past(1),
    });
    const key = (await keyOf(cid)) as string;
    await seedJob({ jobId: 0x51, taskCid: cid });

    const run = await tick();

    expect(run).toEqual({ expired: 1, removed: 0, saturated: false });
    expect(await keyOf(cid)).toBe(key);
    expect(store.objects.has(key)).toBe(true);
  });

  it("keeps the object when a settled job's result_cid names it", async () => {
    const cid = await seedFile({
      fileId: "file-settled",
      bytes: Buffer.from("settled with this"),
      expiresAt: past(1),
      purpose: "result",
    });
    await seedJob({ jobId: 0x52, taskCid: "bafkreisomethingelse", resultCid: cid });

    expect(await tick()).toEqual({ expired: 1, removed: 0, saturated: false });
    expect(store.objects.has((await keyOf(cid)) as string)).toBe(true);
  });

  it("keeps the object when a batch line names it", async () => {
    const cid = await seedFile({
      fileId: "file-line",
      bytes: Buffer.from("one line of a batch"),
      expiresAt: past(1),
    });
    await db.query(
      `INSERT INTO batches (batch_id, owner, endpoint, completion_window, input_file_id,
                            created_at, expires_at)
       VALUES ('batch_1', $1, '/v1/responses', 86400, 'file-input', $2, $3)`,
      [OWNER, Math.floor(Date.now() / 1000), future(86_400)],
    );
    await db.query(
      "INSERT INTO batch_lines (batch_id, line_no, task_cid) VALUES ('batch_1', 1, $1)",
      [cid],
    );

    expect(await tick()).toEqual({ expired: 1, removed: 0, saturated: false });
    expect(store.objects.has((await keyOf(cid)) as string)).toBe(true);
  });

  it("survives a job whose task_cid is not UTF-8, and still protects a referenced cid", async () => {
    // `task_cid` is unbounded chain `bytes` and nothing makes it text: a job
    // posted with arbitrary bytes is enough to make `convert_from` raise, which
    // would abort this tick **after** the `files` DELETE had committed and abort
    // every later tick the same way. The comparison encodes the cid instead.
    const referenced = await seedFile({
      fileId: "file-referenced",
      bytes: Buffer.from("named by a job"),
      expiresAt: past(1),
    });
    const orphan = await seedFile({
      fileId: "file-orphan-too",
      bytes: Buffer.from("named by nobody"),
      expiresAt: past(1),
    });
    await seedJob({ jobId: 0x61, taskCid: referenced });
    // Invalid UTF-8: a lone continuation byte and an unpaired surrogate's bytes.
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, task_cid, result_cid, as_of_block,
                         gas_fee)
       VALUES ($1, $2, $3, 7, 3600, 0, '1', '1', 1, 1, $4, $5, $6, 1, '1')`,
      [
        Buffer.alloc(32, 0x62),
        OWNER,
        Buffer.alloc(32, 0xbb),
        BigInt(future(3600)),
        Buffer.from([0x80, 0xff, 0xfe, 0xed, 0xc0]),
        Buffer.from([0xff, 0xff]),
      ],
    );

    const run = await tick();

    // Both rows went, the orphan's object with them, and the referenced object
    // stayed — which is only observable because the tick got that far at all.
    expect(run).toEqual({ expired: 2, removed: 1, saturated: false });
    expect(failures).toEqual([]);
    expect(store.objects.has((await keyOf(referenced)) as string)).toBe(true);
    expect(await keyOf(orphan)).toBeUndefined();
  });

  it("keeps the object when another file row still names the same bytes", async () => {
    // Two uploads of the same bytes are one object under one name: the store
    // mints from the content. Removing it on the first expiry would leave the
    // second row naming nothing.
    const bytes = Buffer.from("filed twice");
    const cid = await seedFile({ fileId: "file-first", bytes, expiresAt: past(1) });
    await seedFile({ fileId: "file-second", bytes, expiresAt: future(RETENTION) });

    expect(await tick()).toEqual({ expired: 1, removed: 0, saturated: false });
    expect(store.objects.has((await keyOf(cid)) as string)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Everything past retention
  // -------------------------------------------------------------------------

  it("removes a pin past the retention window", async () => {
    const cid = await put(pinner, Buffer.from("filed a long time ago"));
    const key = (await keyOf(cid)) as string;
    await db.query("UPDATE pins SET created_at = now() - make_interval(secs => $1)", [
      RETENTION + 60,
    ]);

    const run = await tick();

    expect(run).toEqual({ expired: 0, removed: 1, saturated: false });
    expect(await keyOf(cid)).toBeUndefined();
    expect(store.objects.has(key)).toBe(false);
  });

  it("leaves a pin inside the window, however orphaned it is", async () => {
    // The residue of a pin that succeeded and a relay that then failed. It is
    // storage nothing names, and it still waits out retention rather than being
    // removed while the post that would have named it may be in flight.
    const cid = await put(pinner, Buffer.from("orphaned by a failed relay"));

    expect(await tick()).toEqual({ expired: 0, removed: 0, saturated: false });
    expect(store.objects.has((await keyOf(cid)) as string)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  it("reports a store that refuses the delete and keeps the pin for the next tick", async () => {
    const cid = await seedFile({
      fileId: "file-stuck",
      bytes: Buffer.from("the store will not delete this"),
      expiresAt: past(1),
    });
    const key = (await keyOf(cid)) as string;
    store.deleteStatus = 500;

    const run = await tick();

    // The row went — it had expired, and that is not the store's business — and
    // the pin stayed, so the next tick tries the object again.
    expect(run).toEqual({ expired: 1, removed: 0, saturated: false });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.cid).toBe(cid);
    expect(await keyOf(cid)).toBe(key);

    // The next tick, with the store answering again: the object goes. It is
    // reached through the retention rule now, so the pin is aged past it.
    store.deleteStatus = null;
    await db.query("UPDATE pins SET created_at = now() - make_interval(secs => $1)", [
      RETENTION + 60,
    ]);
    expect(await tick()).toEqual({ expired: 0, removed: 1, saturated: false });
    expect(await keyOf(cid)).toBeUndefined();
    expect(store.objects.has(key)).toBe(false);
  });

  it("finishes the pass when one object fails, rather than stopping at it", async () => {
    await seedFile({ fileId: "file-a", bytes: Buffer.from("a"), expiresAt: past(1) });
    await seedFile({ fileId: "file-b", bytes: Buffer.from("b"), expiresAt: past(1) });
    store.deleteStatus = 500;

    const run = await tick();

    expect(run.expired).toBe(2);
    expect(failures).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // The timer
  // -------------------------------------------------------------------------

  it("runs on a timer that cannot hold the process open, and stops", async () => {
    const sweep = startFileSweep(db, pinner, RETENTION, onError, FILE_SWEEP_INTERVAL_MS);
    try {
      await seedFile({ fileId: "file-ticked", bytes: Buffer.from("swept"), expiresAt: past(1) });
      expect(await sweep.tick()).toEqual({ expired: 1, removed: 1, saturated: false });
    } finally {
      sweep.stop();
    }
    expect(failures).toEqual([]);
  });

  it("does not start a pass on top of a pass still running", async () => {
    const sweep = startFileSweep(db, pinner, RETENTION, onError);
    try {
      await seedFile({ fileId: "file-once", bytes: Buffer.from("once"), expiresAt: past(1) });
      const [first, second] = await Promise.all([sweep.tick(), sweep.tick()]);

      // One of the two did the work and the other answered `null` rather than
      // deleting the same rows again.
      expect([first, second]).toContainEqual(null);
      expect([first, second]).toContainEqual({ expired: 1, removed: 1, saturated: false });
    } finally {
      sweep.stop();
    }
  });

  it("can answer stillNamed from indexes rather than scanning jobs and batch_lines", async () => {
    // `stillNamed` runs once per surviving cid, so its cost is what decides
    // whether a backlog is a minute of work or an hour. The query was written to
    // encode the parameter rather than decode the column *so that an index would
    // be usable* — see the comment in sweep.ts — but the indexes it was written
    // for did not exist, which made every expired cid two full scans of `jobs`
    // plus one of `batch_lines`.
    //
    // `enable_seqscan = off` is what makes this a test rather than a hope: on
    // tables this small the planner picks a sequential scan whatever indexes
    // exist, and with the setting off it picks an index if and only if one is
    // usable. A missing index still shows as `Seq Scan` here, at a penalty cost.
    await db.query("SET enable_seqscan = off");
    try {
      const planFor = async (sql: string): Promise<string> => {
        const { rows } = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, ["cid_probe"]);
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      };

      expect(await planFor("SELECT 1 FROM jobs WHERE task_cid = convert_to($1, 'UTF8')"))
        .not.toContain("Seq Scan");
      expect(
        await planFor(
          "SELECT 1 FROM jobs WHERE result_cid <> ''::bytea AND result_cid = convert_to($1, 'UTF8')",
        ),
      ).not.toContain("Seq Scan");
      expect(await planFor("SELECT 1 FROM batch_lines WHERE task_cid = $1")).not.toContain("Seq Scan");
    } finally {
      await db.query("RESET enable_seqscan");
    }
  });

  it("can find pins past retention from an index rather than scanning them", async () => {
    // The stale-pin pass runs every 60 s whether or not anything is past
    // retention, so its scan is the one cost the sweep pays unconditionally.
    await db.query("SET enable_seqscan = off");
    try {
      const { rows } = await db.query<{ "QUERY PLAN": string }>(
        "EXPLAIN SELECT cid FROM pins WHERE created_at < now() - make_interval(secs => $1) LIMIT $2",
        [RETENTION, SWEEP_BATCH],
      );
      expect(rows.map((row) => row["QUERY PLAN"]).join("\n")).not.toContain("Seq Scan");
    } finally {
      await db.query("RESET enable_seqscan");
    }
  });

  it("stops an expired-file pass at SWEEP_BATCH and takes the rest next tick", async () => {
    // The backlog case: a node down for a week, or an operator who has just
    // shortened retention. Each expired cid costs a `stillNamed` query and a
    // store round trip, so an unbounded pass runs for as long as the backlog
    // takes — and because the rows are deleted before the objects are, a crash
    // part-way leaves the objects reachable only by the retention rule, weeks
    // later. The stale-pin pass below it has always been batched; this one was
    // not, which is the asymmetry this test closes.
    //
    // The rows are seeded without objects behind them: `remove` no-ops on a cid
    // with no `pins` row, so this measures the bound on the DELETE without
    // paying a thousand store round trips for it. That the objects go too is
    // what the cases above already assert.
    const backlog = SWEEP_BATCH + 2;
    await db.query(
      `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, lines,
                          created_at, expires_at)
       SELECT 'file_backlog_' || i, $1, 'input', 'upload', 3, 'cid_backlog_' || i, 0, $2, $3
         FROM generate_series(1, $4) AS i`,
      [OWNER, Math.floor(Date.now() / 1000), past(60), backlog],
    );

    const first = await tick();
    expect(first.expired).toBe(SWEEP_BATCH);
    // The signal an operator reads a backlog off: a full pass means there is
    // more to take, and a run of them means the sweep is not keeping up.
    expect(first.saturated).toBe(true);
    expect(failures).toEqual([]);

    // The remainder, not a whole second batch: `SWEEP_BATCH + 2` rather than a
    // round number is what makes that distinguishable.
    const second = await tick();
    expect(second.expired).toBe(backlog - SWEEP_BATCH);
    expect(second.saturated).toBe(false);

    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM files");
    expect(Number(rows[0].n)).toBe(0);
  });

  /** One chain-derived job row, with whatever cids the case is about. */
  async function seedJob(options: {
    jobId: number;
    taskCid: string;
    resultCid?: string;
  }): Promise<void> {
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, task_cid, result_cid, as_of_block,
                         gas_fee)
       VALUES ($1, $2, $3, 7, 3600, 0, '1', '1', 1, 1, $4, $5, $6, 1, '1')`,
      [
        Buffer.alloc(32, options.jobId),
        OWNER,
        Buffer.alloc(32, 0xbb),
        BigInt(future(3600)),
        Buffer.from(options.taskCid, "utf8"),
        Buffer.from(options.resultCid ?? "", "utf8"),
      ],
    );
  }
});
