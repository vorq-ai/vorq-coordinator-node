import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { put, type Pinner } from "../pin/pinner.js";
import { formatUsd } from "../money.js";

/**
 * The batch worker's **finalization pass**: the two files a caller downloads.
 *
 * A batch is finished when every line is terminal, or when its window has closed
 * on the ones that are not. At that instant the output and error files are built
 * from the job rows, **frozen, and pinned once**.
 *
 * ## Frozen, not streamed
 *
 * The recovered design allocated `output_file_id` at create time and served
 * partial JSONL with `X-Incomplete: true` / `X-Last-Line: N`, resumable through
 * `?offset=`. None of that survives content-addressed storage: an object is
 * immutable and an append mints a different name, so a partial file and its
 * finished successor are two different objects with two different ids. Freezing
 * at the end is also what stock OpenAI does — `output_file_id` is null until the
 * batch is terminal — so the deviation was the old design's, not this one's.
 *
 * ## What a row can and cannot say
 *
 * `result_cid` is authoritative and there is **no convenience copy of the body**.
 * The result is sealed to the client's own result key; this node cannot read it,
 * so it names the bytes and says nothing about what is in them. `custom_id` is
 * null for the same reason one level further in: it is the caller's own text, it
 * rides sealed inside the container, and it comes back inside the sealed result.
 * The client reads it out of the bytes `result_cid` names, and correlates on
 * `job_id` until it has.
 *
 * `error.code` is read straight off `ended_because`, in the one cause vocabulary
 * every surface in this node uses. A client cancel and an order nobody claimed
 * before its deadline are different facts, and reporting both as "cancelled" lies
 * about the second.
 */

export interface FinalizeDeps {
  db: Db;
  config: Config;
  pinner: Pinner;
}

export interface FinalizeRun {
  batchId: string;
  succeeded: number;
  errored: number;
  outputFileId: string | null;
  errorFileId: string | null;
}

interface BatchRow {
  batch_id: string;
  owner: Buffer;
  expires_at: string;
  cancelling_at: string | null;
}

interface LineRow {
  line_no: string;
  job_id: Buffer | null;
  skip_reason: string | null;
  state: number | null;
  ended_because: number | null;
  provider_id: string | null;
  completion_tok: string | null;
  rate_in: bigint | null;
  rate_out: bigint | null;
  gas_fee: bigint | null;
  fee: bigint | null;
  result_cid: Buffer | null;
  expires_at: string | null;
}

/** `ended_because`, as `0001_init.sql` numbers it. 5 is computed and never stored. */
const CAUSE: Record<number, string> = {
  2: "cancelled",
  3: "provider_fail",
  4: "reclaim",
};

const MESSAGE: Record<string, string> = {
  cancelled: "the owner cancelled this job before a provider delivered it",
  provider_fail: "the provider that claimed this job reported a failure",
  reclaim: "a provider claimed this job and never settled it within its SLA",
  expired: "no provider claimed this job before its deadline",
};

/**
 * Freeze one batch, or answer `null` if it is not finished.
 *
 * Idempotent by the **terminal stamp**, which is the only mark this pass always
 * leaves. `output_file_id` is the obvious candidate and it is wrong: a batch no
 * line of which delivered mints no output file at all — deliberately, because a
 * client checks for its absence rather than reading an empty one — so a guard on
 * that column never latches for exactly the batches that most need it, and the
 * worker re-freezes them every fifteen seconds. Each pass would mint a fresh
 * `files` row and a fresh `error_file_id` naming the same object, leaving every id
 * a caller had already read dangling.
 */
export async function finalizeBatch(
  deps: FinalizeDeps,
  batchId: string,
): Promise<FinalizeRun | null> {
  const { rows: batches } = await deps.db.query<BatchRow>(
    `SELECT batch_id, owner, expires_at, cancelling_at
       FROM batches
      WHERE batch_id = $1 AND status = 'in_progress'
        AND completed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`,
    [batchId],
  );
  const batch = batches[0];
  if (batch === undefined) return null;

  const now = nowSeconds();
  const { rows: lines } = await deps.db.query<LineRow>(
    `SELECT bl.line_no, bl.job_id, bl.skip_reason,
            j.state, j.ended_because, j.provider_id, j.completion_tok,
            j.rate_in, j.rate_out, j.gas_fee, j.fee,
            j.result_cid, j.expires_at
       FROM batch_lines bl LEFT JOIN jobs j ON j.job_id = bl.job_id
      WHERE bl.batch_id = $1
      ORDER BY bl.line_no`,
    [batchId],
  );

  const expired = now > BigInt(batch.expires_at);
  // Every line has to be terminal, or the window has to have closed on the ones
  // that are not. Without the second condition a batch holding one line a
  // provider claimed and abandoned would never finalize — the SLA reclaim that
  // ends it is a *provider's* transaction, and nobody is obliged to send it.
  if (!expired && !lines.every((line) => terminal(line, now))) return null;

  const output: string[] = [];
  const errors: string[] = [];
  for (const line of lines) {
    const id = `batch_req_${batchId.replace(/^batch_/, "")}_${line.line_no}`;
    const jobId = line.job_id === null ? null : `0x${line.job_id.toString("hex")}`;
    const cause = causeOf(line);
    if (cause === null) {
      output.push(
        JSON.stringify({
          id,
          custom_id: null,
          response: {
            status_code: 200,
            // The job id, because it is the only request identifier that exists
            // on both sides of this exchange and the only one on chain.
            request_id: jobId,
            body: null,
          },
          error: null,
          vorq: {
            job_id: jobId,
            result_cid: (line.result_cid ?? Buffer.alloc(0)).toString("utf8"),
            provider: Number(line.provider_id ?? 0),
            rate_in: formatUsd(line.rate_in ?? 0n, deps.config.addresses.decimals),
            rate_out: formatUsd(line.rate_out ?? 0n, deps.config.addresses.decimals),
            gas_fee: formatUsd(line.gas_fee ?? 0n, deps.config.addresses.decimals),
            fee: formatUsd(line.fee ?? 0n, deps.config.addresses.decimals),
            completion_tok: Number(line.completion_tok ?? 0),
          },
        }),
      );
      continue;
    }
    errors.push(
      JSON.stringify({
        id,
        custom_id: null,
        response: null,
        error: { code: cause, message: MESSAGE[cause] ?? `this line was not posted: ${cause}` },
        vorq: { job_id: jobId, line: Number(line.line_no) },
      }),
    );
  }

  // Stamped before the objects are filed, which is what `finalizing` names in
  // OpenAI's own vocabulary: the instant between the last line landing and the
  // files existing.
  //
  // **The fold returns that status now, and this stamp is not what decides it.**
  // This comment used to say the instant was unobservable — that the fold ran on
  // either side of it and never inside — and that was wrong: the fold runs on the
  // *read* path, so it lands inside the instant whenever a caller asks during it.
  // What the fold reads is the terminal stamp written below, because that is the
  // one written *with* the files. This one is written before them and would
  // report a batch as finished mid-freeze.
  await deps.db.query(
    "UPDATE batches SET finalizing_at = COALESCE(finalizing_at, $2) WHERE batch_id = $1",
    [batchId, now],
  );

  // **Both files are `batch_output`**, and the error file is not `batch_error`.
  // `openai`'s `FileObject.purpose` is a closed Literal — `assistants`,
  // `assistants_output`, `batch`, `batch_output`, `fine-tune`,
  // `fine-tune-results`, `vision`, `user_data` — and `batch_error` is not in it,
  // so a file object carrying it fails `FileObject.model_validate` outright. The
  // two are told apart the way OpenAI tells them apart anyway: by which field of
  // the batch names them.
  const outputFileId = await freeze(deps, batch, "batch_output", "output.jsonl", output);
  const errorFileId = await freeze(deps, batch, "batch_output", "error.jsonl", errors);

  // Which terminal stamp, in the fold's own precedence order: a caller's
  // cancellation outranks the clock, because it asked and that is what it should
  // read back even if the window closed while the last claimed lines wound down.
  const stamp =
    batch.cancelling_at !== null ? "cancelled_at" : expired ? "expired_at" : "completed_at";
  await deps.db.query(
    `UPDATE batches SET output_file_id = $2, error_file_id = $3, ${stamp} = COALESCE(${stamp}, $4)
      WHERE batch_id = $1`,
    [batchId, outputFileId, errorFileId, now],
  );

  return {
    batchId,
    succeeded: output.length,
    errored: errors.length,
    outputFileId,
    errorFileId,
  };
}

/**
 * File one JSONL and write the `files` row that names it.
 *
 * An empty set mints nothing: `error_file_id` stays null for a batch every line
 * of which delivered, which is what OpenAI does and what a client checks.
 */
async function freeze(
  deps: FinalizeDeps,
  batch: BatchRow,
  purpose: string,
  filename: string,
  rows: string[],
): Promise<string | null> {
  if (rows.length === 0) return null;
  const content = Buffer.from(`${rows.join("\n")}\n`, "utf8");
  const cid = await put(deps.pinner, content);
  const fileId = `file-${randomBytes(12).toString("hex")}`;
  // Retention from the start, not the 300 s an upload gets: the batch row names
  // this file the moment it exists, so it is attached by construction and there
  // is no window in which nobody has claimed it.
  const created = nowSeconds();
  await deps.db.query(
    `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, status, lines,
                        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'processed', $7, $8, $9)`,
    [
      fileId,
      batch.owner,
      purpose,
      filename,
      content.length,
      cid,
      rows.length,
      created,
      created + BigInt(deps.config.fileRetentionSeconds),
    ],
  );
  return fileId;
}

/**
 * Why this line did not deliver, or `null` if it did.
 *
 * The three cases a reader should not have to infer:
 *
 *   * **no `job_id`** — the line never became a job, and `skip_reason` is the
 *     receipt this node or the contract wrote for it.
 *   * **still open when the batch ended** — either past its own expiry (the one
 *     job state that is *computed* rather than stored: `0001_init.sql` bounds cause 5
 *     out on purpose, because a reconcile that wrote it back would make the index
 *     disagree with a rebuild) or caught by the batch's window closing. `expired`
 *     if nobody claimed it — nothing was promised and it holds no lock — and
 *     `reclaim` if a provider held it and never settled, which is a promise
 *     broken and a different fact.
 *   * **a job the index has not caught up with** — no row at all. `expired` is
 *     the honest reading at this point: this pass only runs once the batch is
 *     finished, and a line the index has never seen was never posted.
 */
function causeOf(line: LineRow): string | null {
  if (line.job_id === null) return line.skip_reason ?? "skipped";
  if (line.state === null) return "expired";
  if (line.state === 2) return null;
  if (line.state === 1) return "reclaim";
  if (line.state === 0) return "expired";
  return CAUSE[line.ended_because ?? 0] ?? "cancelled";
}

/** Has the chain finished with this line? */
function terminal(line: LineRow, now: bigint): boolean {
  if (line.job_id === null) return true;
  if (line.state === null) return false;
  if (line.state === 2 || line.state === 3) return true;
  return line.expires_at !== null && BigInt(line.expires_at) < now;
}

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));
