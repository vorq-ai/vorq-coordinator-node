import type { Db } from "../db/db.js";
import type { Pinner } from "./pinner.js";

/**
 * The file sweep: the one thing in this node that deletes stored bytes.
 *
 * Two rules, because there are two ways stored bytes stop being owed to anyone.
 *
 * **An upload nobody attached.** `POST /v1/files` stamps every row
 * `created_at + FILE_ORPHAN_SECONDS`, and attaching it to a job or a batch moves
 * that to `created_at + FILE_RETENTION_SECONDS`. So an upload whose post never
 * came — a client that changed its mind, a request that failed after the
 * upload — expires five minutes later and goes. A pin behind it is removed only
 * once nothing names it: another `files` row for the same object, a job's
 * `task_cid` or `result_cid`, or a batch line.
 *
 * **Everything past retention.** A pin older than the retention window goes
 * whatever names it. That is what makes retention a real bound rather than the
 * expiry of whichever row happened to point at an object. What keeps it from
 * taking a container out from under a live job is the floor on
 * `FILE_RETENTION_SECONDS`, 259 200 s: the longest a container can still be owed
 * is a post at `t`, an expiry at `t + MAX_EXPIRY_SECONDS`, a claim one second
 * before that with `slaSecs` up to `MAX_SLA_SECONDS`, and a pin created up to
 * `FILE_ORPHAN_SECONDS` before the post — 173 099 s in all.
 *
 * A failure on one object is reported and stepped over — the pin row stays, so
 * the next tick tries again — and nothing throws past {@link startFileSweep}'s
 * `tick`.
 */

/** How often the sweep runs. It bounds only how late a deletion is. */
export const FILE_SWEEP_INTERVAL_MS = 60_000;

/**
 * How many rows either pass takes at a time.
 *
 * Each one is a store round trip, so an unbounded pass over a backlog — a node
 * that was down for a week, or a retention window an operator has just
 * shortened — would run for as long as the backlog takes and hold a connection
 * throughout. The next tick takes the rest, a minute later.
 *
 * One bound for both passes: they do the same per-row work, and a backlog in
 * either arrives for the same reasons.
 *
 * **The rate this implies is an operating limit.** 1000 rows per 60 s tick is
 * ~16.7/s, ~1.44 M/day, and a node expiring files faster than that never drains.
 * The real figure can be lower: the cids in a pass are walked serially, one
 * `stillNamed` query and one store round trip each, so a full batch against a
 * remote store at ~20 ms an object is ~20 s of the interval — and a degraded
 * store can push a pass past 60 s, at which point the re-entrancy guard in
 * {@link startFileSweep} drops the ticks behind it. {@link FileSweepRun.saturated}
 * is how an operator sees that happening rather than inferring it.
 */
export const SWEEP_BATCH = 1000;

/** What one pass did. Returned for the log and for the tests. */
export interface FileSweepRun {
  /** `files` rows deleted because they had expired. */
  expired: number;
  /** Objects removed from the store. */
  removed: number;
  /**
   * Either pass took its full {@link SWEEP_BATCH}, so there is more to take.
   *
   * One saturated pass is ordinary — a burst of expiries, a node that was down.
   * A run of them means the backlog is growing faster than the sweep drains it,
   * which no other signal here would show.
   */
  saturated: boolean;
}

/** Whether anything still names this object. */
async function stillNamed(db: Db, cid: string): Promise<boolean> {
  // **The cid is encoded, never the column decoded.** `task_cid` and `result_cid`
  // are unbounded chain `bytes`: nothing on chain makes them UTF-8, and
  // `convert_from` *raises* on bytes that are not — which would abort the tick
  // after the `files` DELETE had committed, and abort every later tick the same
  // way, for one job posted with arbitrary bytes. `convert_to` cannot fail, and
  // it compares against the column rather than a function of it, so an index on
  // either column is usable.
  const { rows } = await db.query<{ named: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM files WHERE cid = $1)
         OR EXISTS (SELECT 1 FROM jobs
                     WHERE task_cid = convert_to($1, 'UTF8')
                        OR (result_cid <> ''::bytea AND result_cid = convert_to($1, 'UTF8')))
         OR EXISTS (SELECT 1 FROM batch_lines WHERE task_cid = $1) AS named`,
    [cid],
  );
  return rows[0]?.named ?? true;
}

/**
 * One pass. `now` is read once, so every row is judged against one instant.
 */
export async function fileSweepTick(
  db: Db,
  pinner: Pinner,
  retentionSeconds: number,
  onError: (error: unknown, cid?: string) => void,
): Promise<FileSweepRun> {
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;

  /** The object, then the row that names where it lived. Never fatal. */
  const remove = async (cid: string): Promise<void> => {
    try {
      await pinner.remove(cid);
      removed += 1;
    } catch (error) {
      onError(error, cid);
    }
  };

  // The rows first: a file this node no longer keeps is not a file it serves,
  // whatever happens to the object afterwards.
  // Bounded for the same reason the stale-pin pass below is: each surviving cid
  // costs a `stillNamed` query and a store round trip, so an unbounded pass over
  // a backlog — a node that was down for a week, or a retention window an
  // operator has just shortened — runs for as long as the backlog takes while
  // the re-entrancy guard turns every tick behind it into a no-op. The rows are
  // deleted before the objects are, so that pass is also the one a crash part-way
  // through leaves objects behind: bounding it bounds how many.
  //
  // Postgres takes no `LIMIT` on a DELETE, so the rows are chosen by a subquery
  // and joined back on the **primary key**. `ctid` would also work — one snapshot
  // covers both halves, so a concurrent `attachFile` cannot misdirect it — but it
  // is correct only by an MVCC argument, where `file_id` is correct by
  // construction. `FOR UPDATE SKIP LOCKED` is what makes two nodes sweeping the
  // same database take disjoint batches rather than merely non-corrupting ones
  // (several instances against one database is already assumed — see the
  // advisory lock in ../db/db.ts), and `ORDER BY expires_at` drains a backlog
  // oldest-first instead of in physical order.
  const { rows: expired } = await db.query<{ cid: string }>(
    `DELETE FROM files
       USING (SELECT file_id FROM files
               WHERE expires_at <= $1
            ORDER BY expires_at
               LIMIT $2
          FOR UPDATE SKIP LOCKED) AS due
       WHERE files.file_id = due.file_id
   RETURNING files.cid`,
    [now, SWEEP_BATCH],
  );
  for (const cid of new Set(expired.map((row) => row.cid))) {
    if (await stillNamed(db, cid)) continue;
    await remove(cid);
  }

  const { rows: stale } = await db.query<{ cid: string }>(
    "SELECT cid FROM pins WHERE created_at < now() - make_interval(secs => $1) LIMIT $2",
    [retentionSeconds, SWEEP_BATCH],
  );
  for (const { cid } of stale) await remove(cid);

  return {
    expired: expired.length,
    removed,
    saturated: expired.length >= SWEEP_BATCH || stale.length >= SWEEP_BATCH,
  };
}

/**
 * The sweep, on a timer.
 *
 * `unref` so housekeeping cannot hold the process open through a SIGTERM, and a
 * re-entrancy guard because one pass is one store request per object and can
 * outlast the interval. `tick` is exposed for the tests, which drive it directly
 * rather than waiting a minute.
 */
export function startFileSweep(
  db: Db,
  pinner: Pinner,
  retentionSeconds: number,
  /** `cid` names the object that failed; absent means the whole pass did. */
  onError: (error: unknown, cid?: string) => void,
  intervalMs = FILE_SWEEP_INTERVAL_MS,
  /**
   * Every completed pass. The caller logs a saturated one: without it a backlog
   * is invisible until storage costs show it, because a bounded pass that took
   * its full batch looks exactly like an ordinary pass that had nothing left.
   */
  onRun: (run: FileSweepRun) => void = () => {},
): { stop: () => void; tick: () => Promise<FileSweepRun | null> } {
  let running = false;
  const tick = async (): Promise<FileSweepRun | null> => {
    if (running) return null;
    running = true;
    try {
      const run = await fileSweepTick(db, pinner, retentionSeconds, onError);
      onRun(run);
      return run;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick().catch((error: unknown) => onError(error)), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
