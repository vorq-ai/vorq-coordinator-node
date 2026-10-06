import { describe, expect, it } from "vitest";
import { batchCounts, batchStatus, type BatchRow, type LineState } from "../src/batches/fold.js";

/**
 * The fold: a batch's status and counts are computed from its member jobs, never stored.
 *
 * Only two things about a batch are written down — the row's own identity (the window, the
 * file ids) and the few lifecycle stamps the worker owns (`validating`, `failed`,
 * `cancelling_at`). Everything a caller reads as *progress* is derived here from the lines,
 * so no counter exists that could drift from the rows it counts.
 */

const NOW = 1_000_000n;

const row = (over: Partial<BatchRow> = {}): BatchRow => ({
  status: "in_progress",
  expires_at: NOW + 3600n,
  cancelling_at: null,
  // The finalize pass has run. Most cases here are about a finished batch, and one of
  // these three stamps is what says its files exist.
  completed_at: NOW,
  cancelled_at: null,
  expired_at: null,
  ...over,
});

/** `n` lines in the given states. */
const lines = (...states: LineState[]): LineState[] => states;

describe("batchCounts", () => {
  it("counts a settled line as completed and a cancelled one as failed", () => {
    expect(batchCounts(lines("settled", "settled", "cancelled"))).toEqual({
      total: 3,
      completed: 2,
      failed: 1,
    });
  });

  it("counts a line the chain skipped as failed, not as missing", () => {
    // `postMany` answers `PostSkipped` rather than reverting, so a bad line never becomes a
    // job at all. It still has to appear in the totals — a batch of 3 whose counts sum to 2
    // reads as still running, forever.
    expect(batchCounts(lines("settled", "skipped"))).toEqual({ total: 2, completed: 1, failed: 1 });
  });

  it("leaves in-flight lines out of both tallies", () => {
    expect(batchCounts(lines("settled", "open", "claimed"))).toEqual({
      total: 3,
      completed: 1,
      failed: 0,
    });
  });
});

describe("batchStatus", () => {
  it("is validating until the worker has finished posting", () => {
    // The worker owns this one: at 50 000 lines, creation is a background job, and until it
    // has landed the lines there is nothing to fold.
    expect(batchStatus(row({ status: "validating" }), batchCounts(lines()), NOW)).toBe("validating");
  });

  it("is in_progress while any line is still running", () => {
    expect(batchStatus(row(), batchCounts(lines("settled", "claimed")), NOW)).toBe("in_progress");
  });

  it("is completed once every line is terminal", () => {
    expect(batchStatus(row(), batchCounts(lines("settled", "cancelled")), NOW)).toBe("completed");
  });

  it("is completed even when every line failed", () => {
    // "completed" is about the batch having finished, not about the lines having succeeded.
    // OpenAI reports failures per line in the error file; `failed` on the batch means the
    // input file itself was refused.
    expect(batchStatus(row(), batchCounts(lines("cancelled", "skipped")), NOW)).toBe("completed");
  });

  it("is expired past the window while lines are still running", () => {
    const past = NOW + 1n;
    expect(batchStatus(row({ expires_at: NOW }), batchCounts(lines("settled", "claimed")), past))
      .toBe("expired");
  });

  it("is completed rather than expired when the last line landed before the window closed", () => {
    // A batch that finished does not become expired by the clock moving. Terminal is terminal.
    const past = NOW + 10_000n;
    expect(batchStatus(row({ expires_at: NOW }), batchCounts(lines("settled")), past)).toBe("completed");
  });

  it("is cancelling while cancelled lines are still winding down", () => {
    // A line a provider already claimed runs to its own end — settlement, failure, or SLA
    // reclaim — exactly as a standalone claimed job does.
    expect(batchStatus(row({ cancelling_at: NOW }), batchCounts(lines("settled", "claimed")), NOW))
      .toBe("cancelling");
  });

  it("is cancelled once the last in-flight line lands", () => {
    expect(batchStatus(row({ cancelling_at: NOW }), batchCounts(lines("settled", "cancelled")), NOW))
      .toBe("cancelled");
  });

  it("keeps a failed batch failed, whatever the lines say", () => {
    // `failed` is the input file's own verdict — it never became lines at all.
    expect(batchStatus(row({ status: "failed" }), batchCounts(lines()), NOW)).toBe("failed");
  });

  it("prefers cancelling over expired, so the caller's own action is what it reads back", () => {
    const past = NOW + 1n;
    expect(
      batchStatus(row({ cancelling_at: NOW, expires_at: NOW }), batchCounts(lines("claimed")), past),
    ).toBe("cancelling");
  });

  it("treats an empty batch as completed rather than hanging in progress", () => {
    expect(batchStatus(row(), batchCounts(lines()), NOW)).toBe("completed");
  });

  /**
   * **`finalizing` is not decoration, and the belief that it was is what broke.**
   *
   * This fold ran on the read path and reported `completed` the instant the last line
   * settled — but `output_file_id` is written by the worker's *next* finalize pass, which
   * is up to a tick later. Between those two moments a batch answered
   * `{status: "completed", output_file_id: null}`.
   *
   * That is the one shape a stock OpenAI caller cannot survive. Their documented flow is
   * "poll until `completed`, then read `output_file_id`", every caller writes exactly that
   * loop, and it gets `None`. A live run through the `openai` package hit the window on its
   * first attempt.
   *
   * `finalizing` is OpenAI's own name for this instant — "the batch has completed and the
   * results are being prepared" — so the fix is to report it rather than to lie about being
   * finished. The rule: **no status that promises a frozen output file may be returned
   * before there is one.**
   */
  it("is finalizing, not completed, until the worker has frozen the files", () => {
    const done = batchCounts(lines("settled", "settled"));

    expect(batchStatus(row({ completed_at: null }), done, NOW)).toBe("finalizing");
    expect(batchStatus(row({ completed_at: NOW }), done, NOW)).toBe("completed");
  });

  it("is finalizing, not cancelled, until the worker has frozen the files", () => {
    // The same promise: a cancelled batch names an output file for the lines that landed
    // before the cancel reached them, and it is frozen by the same pass.
    const done = batchCounts(lines("settled", "cancelled"));

    expect(batchStatus(row({ cancelling_at: NOW, completed_at: null }), done, NOW))
      .toBe("finalizing");
    expect(batchStatus(row({ cancelling_at: NOW, completed_at: null, cancelled_at: NOW }), done, NOW))
      .toBe("cancelled");
  });

  it("still reports a running batch as in_progress rather than finalizing", () => {
    // `finalizing` names the gap after the last line, not the whole of the run — a batch
    // with a line still in flight has nothing to freeze yet.
    expect(batchStatus(row({ completed_at: null }), batchCounts(lines("settled", "claimed")), NOW))
      .toBe("in_progress");
  });
});
