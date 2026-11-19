import type { Abi, Hex } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import type { Chain, JobView as ChainJobView } from "../chain/client.js";
import type { Address } from "../config.js";
import type { Queryable } from "../db/db.js";

/**
 * Reconcile-on-error: one `getJob` read, and the row it describes brought into
 * line with it.
 *
 * **This is the indexing-lag bridge, not a distrust measure.** The indexer
 * follows the chain a poll behind; every write door answers off its receipt.
 * Between the two sits a window in which the chain has moved and the projection
 * has not. A provider whose `claim` is refused `NotOpen` is being told the truth
 * by the chain while the book is still advertising the job as open. Reconcile is
 * what closes that gap at the moment somebody trips over it, instead of leaving
 * the book wrong until the poll catches up.
 *
 * **Update-only.** `getJob` answers a job's status and claimant — found, state,
 * cause, provider, claim time — and nothing else: the order's terms, owner and
 * CIDs are announced in `Posted` and `Settled` and reach the row through the
 * indexer. So a reconcile writes those four columns onto a row that exists and
 * does nothing else: it never inserts a row it could only half fill, and it
 * never deletes one. A job the chain has no row for is an order nobody has
 * claimed, which lives in this node's database by design (`match/held.ts`).
 */

/** `getJob`'s return, derived from the ABI by the chain client. */
export type JobView = ChainJobView;

/** What one reconcile did. Returned rather than logged so a caller can assert on it. */
export interface ReconcileOutcome {
  /** `getJob().found` — whether the chain has a row for this job. */
  found: boolean;
  /** `updated` when a row took the chain's status, `absent` when there was nothing to write. */
  action: "updated" | "absent";
  /** The block the `eth_call` was pinned to, and the `as_of_block` any write stamped. */
  block: bigint;
}

/** BYTEA parameter from a viem hex string, matching the reducer's `bytea`. */
const bytea = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");

/**
 * Reads `getJob(jobId)` from the chain and writes its status onto the
 * projection's row for it.
 *
 * **The read is pinned to an explicit block, and that block is `latest`.**
 * Pinned, so `as_of_block` is stamped with the block the call actually ran
 * against; `latest`, because chain truth is the only thing worth serving in the
 * finality window — at or behind the cursor a correct reducer has already
 * written exactly what `getJob` would say.
 *
 * A reducer log for an earlier transition can still land after this and move
 * the row back one step (a `Claimed` after this wrote `state = 2`); it heals on
 * the next event in the same replay, and `as_of_block` cannot regress because
 * every write on both sides is `GREATEST`.
 *
 * Chain failures propagate — the caller decides whether an unreachable RPC is
 * its problem. `jobRegistry` is a parameter because `Chain` carries no address
 * book (R39).
 */
export async function reconcileJob(
  chain: Chain,
  db: Queryable,
  jobId: Hex,
  jobRegistry: Address,
): Promise<ReconcileOutcome> {
  const block = await chain.publicClient.getBlockNumber();

  // R77-off-request-path: best-effort repair — `tryReconcileJob` swallows the
  // failure, so this read never turns a caller's 409 into a 503.
  const view = (await chain.publicClient.readContract({
    address: jobRegistry,
    abi: jobRegistryAbi as Abi,
    functionName: "getJob",
    args: [jobId],
    blockNumber: block,
  })) as JobView;

  if (!view.found) return { found: false, action: "absent", block };

  const { rowCount } = await db.query(
    `UPDATE jobs SET state = $2, ended_because = $3, provider_id = $4, claimed_at = $5,
                     as_of_block = GREATEST(as_of_block, $6)
      WHERE job_id = $1`,
    [bytea(jobId), view.state, view.endedBecause, view.providerId, view.claimedAt, block],
  );
  return { found: true, action: rowCount === 1 ? "updated" : "absent", block };
}

/**
 * Reconciles, and swallows everything.
 *
 * Every wiring site is the same shape: a request that has already decided its own
 * answer, taking the opportunity to repair a row on the way out. None of them may
 * fail because the repair did — a `409` that becomes a `503` when the RPC is
 * briefly unreachable would make a write door *less* reliable for having gained
 * a repair path. `report` gets the failure so it reaches the log rather than
 * nothing at all.
 */
export async function tryReconcileJob(
  chain: Chain,
  db: Queryable,
  jobId: Hex,
  jobRegistry: Address,
  report: (error: unknown) => void,
): Promise<ReconcileOutcome | null> {
  try {
    return await reconcileJob(chain, db, jobId, jobRegistry);
  } catch (error) {
    report(error);
    return null;
  }
}

/**
 * The revert names that mean *"the projection is behind the chain about this
 * job"*, and nothing else.
 *
 * `NotOpen` and `NotClaimed` are the two the contracts raise when a job's state
 * has moved past what the caller assumed. A provider daemon reads the book, picks
 * an open job, signs a `Claim`, and is refused `NotOpen` — the chain has already
 * given that job to someone else and the index has not caught up, which is
 * precisely the finality window this exists for. The refusal is the one moment
 * the node *knows* a specific row is stale, so it is the moment to repair it:
 * without it the book keeps offering that job to every other daemon until the
 * poll reaches the `Claimed` log.
 *
 * Deliberately not widened further. `AtCapacity` and `StaleOp` are also
 * refusals, and neither says anything about a job row being wrong —
 * an `AtCapacity` job is still open and the book is still right about it. Reading
 * every `409` as evidence of staleness would turn an unauthenticated refusal into
 * an RPC amplifier that repairs nothing.
 */
export const RECONCILABLE_REVERTS: ReadonlySet<string> = new Set(["NotOpen", "NotClaimed"]);

/**
 * The refusal hook both write doors hang on their chain-failure classifier.
 *
 * Shared rather than written at each call site because the *set* is the rule:
 * `POST /evm/ops` meets `NotOpen` on a claim and `NotClaimed` on a settle or a
 * fail, and the reclaim keeper meets `NotClaimed` too.
 *
 * Awaited by its callers, so the repair has landed before the `409` goes out — a
 * daemon that re-reads the book immediately then sees the truth, which is the
 * whole point of repairing at the refusal rather than on a timer.
 */
export function repairOnRefusal(
  chain: Chain | undefined,
  db: Queryable,
  jobRegistry: Address,
  report: (error: unknown, jobId: Hex, reason: string) => void,
): (jobId: Hex | null) => (reason: string) => Promise<void> {
  return (jobId) => async (reason) => {
    if (jobId === null || chain === undefined) return;
    if (!RECONCILABLE_REVERTS.has(reason)) return;
    await tryReconcileJob(chain, db, jobId, jobRegistry, (error) => report(error, jobId, reason));
  };
}
