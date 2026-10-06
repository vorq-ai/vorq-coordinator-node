/**
 * A batch's progress, derived from its lines rather than stored.
 *
 * Only two kinds of thing about a batch are written down: the row's own identity — the
 * window, the file ids — and the few lifecycle stamps the worker owns (`validating` while
 * it is still posting, `failed` when the input file itself was refused, `cancelling_at`
 * when a caller asked). Everything a caller reads as *progress* is computed here from the
 * member jobs.
 *
 * So nothing here can drift from the rows it counts: `batch_lines` says which job is which
 * line, the chain says what each job came to, and every count is that join. There is no
 * counter to keep and none to repair.
 */

/** What one line of a batch has come to, as far as the chain is concerned. */
export type LineState =
  /** On chain and claimable. */
  | "open"
  /** A provider holds it. */
  | "claimed"
  /** Delivered. */
  | "settled"
  /** Terminal without delivery — owner cancel, provider fail, or SLA reclaim. */
  | "cancelled"
  /** Never became a job: `postMany` answered `PostSkipped` for it. */
  | "skipped";

/** OpenAI's batch status vocabulary, unchanged. */
export type BatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelling"
  | "cancelled";

export interface BatchRow {
  /** The worker-owned stamp: `validating`, `failed`, or anything else (which this ignores). */
  status: string;
  expires_at: bigint;
  cancelling_at: bigint | null;
  /**
   * The three stamps the finalize pass writes, one of which it always writes.
   *
   * They are here because between them they are the only thing that distinguishes "every
   * line has landed" from "there is a file to read". Those are not the same instant, and a
   * status that conflates them promises a caller an `output_file_id` that is still null.
   */
  completed_at: bigint | null;
  cancelled_at: bigint | null;
  expired_at: bigint | null;
}

export interface BatchRequestCounts {
  total: number;
  completed: number;
  failed: number;
}

const TERMINAL: ReadonlySet<LineState> = new Set<LineState>(["settled", "cancelled", "skipped"]);

/**
 * Tally the lines.
 *
 * A **skipped** line counts as failed rather than being left out. It never became a job, so
 * nothing on chain will ever move it — and a batch of three whose counts sum to two reads as
 * still running, forever.
 */
export function batchCounts(lines: readonly LineState[]): BatchRequestCounts {
  let completed = 0;
  let failed = 0;
  for (const line of lines) {
    if (line === "settled") completed += 1;
    else if (line === "cancelled" || line === "skipped") failed += 1;
  }
  return { total: lines.length, completed, failed };
}

/**
 * The status a caller reads, in precedence order.
 *
 * **`finalizing` names the instant between the last line landing and the output file being
 * frozen, and this fold absolutely does run inside it.** It used to claim otherwise, and
 * that claim was the bug: the fold runs on the *read* path, on demand, whenever a caller
 * asks — while the freeze happens on the worker's next pass, up to a tick later. In between,
 * a batch answered `{status: "completed", output_file_id: null}`.
 *
 * That is the one shape a stock OpenAI caller cannot survive: "poll until `completed`, then
 * read `output_file_id`" is what their documentation says and what every caller writes, and
 * it would get `None`. So the rule is that **no status promising a frozen output file is
 * returned before there is one** — until then the honest answer is OpenAI's own word for it.
 */
export function batchStatus(row: BatchRow, counts: BatchRequestCounts, now: bigint): BatchStatus {
  // The input file's own verdict. It never became lines, so there is nothing to fold.
  if (row.status === "failed") return "failed";
  // The worker has not finished landing the lines yet, so the tally below is of a set that is
  // still growing and "0 of 0 done" would read as completed.
  if (row.status === "validating") return "validating";

  const settledOrDead = counts.completed + counts.failed === counts.total;
  // Every line has landed, but the pass that folds them into a file has not run.
  const finalized =
    row.completed_at !== null || row.cancelled_at !== null || row.expired_at !== null;

  // A caller's own cancellation outranks the clock: it asked, and that is what it should read
  // back, even if the window closed while the last claimed lines were winding down.
  if (row.cancelling_at !== null) {
    if (!settledOrDead) return "cancelling";
    return finalized ? "cancelled" : "finalizing";
  }

  // Terminal is terminal. A finished batch does not become expired because time passed —
  // this is checked before the window for exactly that reason. "completed" means the batch
  // finished, not that its lines succeeded; per-line failures live in the error file.
  if (settledOrDead) return finalized ? "completed" : "finalizing";

  if (now > row.expires_at) return "expired";
  return "in_progress";
}
