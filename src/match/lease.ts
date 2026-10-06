import type { Queryable } from "../db/db.js";

/**
 * The provider poll's side of the matcher: a work queue with a visibility
 * timeout, where the worker states its own acceptance criteria on each receive.
 *
 * A provider that polls `GET /evm/jobs?state=Open&model=…&free=N` is handed the
 * N oldest open jobs of that model that nobody currently holds, that it may
 * claim (open, or designated to it), and that pass the filters it sent — its
 * floors, and the node's own orphan clause — for `MATCH_LEASE_MS`. Only that
 * provider sees those jobs on its poll; if it has not claimed by the time the
 * lease lapses, the next poller takes them. A dead or declining provider
 * therefore costs a job one lease window and nothing else.
 *
 * Advisory throughout. The chain accepts the first valid `claim` whoever sends
 * it, so a lease is a recommendation the contract never sees.
 *
 * Multi-process safe by construction: the selection is `FOR UPDATE SKIP
 * LOCKED`, so two nodes on one database consider disjoint rows, and the lease
 * is inserted `ON CONFLICT DO NOTHING`, so a job can never hold two — whoever
 * wrote first keeps it.
 */
export interface LeaseRequest {
  providerId: bigint;
  /** Slots the caller can start now. Leases it already holds count against it. */
  free: bigint;
  leaseMs: number;
  /** The book read's own WHERE clause — `OPEN`, the model, the floors, the orphan clause. */
  filter: string;
  params: unknown[];
}

/** How many new leases the call wrote. */
export async function leaseOpenJobs(tx: Queryable, request: LeaseRequest): Promise<number> {
  const me = request.providerId.toString();
  const base = request.params.length;

  // Lapsed leases go first, so a job somebody sat on is offered again.
  await tx.query("DELETE FROM job_leases WHERE expires_at <= now()");

  // What the caller still holds on this book counts against `free`: a daemon
  // that polls twice before claiming is not handed twice its slots.
  const held = await tx.query<{ n: bigint }>(
    `SELECT count(*) AS n FROM jobs WHERE ${request.filter}
        AND job_id IN (SELECT job_id FROM job_leases
                        WHERE provider_id = $${base + 1}::bigint AND expires_at > now())`,
    [...request.params, me],
  );
  const take = request.free - (held.rows[0]?.n ?? 0n);
  if (take <= 0n) return 0;

  const { rowCount } = await tx.query(
    `WITH picked AS (
       SELECT job_id FROM jobs
        WHERE ${request.filter}
          AND designated IN (0, $${base + 1}::bigint)
          AND NOT EXISTS (
            SELECT 1 FROM job_leases l WHERE l.job_id = jobs.job_id AND l.expires_at > now())
        ORDER BY posted_block, job_id
        LIMIT $${base + 2}::bigint
        FOR UPDATE SKIP LOCKED
     )
     INSERT INTO job_leases (job_id, provider_id, offered_at, expires_at)
     SELECT job_id, $${base + 1}::bigint, now(), now() + ($${base + 3}::bigint * interval '1 millisecond')
       FROM picked
     ON CONFLICT (job_id) DO NOTHING`,
    [...request.params, me, take.toString(), request.leaseMs],
  );
  return rowCount ?? 0;
}
