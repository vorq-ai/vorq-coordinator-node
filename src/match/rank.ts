import type { Queryable } from "../db/db.js";

/**
 * The challenge's one decision: given a job, which live providers could take
 * it, in what order.
 *
 * A client is shown published asks and only published asks — the daemon's
 * private floor never crosses to this side — so a candidate is a listed
 * provider that polled within the liveness window, has a free slot left after
 * the leases it already holds, publishes an ask for the job's window that
 * clears the job's rates, and has a box key to seal to.
 *
 * A `null` rate is a side with no ceiling: a probe names the ceilings its
 * client set, possibly neither, and every live ask within them ranks. The
 * client then signs the first candidate's own ask pinned to that provider.
 *
 * The order is the whole fairness story: cheapest ask for this job's unit mix
 * first, then the provider that was named least recently — a per-model
 * round-robin cursor that `markAssigned` advances. Between three providers at
 * one price this yields 1, 2, 3, 1, ….
 *
 * The provider poll does not rank at all: it takes the oldest open jobs that
 * clear the floors the caller sent (`match/lease.ts`).
 */
export interface MatchJob {
  modelId: bigint;
  slaSecs: bigint;
  /** `0n` for an open order; otherwise the only provider that may be named. */
  designated: bigint;
  /** The most the job pays per side; `null` on a probe that set no ceiling there. */
  rateIn: bigint | null;
  rateOut: bigint | null;
  unitsIn: bigint;
  unitsOut: bigint;
}

export interface Candidate {
  provider_id: bigint;
  box_key: Buffer | null;
  /** The published ask (R15). */
  rate_in: bigint;
  rate_out: bigint;
}

/** `bytes32(0)`: a withdrawn identity stores 32 zero bytes, not NULL. */
const ZERO_KEY = Buffer.alloc(32);

export async function rankProviders(
  db: Queryable,
  job: MatchJob,
  options: { livenessMs: number; limit: number },
): Promise<Candidate[]> {
  // Every bigint as a string: the driver would otherwise stringify it anyway,
  // and the `::numeric` casts below need text to be exact past 2^53.
  const { rows } = await db.query<Candidate>(
    `WITH live AS (
       SELECT provider_id, count(*) AS n FROM job_leases
        WHERE expires_at > now() GROUP BY provider_id
     )
     SELECT p.provider_id, p.box_key, a.rate_in, a.rate_out
       FROM providers p
       JOIN provider_presence pr ON pr.provider_id = p.provider_id AND pr.model_id = $1
       JOIN asks_chain a ON a.provider_id = p.provider_id AND a.model_id = $1 AND a.sla = $2
       LEFT JOIN live l ON l.provider_id = p.provider_id
      WHERE p.listed
        AND (p.allow_all_models OR $1 = ANY(p.allowed_models))
        AND pr.seen_at >= now() - ($3::bigint * interval '1 millisecond')
        AND ($4::bigint = 0 OR p.provider_id = $4)
        AND pr.free_slots - COALESCE(l.n, 0) > 0
        AND ($8::numeric IS NULL OR a.rate_out <= $8::numeric)
        AND ($9::numeric IS NULL OR a.rate_in <= $9::numeric)
        AND p.box_key IS NOT NULL AND p.box_key <> $10
      ORDER BY (a.rate_in * $5::numeric + a.rate_out * $6::numeric) ASC,
               pr.last_assigned_at ASC NULLS FIRST,
               p.provider_id ASC
      LIMIT $7`,
    [
      job.modelId.toString(),
      job.slaSecs.toString(),
      options.livenessMs,
      job.designated.toString(),
      job.unitsIn.toString(),
      job.unitsOut.toString(),
      options.limit,
      job.rateOut?.toString() ?? null,
      job.rateIn?.toString() ?? null,
      ZERO_KEY,
    ],
  );
  return rows;
}

/**
 * What a provider poll says about itself: the slots it can start, and — by the
 * row's freshness — that it is alive. The round-robin cursor on the same row
 * is deliberately left alone.
 */
export async function upsertPresence(
  db: Queryable,
  presence: { providerId: bigint; modelId: bigint; freeSlots: bigint },
): Promise<void> {
  await db.query(
    `INSERT INTO provider_presence (provider_id, model_id, free_slots, seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (provider_id, model_id) DO UPDATE
       SET free_slots = EXCLUDED.free_slots, seen_at = now()`,
    [presence.providerId.toString(), presence.modelId.toString(), presence.freeSlots.toString()],
  );
}

/**
 * Advances the per-model round-robin cursor: this provider was just named first.
 *
 * `clock_timestamp()`, not `now()`: two challenges inside one transaction would
 * otherwise tie.
 */
export async function markAssigned(db: Queryable, providerId: bigint, modelId: bigint): Promise<void> {
  await db.query(
    "UPDATE provider_presence SET last_assigned_at = clock_timestamp()" +
      " WHERE provider_id = $1 AND model_id = $2",
    [providerId.toString(), modelId.toString()],
  );
}
