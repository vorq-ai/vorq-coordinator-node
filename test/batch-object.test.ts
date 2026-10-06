import { describe, expect, it } from "vitest";
import { batchObject, type BatchObjectRow } from "../src/batches/object.js";
import { batchCounts, type LineState } from "../src/batches/fold.js";

/**
 * `BatchObject` is OpenAI's, unchanged. Everything VORQ adds lives under `vorq`, so stock
 * tooling reads the surface and ignores the rest.
 */

const NOW = 1_000_000n;

const row = (over: Partial<BatchObjectRow> = {}): BatchObjectRow => ({
  batch_id: "batch_abc",
  endpoint: "/v1/responses",
  completion_window: 86400n,
  input_file_id: "file-in",
  output_file_id: null,
  error_file_id: null,
  status: "in_progress",
  created_at: NOW,
  expires_at: NOW + 86400n,
  in_progress_at: NOW + 1n,
  finalizing_at: null,
  completed_at: null,
  failed_at: null,
  expired_at: null,
  cancelling_at: null,
  cancelled_at: null,
  metadata: {},
  ...over,
});

const at = (...states: LineState[]) => batchCounts(states);

describe("batchObject", () => {
  it("carries every field OpenAI's batch object declares", () => {
    const out = batchObject(row(), at("settled", "claimed"), NOW);

    expect(out.id).toBe("batch_abc");
    expect(out.object).toBe("batch");
    expect(out.endpoint).toBe("/v1/responses");
    expect(out.input_file_id).toBe("file-in");
    for (const key of [
      "errors", "output_file_id", "error_file_id", "created_at", "expires_at",
      "in_progress_at", "finalizing_at", "completed_at", "failed_at", "expired_at",
      "cancelling_at", "cancelled_at", "request_counts", "metadata",
    ]) {
      expect(out).toHaveProperty(key);
    }
  });

  it("reports counts as completed/failed/total — what the openai package models", () => {
    // NOT {processing, succeeded, errored}, which is what OpenAI's published spec,
    // its reference example and its Python quick-reference all describe. The
    // artifact clients actually run disagrees with all three:
    // `openai.types.batch_request_counts.BatchRequestCounts` declares `completed`,
    // `failed` and `total`, every one of them required, so a body in the
    // documented shape makes `Batch.model_validate` raise. The package is what
    // the compatibility is with; `tests/test_openai_shape.py` in the client SDK
    // is where that is asserted against the real thing rather than restated here.
    expect(batchObject(row(), at("settled", "settled", "cancelled", "claimed"), NOW).request_counts)
      .toEqual({ completed: 2, failed: 1, total: 4 });
  });

  it("counts a chain-skipped line as failed", () => {
    expect(batchObject(row(), at("settled", "skipped"), NOW).request_counts)
      .toEqual({ completed: 1, failed: 1, total: 2 });
  });

  it("renders the completion window back as the string a caller sent", () => {
    expect(batchObject(row({ completion_window: 86400n }), at(), NOW).completion_window).toBe("24h");
    expect(batchObject(row({ completion_window: 3600n }), at(), NOW).completion_window).toBe("1h");
  });

  it("emits timestamps as numbers and nulls, never as bigints", () => {
    // A bigint cannot be handed to JSON.stringify (R46), and these columns are BIGINT.
    const out = batchObject(row({ completed_at: NOW + 5n }), at("settled"), NOW);
    expect(typeof out.created_at).toBe("number");
    expect(out.completed_at).toBe(Number(NOW + 5n));
    expect(out.failed_at).toBeNull();
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("puts the derived status on the object, not the stored one", () => {
    // The row still says in_progress; every line is terminal and the finalize pass has
    // stamped it, so the caller reads completed. Both halves are needed — the stamp is
    // what says the output file exists, and `completed` is a promise that it does.
    expect(batchObject(row({ status: "in_progress", completed_at: NOW }), at("settled"), NOW).status)
      .toBe("completed");
  });

  it("adds the VORQ window under its own key and nowhere else", () => {
    const out = batchObject(row(), at(), NOW);
    expect(out.vorq).toEqual({ sla: "24h" });
  });

  it("reports errors as null when the input file was accepted", () => {
    expect(batchObject(row(), at("settled"), NOW).errors).toBeNull();
  });

  it("names the refusal in errors when the input file itself failed", () => {
    // Per-line runtime failures go to the error file; `errors` is the input file's verdict.
    const out = batchObject(
      row({ status: "failed", failed_at: NOW + 2n }),
      at(),
      NOW,
      { code: "empty_file", message: "The input file contains no requests.", line: null },
    );
    expect(out.status).toBe("failed");
    expect(out.errors).toEqual({
      object: "list",
      data: [{ code: "empty_file", message: "The input file contains no requests.", line: null }],
    });
  });
});
