import type { Queryable } from "../db/db.js";
import type { LineState } from "./fold.js";
import type { BatchObjectRow } from "./object.js";

/**
 * Reading a batch: the row, and the line states the fold runs over.
 *
 * Kept apart from the routes because the interesting half is the **join**, not
 * the HTTP. A batch's progress is a fold over its member jobs — never a counter —
 * so every read of a batch is this query, and the mapping from a chain job state
 * to a {@link LineState} is the one place that translation is written down.
 */

/** Every column {@link BatchObjectRow} needs, plus what only this node's routes use. */
export interface BatchRecord extends BatchObjectRow {
  owner: Buffer;
}

/**
 * The columns, spelled once. `metadata::text` because the driver would otherwise
 * hand back a parsed object; parsing it here keeps the boundary in one place.
 */
const COLUMNS = `batch_id, owner, endpoint, completion_window, input_file_id,
       output_file_id, error_file_id, status, created_at, expires_at,
       in_progress_at, finalizing_at, completed_at, failed_at, expired_at,
       cancelling_at, cancelled_at, metadata::text AS metadata`;

type RawRow = Omit<BatchRecord, "metadata"> & { metadata: string };

/**
 * `metadata` is parsed with plain `JSON.parse` rather than spliced in raw (R51).
 *
 * The splice exists because a `jsonb` column can hold a number wider than a
 * double — chain evidence does. This one cannot: the create door admits at most
 * 16 keys whose values are **strings**, checked before the insert, so there is no
 * number in it to round.
 */
const parsed = (row: RawRow): BatchRecord => ({
  ...row,
  metadata: JSON.parse(row.metadata) as Record<string, string>,
});

/** One batch, scoped to its owner. A miss and a stranger's batch are the same answer. */
export async function readBatch(
  db: Queryable,
  batchId: string,
  owner: Buffer,
): Promise<BatchRecord | null> {
  const { rows } = await db.query<RawRow>(
    `SELECT ${COLUMNS} FROM batches WHERE batch_id = $1 AND owner = $2`,
    [batchId, owner],
  );
  const row = rows[0];
  return row === undefined ? null : parsed(row);
}

/**
 * One page of a caller's batches, newest first.
 *
 * Ordered on `(created_at, batch_id)` rather than `created_at` alone: two batches
 * created in the same second are otherwise ordered by whatever Postgres returns,
 * and a cursor over an unstable order silently skips or repeats rows. `after`
 * carries the whole pair through the row-wise comparison for the same reason.
 */
export async function listBatches(
  db: Queryable,
  owner: Buffer,
  limit: number,
  after: string | null,
): Promise<BatchRecord[]> {
  if (after === null) {
    const { rows } = await db.query<RawRow>(
      `SELECT ${COLUMNS} FROM batches WHERE owner = $1
        ORDER BY created_at DESC, batch_id DESC LIMIT $2`,
      [owner, limit],
    );
    return rows.map(parsed);
  }
  const { rows } = await db.query<RawRow>(
    `SELECT ${COLUMNS} FROM batches
      WHERE owner = $1
        AND (created_at, batch_id) <
            (SELECT created_at, batch_id FROM batches WHERE batch_id = $2 AND owner = $1)
      ORDER BY created_at DESC, batch_id DESC LIMIT $3`,
    [owner, after, limit],
  );
  return rows.map(parsed);
}

/**
 * What each line of a batch has come to, in input order.
 *
 * Three cases the `CASE` above spells out and a reader should not have to infer:
 *
 *   * **`bl.job_id IS NULL`** — `postMany` answered `PostSkipped` for that line,
 *     so it never became a job. Terminal, and counted as failed: nothing on chain
 *     will ever move it, and a batch whose counts leave it out reads as still
 *     running forever.
 *   * **a `job_id` with no `jobs` row** — the post landed and the index has not
 *     reached it yet. `open`, deliberately: in flight is the safe reading, and it
 *     becomes settled or cancelled a block later.
 *   * **`state = 0` past `expires_at`** — the one job state that is *computed*
 *     rather than stored (`0001_init.sql` says so: nothing writes cause 5 back). A
 *     fold that read the column alone would hold the batch open forever.
 */
export async function batchLineStates(
  db: Queryable,
  batchId: string,
  now: bigint,
): Promise<LineState[]> {
  const { rows } = await db.query<{ state: LineState }>(
    `SELECT CASE
              WHEN bl.job_id IS NULL THEN 'skipped'
              WHEN j.job_id IS NULL  THEN 'open'
              WHEN j.state = 2       THEN 'settled'
              WHEN j.state = 3       THEN 'cancelled'
              WHEN j.state = 1       THEN 'claimed'
              WHEN j.expires_at < $2 THEN 'cancelled'
              ELSE 'open'
            END AS state
       FROM batch_lines bl LEFT JOIN jobs j ON j.job_id = bl.job_id
      WHERE bl.batch_id = $1
      ORDER BY bl.line_no`,
    [batchId, now],
  );
  return rows.map((row) => row.state);
}
