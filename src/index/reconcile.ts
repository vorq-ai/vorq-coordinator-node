import type { Abi, Hex } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import type { Chain, JobView as ChainJobView } from "../chain/client.js";
import type { Address } from "../config.js";
import type { Queryable } from "../db/db.js";
import { feeOf, RATE_SCALE } from "../orders.js";

/**
 * Reconcile-on-error: one `getJob` read, and the row it describes brought into
 * line with it.
 *
 * **This is the indexing-lag bridge, not a distrust measure.** The indexer
 * follows the chain a poll behind; every write door answers off its receipt.
 * Between the two sits a window — one `BLOCK_TIME_MS`, ~2 s, plus however long
 * the catch-up takes — in which the chain has moved and the projection has not. A provider
 * whose `claim` is refused `NotOpen` is being told the truth by the chain while
 * the book is still advertising the job as open. Reconcile is what closes that
 * gap at the moment somebody trips over it, instead of leaving the book wrong
 * until the poll catches up.
 *
 * Three rulings shape what it may do, and each of them removes a whole class of
 * behaviour rather than adjusting one:
 *
 *   * **R4a — a COMPLETE row, or none.** `getJob`'s 20 fields carry every NOT
 *     NULL column of `jobs`: `owner`, `c`, `designated`, `modelId`, `rateIn`,
 *     `rateOut`, `unitsIn`, `unitsOut`, `slaSecs`, `expiresAt`, `taskCid`,
 *     `gasFee`. A settled row's `fee` is priced from them and the `feeBps` of
 *     the same block. The only column they do not carry is `posted_block`, which
 *     has `DEFAULT 0`. So
 *     a `found = true` with no row **inserts**, and the rule R4 was reaching for
 *     survives intact: never synthesise a *partial* row, and never create a row
 *     for a job the chain does not have (`found = false` still deletes). Without
 *     the insert, a refusal on a job the index has not reached yet — one this
 *     node did not post, so no write-through row exists — repairs nothing,
 *     because the row it needs does not exist.
 *   * **R3/R43 — openness is never materialised.** `getJob` renders an
 *     expired-but-open job as `state 3 / endedBecause 5`, computed at read time
 *     and stored nowhere. Written back unmapped, the index would disagree with a
 *     rebuild from logs, which produces `0/0` for that same job — the projection
 *     would stop being a pure function of the chain. So the pair is mapped back
 *     before the write, and the `ended_because` CHECK (bounded at 4) is the
 *     backstop that turns a forgotten mapping into an error at the write.
 *   * **R10 — the reducer's cursor is authoritative.** Its operative content is
 *     that no row may exist for a job the chain does not have, and that an event
 *     arriving for a row reconcile already touched is not an orphan: "orphan"
 *     means *no row and no reconcile record*, not merely *no row*. The insert
 *     satisfies both — every row it creates is one `getJob` just confirmed, and
 *     the reducer's `Posted` handler is an upsert, so the log that follows
 *     corrects `posted_block` rather than tripping over the row. See
 *     {@link reconcileJob} on why the read is nonetheless taken at `latest`.
 */

/**
 * `getJob`'s 20-field return (R32).
 *
 * Imported from the chain client rather than written out here: it was a
 * hand-copied interface, and Plan 3's authorisation reads need the same shape,
 * so the second copy would have been the one to drift. The client derives it
 * from the ABI itself, which means a regenerated ABI moves the type rather than
 * silently disagreeing with it.
 */
export type JobView = ChainJobView;

/** What one reconcile did. Returned rather than logged so a caller can assert on it. */
export interface ReconcileOutcome {
  /** `getJob().found` — whether the chain knows this job at all. */
  found: boolean;
  /**
   * What happened to the projection.
   *
   * `inserted` is the one an operator wants to see in a log: the chain had the
   * job and the index did not, which means the log has not been indexed yet
   * (ordinary, and the window this exists to bridge) or the reducer has a gap
   * (not ordinary). Either way the row now exists.
   */
  action: "updated" | "inserted" | "deleted" | "absent";
  /** The block the `eth_call` was pinned to, and the `as_of_block` any write stamped. */
  block: bigint;
}

/**
 * The chain state `getJob` reported, mapped to what the projection stores.
 *
 * Exported for its own test: the `3/5 → 0/0` mapping is the one rule here whose
 * absence is invisible until a rebuild disagrees with a reconcile, and R67 wants
 * a test that goes red when it is deleted rather than a comment saying it exists.
 */
export function storedState(view: Pick<JobView, "state" | "endedBecause">): {
  state: number;
  endedBecause: number;
} {
  // The *only* pair `getJob` derives: `state == Open && block.timestamp >
  // expiresAt` renders as Cancelled/expired (JobRegistry.getJob). Matched on both
  // members, not on the cause alone — a stored 5 has no other origin, and
  // matching loosely here would quietly rewrite a pair that arrives some other
  // way instead of letting the CHECK refuse it.
  if (view.state === 3 && view.endedBecause === 5) return { state: 0, endedBecause: 0 };
  return { state: view.state, endedBecause: view.endedBecause };
}

/**
 * What settlement charged: `_atomicCharge` over the settled count, at most the
 * cap. The count was clamped to `unitsOut` before it was stored, so the cap
 * never bites; the `min` restates the contract rather than relying on that.
 */
function settledCharge(
  view: Pick<JobView, "rateIn" | "unitsIn" | "rateOut" | "unitsOut" | "completionTok">,
): bigint {
  const atomic = (unitsOut: number): bigint => {
    const raw = view.rateIn * BigInt(view.unitsIn) + view.rateOut * BigInt(unitsOut);
    const ceiling = (raw + RATE_SCALE - 1n) / RATE_SCALE;
    return ceiling === 0n ? 1n : ceiling;
  };
  const metered = atomic(view.completionTok);
  const cap = atomic(view.unitsOut);
  return metered > cap ? cap : metered;
}

/** `JobRegistry.feeBps` at `block`, the block the view was read at. */
async function feeBpsAt(chain: Chain, jobRegistry: Address, block: bigint): Promise<number> {
  // R77-off-request-path: as `reconcileJob`'s `getJob` read — a settled row's repair only.
  return (await chain.publicClient.readContract({
    address: jobRegistry,
    abi: jobRegistryAbi as Abi,
    functionName: "feeBps",
    blockNumber: block,
  })) as number;
}

/** BYTEA parameter from a viem hex string, matching the reducer's `bytea`. */
const bytea = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");

/**
 * Reads `getJob(jobId)` from the chain and repairs the projection's row for it.
 *
 * `found = false` deletes the row if one is present. `found = true` upserts: an
 * existing row has its mutable columns brought into line with the view, and a
 * missing one is created whole from it (R4a).
 *
 * **The read is pinned to an explicit block, and that block is `latest`.** Two
 * decisions, and both are load-bearing:
 *
 *   * *Pinned*, so `as_of_block` is stamped with the block the call actually ran
 *     against rather than one inferred around it. An unpinned `eth_call` gives no
 *     way to say which block answered, and a stamp that is a guess is worse than
 *     none — every index-backed response carries it as a promise about freshness.
 *     It costs one `eth_blockNumber`; the `getJob` read itself is still the single
 *     call the brief specifies.
 *   * *`latest`*, because chain truth is the only thing worth serving in the
 *     finality window. Pinning to the cursor instead would satisfy R10's wording
 *     and make the whole mechanism a provable no-op — at or behind the cursor a
 *     correct reducer has already written exactly what `getJob` would say, so
 *     there would be nothing to repair, ever. R10's operative content is that no
 *     row may exist for a job the chain does not have — which the `found` branch
 *     is exactly — and that a log arriving for a row this created is not an
 *     orphan, which the reducer's upsert handles.
 *
 * What that costs, stated rather than hidden: between this write and the poll
 * reaching the same block, a reducer log for an *earlier* transition writes its
 * own absolute `state` and can move the row back one step — a `Claimed` landing
 * after this has already written `state = 2`. It heals on the next event in the
 * same replay, the final state after the cursor passes `block` is identical
 * either way, and `as_of_block` cannot regress because every write on both sides
 * is `GREATEST`. A transient step backwards inside the finality window is the
 * price of serving chain truth inside it; a permanent divergence is not possible.
 *
 * Never throws on the database side of a miss. A reconcile is a repair attempt
 * bolted to somebody else's request, and turning that request's answer into a 500
 * because the repair found nothing would be strictly worse than the stale row it
 * was trying to fix. Chain failures do propagate — the caller decides whether an
 * unreachable RPC is its problem.
 *
 * `jobRegistry` is a parameter the brief's `reconcileJob(chain, db, jobId)`
 * signature omits: `Chain` carries a client and a relayer, never an address book,
 * and `Config.addresses` is the only source for the registry (R39).
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

  const key = bytea(jobId);

  if (!view.found) {
    // The chain has never heard of this job, so neither may the index. Reachable
    // in practice only through a projection that outlived its chain — a database
    // kept across a devnet reset is the ordinary case — and it is precisely then
    // that a row nothing will ever move again needs removing, because no replay
    // will delete it: a rebuild rebuilds what the logs say, and these logs are
    // gone.
    const { rowCount } = await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    return { found: false, action: rowCount === 1 ? "deleted" : "absent", block };
  }

  const { state, endedBecause } = storedState(view);
  // The protocol fee settlement took travels in `Settled` and nowhere in the
  // view, so a settled row is priced the way `_distribute` priced it, at the
  // `feeBps` of the same block. A `setFees` between the settle and this block
  // can make it differ; the reducer's `Settled` writes the logged fee over it.
  const fee =
    state === 2 ? feeOf(settledCharge(view), await feeBpsAt(chain, jobRegistry, block)) : 0n;

  // One statement, and an upsert rather than an UPDATE-then-INSERT pair: the
  // reducer can land this job's `Posted` between the two halves of a pair, and a
  // repair that races the writer it is repairing for is not a repair.
  //
  // **`posted_block` is deliberately absent from the column list and takes its
  // `DEFAULT 0`.** The view cannot supply it — it is the block the `Posted` log
  // sat in, which is exactly the log that has not arrived — and the reducer
  // corrects it on arrival, because its `Posted` handler is an upsert whose DO
  // UPDATE set includes `posted_block`. Plan 3's escrow-orphan filter reads this
  // column: **`posted_block = 0` there means "this row was inserted ahead of its
  // log", not a block number**, and a filter that treats it as a block number
  // will read every such row as posted at genesis.
  //
  // On conflict only the mutable columns are written, which is the UPDATE this
  // used to be, unchanged. `model_id` and `c` are in that set even though
  // nothing on chain can change either after `post`: they are the two members
  // that would expose a row built from the wrong job, and writing what the view
  // says costs nothing. The rest — `owner`, the rates, the units, `expires_at`,
  // `task_cid`, `designated`, `sla_secs`, `posted_block` — belong to the reducer
  // once a row exists, so an existing row keeps them.
  //
  // `xmax = 0` is Postgres' own answer to "did this upsert insert or update":
  // an INSERT's tuple has no updating transaction, a DO UPDATE's does.
  const { rows } = await db.query<{ inserted: boolean }>(
    `INSERT INTO jobs (
       job_id, owner, c, model_id, sla_secs, designated,
       rate_in, rate_out, units_in, units_out, expires_at,
       state, ended_because, provider_id, claimed_at, completion_tok,
       task_cid, result_cid, as_of_block, gas_fee, fee
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (job_id) DO UPDATE SET
       state = EXCLUDED.state, ended_because = EXCLUDED.ended_because,
       provider_id = EXCLUDED.provider_id, claimed_at = EXCLUDED.claimed_at,
       completion_tok = EXCLUDED.completion_tok, result_cid = EXCLUDED.result_cid,
       fee = EXCLUDED.fee,
       model_id = EXCLUDED.model_id, c = EXCLUDED.c,
       as_of_block = GREATEST(jobs.as_of_block, EXCLUDED.as_of_block)
     RETURNING (xmax = 0) AS inserted`,
    [
      key, // $1  job_id
      bytea(view.owner), // $2  owner
      bytea(view.c), // $3  c
      view.modelId, // $4  model_id
      view.slaSecs, // $5  sla_secs
      view.designated, // $6  designated
      // NUMERIC columns, and the uint128 rates do not fit a double (R48/R49):
      // handed over as decimal strings, exactly as the reducer does.
      view.rateIn.toString(), // $7  rate_in
      view.rateOut.toString(), // $8  rate_out
      view.unitsIn, // $9  units_in
      view.unitsOut, // $10 units_out
      view.expiresAt, // $11 expires_at
      state, // $12 state
      endedBecause, // $13 ended_because
      view.providerId, // $14 provider_id
      view.claimedAt, // $15 claimed_at
      view.completionTok, // $16 completion_tok
      bytea(view.taskCid), // $17 task_cid
      bytea(view.resultCid), // $18 result_cid
      block, // $19 as_of_block
      view.gasFee.toString(), // $20 gas_fee
      fee.toString(), // $21 fee
    ],
  );

  return { found: true, action: rows[0]?.inserted === true ? "inserted" : "updated", block };
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
 * `UnknownJob` is the third, and it says the strongest version of the same
 * thing: the chain has no such job at all while the book is advertising one
 * (`JobRegistry.claim` raises it on `owner == address(0)`). The row it repairs is
 * the one write-through can leave behind — a row written from a `latest` receipt
 * whose transaction a reorg then orphaned — and `reconcileJob`'s `found = false`
 * branch is what deletes it.
 *
 * It is **not** the main repair for those rows, and reading it as one would be a
 * mistake: the shipped daemon calls `POST /evm/simulate/claim` before it signs
 * and treats a refusal as a skip, so a phantom is normally found and dropped
 * there (`dropUnconfirmed`, wired into that route's `found = false` branch) and
 * this set is never consulted. What this name covers is the narrower case of a
 * `claim` relayed without that advisory simulate — an operator's own tooling, or
 * a daemon that lost the race between the two calls.
 *
 * Deliberately not widened further. `AtCapacity`, `StaleOp` and `DuplicateJob`
 * are also refusals, and none of them says anything about a job row being wrong —
 * an `AtCapacity` job is still open and the book is still right about it. Reading
 * every `409` as evidence of staleness would turn an unauthenticated refusal into
 * an RPC amplifier that repairs nothing.
 */
export const RECONCILABLE_REVERTS: ReadonlySet<string> = new Set([
  "NotOpen",
  "NotClaimed",
  "UnknownJob",
]);

/**
 * The refusal hook both write doors hang on their chain-failure classifier.
 *
 * Shared rather than written twice because the *set* is the rule: `POST /evm/ops`
 * meets `NotOpen` from the provider's side and `POST /v1/jobs/{id}/cancel` meets
 * it from the client's, and two copies of a set like this drift the first time
 * one door learns about a new revert name.
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
