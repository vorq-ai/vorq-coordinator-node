/**
 * `BatchObject` — OpenAI's, unchanged, rendered from a row plus the fold over its lines.
 *
 * The rule this file exists to hold: **every field OpenAI declares keeps OpenAI's name and
 * OpenAI's shape**, and everything VORQ adds lives under `vorq`. That is what lets stock
 * tooling read the surface and ignore the rest.
 */

import { batchStatus, type BatchRequestCounts, type BatchStatus } from "./fold.js";

/** One entry of the input file's own verdict. Per-line failures go to the error file. */
export interface BatchError {
  code: string;
  message: string;
  /** The offending input-file line, when the refusal names one. */
  line: number | null;
}

export interface BatchObjectRow {
  batch_id: string;
  endpoint: string;
  /** Seconds. Rendered back as the `"1h"` / `"24h"` string the caller sent. */
  completion_window: bigint;
  input_file_id: string;
  output_file_id: string | null;
  error_file_id: string | null;
  status: string;
  created_at: bigint;
  expires_at: bigint;
  in_progress_at: bigint | null;
  finalizing_at: bigint | null;
  completed_at: bigint | null;
  failed_at: bigint | null;
  expired_at: bigint | null;
  cancelling_at: bigint | null;
  cancelled_at: bigint | null;
  metadata: Record<string, string>;
}

/**
 * BIGINT columns arrive as `bigint`, which `JSON.stringify` refuses (R46). Unix seconds fit a
 * double for the next ~285 million years, so the narrowing is safe and is done here, once, at
 * the serialisation boundary rather than in each caller.
 */
const seconds = (value: bigint | null): number | null => (value === null ? null : Number(value));

/** The window as a caller spells it. Anything unrecognised is reported verbatim rather than
 *  guessed at — a governance-added window must not be renamed on its way out. */
export function windowLabel(secs: bigint): string {
  if (secs === 3600n) return "1h";
  if (secs === 86400n) return "24h";
  return `${secs}s`;
}

export interface BatchObject {
  id: string;
  object: "batch";
  endpoint: string;
  input_file_id: string;
  completion_window: string;
  status: BatchStatus;
  errors: { object: "list"; data: BatchError[] } | null;
  output_file_id: string | null;
  error_file_id: string | null;
  created_at: number;
  expires_at: number;
  in_progress_at: number | null;
  finalizing_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  expired_at: number | null;
  cancelling_at: number | null;
  cancelled_at: number | null;
  request_counts: { completed: number; failed: number; total: number };
  metadata: Record<string, string>;
  /** Additive. The signed completion window, under VORQ's own key. */
  vorq: { sla: string };
}

export function batchObject(
  row: BatchObjectRow,
  counts: BatchRequestCounts,
  now: bigint,
  error?: BatchError,
): BatchObject {
  return {
    id: row.batch_id,
    object: "batch",
    endpoint: row.endpoint,
    input_file_id: row.input_file_id,
    completion_window: windowLabel(row.completion_window),
    // Derived, never the stored value: the row carries only the stamps the worker owns, and
    // a caller's idea of progress is a fold over the member jobs.
    status: batchStatus(row, counts, now),
    errors: error ? { object: "list", data: [error] } : null,
    output_file_id: row.output_file_id,
    error_file_id: row.error_file_id,
    created_at: Number(row.created_at),
    expires_at: Number(row.expires_at),
    in_progress_at: seconds(row.in_progress_at),
    finalizing_at: seconds(row.finalizing_at),
    completed_at: seconds(row.completed_at),
    failed_at: seconds(row.failed_at),
    expired_at: seconds(row.expired_at),
    cancelling_at: seconds(row.cancelling_at),
    cancelled_at: seconds(row.cancelled_at),
    // `{completed, failed, total}` — **`openai`'s own model**, not the
    // `{processing, succeeded, errored}` triple their autodocs describe.
    //
    // This was very nearly shipped the other way round. The recovery doc read
    // three places in OpenAI's published spec that agree on `processing` /
    // `succeeded` / `errored` and recorded the legacy shape as a correction to
    // make. What settles it is the artifact clients actually run:
    // `openai.types.batch_request_counts.BatchRequestCounts` declares
    // `completed`, `failed` and `total`, **all three required**, so a body in the
    // documented shape does not merely lose a field — `Batch.model_validate`
    // raises on it and every stock Python caller fails at parse. The docs and the
    // package disagree; the package is what the compatibility is with.
    //
    // `total` is on the wire after all, which suits the fold: it counts `total`
    // internally to decide whether every line is terminal, and now says so.
    request_counts: {
      completed: counts.completed,
      failed: counts.failed,
      total: counts.total,
    },
    metadata: row.metadata,
    vorq: { sla: windowLabel(row.completion_window) },
  };
}
