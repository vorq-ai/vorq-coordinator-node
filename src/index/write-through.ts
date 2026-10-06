import type { Log } from "viem";
import type { Address } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import { decodeLog, type ChainEvent, type RawLog } from "./decode.js";
import { applyEvent } from "./reducer.js";

/**
 * Write-through: the `jobs` rows a mined post created, written from its own
 * receipt instead of waiting for the indexer to reach it.
 *
 * **This is what closes the finality window for readers.** Both post doors
 * answer off a receipt the instant it lands, while the indexer reaches that
 * block a poll later, so without it a client polling straight after its `201`
 * reaches the index before the log does. Writing here means `GET /v1/jobs/{id}` never has to ask the
 * chain on a miss: a miss is a `404` and nothing else.
 *
 * `Posted` only, applied through the reducer's own arm, so a row written here is
 * byte-identical to the one a replay writes — `posted_block` included — and the
 * indexed log that follows lands on it as the idempotent upsert it already
 * is. Every other arm is an update behind `updateOne`'s orphan check and stays
 * the indexer's. The cursor is never touched: this applies events, it does not
 * claim a range.
 *
 * `registry` must be the JobRegistry, exactly as the indexer filters its
 * `eth_getLogs`: a receipt carries every contract's logs, and only the
 * registry's `Posted` is a job.
 *
 * **Precondition: every log in `logs` was mined in `blockNumber`.** Each event is
 * stamped with the parameter rather than with `log.blockNumber`, which is what
 * `reduceRange` uses — correct here because a receipt is one transaction and a
 * transaction is one block, and wrong the moment a caller passes logs it gathered
 * across blocks.
 *
 * **The receipt is at `latest`, so these rows are reorg-able, and that is a cost
 * this takes on deliberately.** The indexer writes only mined logs it has
 * guarded against a reorg precisely
 * because "a reorg-able row in the book is a lie that outlives the reorg"
 * (`chain/client.ts`), and every row written here is one whose transaction a
 * reorg could still orphan — previously only a row somebody asked for by id
 * could be in that state, through `reconcileJob`, and now it is every job this
 * node posts. What makes it acceptable is that the lie is bounded and repairable,
 * and it is worth naming exactly which paths do the repairing, because one
 * obvious candidate does not:
 *
 *   * A **re-mined** post — the ordinary outcome, since a reorged transaction
 *     returns to the mempool under the same nonce — replays the same `Posted`
 *     over the same row: `posted_block` wins from the log and `as_of_block` is a
 *     `GREATEST`, so nothing is left to repair.
 *   * A post that never re-mines leaves a phantom, and the first daemon to
 *     consider it deletes it: `POST /evm/simulate/claim` reads `getJob` at
 *     `latest`, finds `found = false`, and drops the row through
 *     {@link dropUnconfirmed}. That is the path that actually fires, because the
 *     shipped daemon simulates before it signs and treats a refusal as a skip —
 *     so the `UnknownJob` entry in `RECONCILABLE_REVERTS` catches only the
 *     narrower case of a claim relayed without the advisory simulate.
 *   * The owner's own `cancel` repairs **nothing**, and cannot be made to:
 *     `JobRegistry.cancel` has no `UnknownJob` branch, so an unknown job (whose
 *     `owner` is `address(0)`) reverts `NotTheOwner` — the same refusal a
 *     stranger poking at somebody else's job gets. Making that reconcilable would
 *     hand any caller a delete probe against any `job_id`, which is the unbounded
 *     chain-read surface this whole change removed.
 *   * Failing all of it, the phantom still leaves the open book at its own
 *     `expires_at` (`OPEN` in `api/routes/jobs.ts` requires `expires_at >= now`),
 *     so an unrepaired one is bounded by the order's own deadline rather than
 *     permanent.
 *
 * Throws on a database failure; callers answering a mined transaction swallow
 * it, because the reducer writes the same row at finality regardless.
 */
export async function writePostedRows(
  db: Db,
  registry: Address,
  logs: readonly (RawLog & Pick<Log, "address">)[],
  blockNumber: bigint,
): Promise<number> {
  const posted = logs
    .filter((log) => log.address.toLowerCase() === registry.toLowerCase())
    .map((log) => decodeLog(log))
    .filter((event): event is ChainEvent => event?.eventName === "Posted");
  if (posted.length === 0) return 0;

  await db.tx(async (tx) => {
    for (const event of posted) await applyEvent(tx, event, blockNumber);
  });
  return posted.length;
}

/**
 * The SQL predicate for a row the chain has not confirmed yet: written ahead of
 * the indexer, so still reorg-able.
 *
 * One constant with two readers on opposite sides of it — {@link dropUnconfirmed}
 * repairs only these, and the duplicate pre-check on `POST /v1/jobs` refuses only
 * their complement — so the two can never drift into disagreeing about which rows
 * count as the chain's word.
 *
 * `COALESCE(..., 0)` covers a node that has indexed nothing yet. `posted_block`
 * is `DEFAULT 0`, which is what a `reconcileJob` insert leaves (the view carries
 * no block), and `0 > 0` is false — so a reconcile-inserted row reads as
 * confirmed, which it is: a `getJob` at `latest` is what created it.
 */
export const UNCONFIRMED =
  "posted_block > COALESCE((SELECT block_number FROM cursor WHERE id = 1), 0)";

/**
 * Deletes a job row the chain says does not exist, but only if the indexer has
 * not confirmed it — the repair for a write-through row whose post was orphaned.
 *
 * The guard is the whole point. A caller reaching this has read `found = false`
 * from **one** endpoint, and a row at or behind the cursor was written from a
 * log the indexer applied; if such a row and that read disagree, the likelier story is an
 * RPC endpoint lagging behind its own chain than a reorg deeper than finality,
 * and deleting on it would let one stale endpoint empty the book. Ahead of the
 * cursor there is no such doubt: nothing but this node's own `latest` receipt
 * wrote that row, and the chain is now saying that receipt did not survive.
 *
 * Returns whether a row was removed, so a caller can log a repair that happened
 * rather than one it attempted.
 */
export async function dropUnconfirmed(db: Queryable, jobId: Buffer): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM jobs WHERE job_id = $1 AND ${UNCONFIRMED}`,
    [jobId],
  );
  return (rowCount ?? 0) > 0;
}
