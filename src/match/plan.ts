import type { Queryable } from "../db/db.js";
import { OPEN } from "../api/routes/jobs.js";
import { markAssigned } from "./rank.js";

/**
 * The batch planner: how many lines of a batch each live provider can take,
 * within the network's own limit and the ceilings the lines set.
 *
 * The limit is the chain's: a provider may hold at most `effectiveCap` claimed
 * jobs, and `claim` reverts `AtCapacity` past it. A provider's **budget** is
 * that cap less what it is already committed to — its claimed jobs and the open
 * orders pinned to it — so a plan never books more than the provider could hold
 * at once, and batches and single orders draw on one pool.
 *
 * Allocation is by price: cheapest ask within the ceilings for the summed unit mix first,
 * each provider filled to its budget, equal prices taken least recently named
 * first. Nothing is held: a plan is an answer about now, and the caller seals
 * against it straight away.
 */
export interface PlanRequest {
  modelId: bigint;
  slaSecs: bigint;
  lines: bigint;
  unitsIn: bigint;
  unitsOut: bigint;
  /** The most these lines pay per side; `null` for no ceiling there. */
  maxRateIn: bigint | null;
  maxRateOut: bigint | null;
}

export interface Allotment {
  provider_id: bigint;
  box_key: Buffer;
  rate_in: bigint;
  rate_out: bigint;
  lines: bigint;
}

interface Budget {
  provider_id: bigint;
  box_key: Buffer;
  rate_in: bigint;
  rate_out: bigint;
  free: bigint;
}

/** `bytes32(0)`: a withdrawn identity stores 32 zero bytes, not NULL. */
const ZERO_KEY = Buffer.alloc(32);

async function budgets(
  db: Queryable,
  request: PlanRequest,
  livenessMs: number,
): Promise<Budget[]> {
  const { rows } = await db.query<Budget>(
    `WITH held AS (
       SELECT provider_id, count(*) AS n FROM jobs WHERE state = 1 GROUP BY provider_id
     ), pinned AS (
       SELECT designated AS provider_id, count(*) AS n FROM jobs
        WHERE ${OPEN} AND designated <> 0 GROUP BY designated
     )
     SELECT p.provider_id, p.box_key, a.rate_in, a.rate_out,
            GREATEST(1, p.reputation * LEAST(p.capacity_requested, p.capacity_ceiling) / 1000)
              - COALESCE(h.n, 0) - COALESCE(o.n, 0) AS free
       FROM providers p
       JOIN provider_presence pr ON pr.provider_id = p.provider_id AND pr.model_id = $1
       JOIN asks_chain a ON a.provider_id = p.provider_id AND a.model_id = $1 AND a.sla = $2
       LEFT JOIN held h ON h.provider_id = p.provider_id
       LEFT JOIN pinned o ON o.provider_id = p.provider_id
      WHERE p.listed
        AND (p.allow_all_models OR $1 = ANY(p.allowed_models))
        AND pr.seen_at >= now() - ($3::bigint * interval '1 millisecond')
        AND p.box_key IS NOT NULL AND p.box_key <> $6
        AND ($7::numeric IS NULL OR a.rate_in <= $7::numeric)
        AND ($8::numeric IS NULL OR a.rate_out <= $8::numeric)
      ORDER BY (a.rate_in * $4::numeric + a.rate_out * $5::numeric) ASC,
               pr.last_assigned_at ASC NULLS FIRST,
               p.provider_id ASC`,
    [
      request.modelId.toString(),
      request.slaSecs.toString(),
      livenessMs,
      request.unitsIn.toString(),
      request.unitsOut.toString(),
      ZERO_KEY,
      request.maxRateIn?.toString() ?? null,
      request.maxRateOut?.toString() ?? null,
    ],
  );
  return rows.map((row) => ({ ...row, free: BigInt(row.free) }));
}

/**
 * One allocation per plan entry, in request order. An entry's allocation
 * sums to fewer lines than it asked for when the network cannot take them all;
 * the caller refuses such a batch rather than posting part of it.
 *
 * Budgets are shared across the models of one plan: a provider serving two of
 * them is not counted free twice.
 */
export async function planBatch(
  db: Queryable,
  requests: PlanRequest[],
  options: { livenessMs: number },
): Promise<Allotment[][]> {
  const spent = new Map<bigint, bigint>();
  const plans: Allotment[][] = [];
  for (const request of requests) {
    let wanted = request.lines;
    const allocation: Allotment[] = [];
    for (const budget of await budgets(db, request, options.livenessMs)) {
      if (wanted === 0n) break;
      const pid = BigInt(budget.provider_id);
      const free = budget.free - (spent.get(pid) ?? 0n);
      if (free <= 0n) continue;
      const lines = free < wanted ? free : wanted;
      allocation.push({
        provider_id: pid,
        box_key: budget.box_key,
        rate_in: budget.rate_in,
        rate_out: budget.rate_out,
        lines,
      });
      spent.set(pid, (spent.get(pid) ?? 0n) + lines);
      wanted -= lines;
      await markAssigned(db, pid, request.modelId);
    }
    plans.push(allocation);
  }
  return plans;
}
