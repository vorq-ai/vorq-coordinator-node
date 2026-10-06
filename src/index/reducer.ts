import { hexToBytes, type Hex, type Log } from "viem";
import type { Db, Queryable } from "../db/db.js";
import { decodeLog, jsonbFromBytes, textFromChainString, type ChainEvent } from "./decode.js";

/**
 * Logs in, projection out — the whole correctness surface of the read API.
 *
 * Two properties hold everything else up:
 *
 *   * **Purity.** The projection is a function of the chain and nothing else.
 *     No clock decides anything here: openness is `state = 0 AND expires_at >
 *     now` at query time, and ended cause 5 (expired) is derived at read time
 *     exactly as `getJob` derives it, never stored — the `ended_because` CHECK
 *     is bounded at 4 so that stays an invariant the database enforces (R43).
 *   * **Idempotence.** A crash rolls the transaction back and the same range is
 *     replayed on the next poll, so no apply may append, increment, or depend in
 *     any way on how many times it has run. Every write below is an upsert, an
 *     absolute assignment, or a `GREATEST` — never a delta. `GREATEST` earns its
 *     place on the same footing: `max` of the same value is that value, so
 *     re-applying changes nothing.
 *
 * `pins` and `quotes_live` are not derived from the chain and are never touched
 * from here (R44).
 */

/** BYTEA parameter from a viem hex string. */
const bytea = (hex: Hex): Buffer => Buffer.from(hexToBytes(hex));

/**
 * A `uint128` as the decimal string a `NUMERIC` column takes, so the value
 * never passes through `Number` on its way in.
 */
const numeric = (value: bigint): string => value.toString();

/**
 * The `jsonb` a chain `bytes` member becomes: the log's own text when Postgres
 * will take it, `{"raw":"0x…"}` when it will not.
 *
 * `pg_input_is_valid` asks the `jsonb` input function itself, which is what
 * makes this a real acceptance test rather than an imitation of one — a JS
 * screen can only ever cover the malformed shapes someone thought of, and both
 * `{"a":"\ud800"}` and `{"n":1e1000000000}` sail through `JSON.parse` and are
 * refused by Postgres (R50). Either would wedge the indexer permanently, and
 * `setIdentity` is signature-only, so any registered provider can send one.
 *
 * The cast is applied to the CASE's *result* and never inside a branch. A
 * conditional `$3::jsonb` is not safe: the planner may fold a parameter's cast
 * ahead of the condition and raise the very error the guard exists to avoid.
 *
 * The placeholder positions are arguments rather than baked in, so a third call
 * site that happens to bind them elsewhere cannot silently read the wrong
 * parameters. They are integers written at the call site next to the parameter
 * list they describe, never anything derived from a log.
 *
 * The depth bound in {@link jsonbFromBytes} runs before this, because a payload
 * nested past the parser's recursion guard makes `pg_input_is_valid` itself
 * raise (R50a).
 */
const jsonbOrRaw = (candidate: number, raw: number): string =>
  `(CASE WHEN pg_input_is_valid($${candidate}, 'jsonb') THEN $${candidate} ELSE $${raw} END)::jsonb`;

/**
 * Runs an update that must land on exactly one existing row, and throws when it
 * lands on none.
 *
 * Cold start replays every topic from `deploy_block` filtered to the three VORQ
 * contracts, so a `Claimed` is always preceded in-range by its `Posted` and a
 * registry event by the registration that created its row. A miss is therefore a
 * bug in the reducer or a gap in the log stream, never an ordinary condition.
 * It cannot be a reconcile race either: reconcile only ever updates, never
 * inserts, and only at or behind this cursor, so a row reconcile has touched is
 * a row this reducer already created (R4, R10).
 */
async function updateOne(
  db: Queryable,
  sql: string,
  params: readonly unknown[],
  orphan: string,
): Promise<void> {
  const { rowCount } = await db.query(sql, params);
  if (rowCount !== 1) {
    throw new Error(
      `${orphan}: the projection has no such row. The index is replayed in full from ` +
        "the deploy block, so this event should have been preceded by the one that " +
        "creates it — the log stream has a gap.",
    );
  }
}

/**
 * Applies one decoded event to the projection.
 *
 * `db` is the transaction handle from {@link reduceRange}; nothing here opens a
 * transaction of its own, because the cursor and the rows it accounts for must
 * commit together or not at all.
 */
export async function applyEvent(
  db: Queryable,
  event: ChainEvent,
  blockNumber: bigint,
): Promise<void> {
  switch (event.eventName) {
    // -- JobRegistry ------------------------------------------------------
    case "Posted": {
      const a = event.args;
      // The lifecycle columns are deliberately absent from the conflict clause.
      // A job id can only be posted once on chain, so the only way this row
      // already exists is a replay of a range that also carries the events that
      // moved it on; resetting `state` here would make the outcome depend on
      // where the replayed range happens to start.
      //
      // `posted_block` is the log's own block number: Plan 3's escrow-orphan
      // filter needs it, and it rides on the log, so no extra RPC.
      //
      // `as_of_block` only ever climbs. It is monotone today because the cursor
      // never re-reads a committed range, but that is the caller's discipline,
      // not this statement's — `GREATEST` makes the guarantee local, so a
      // re-applied `Posted` cannot date a row back behind the `Claimed` that
      // already advanced it.
      await db.query(
        `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated,
                           rate_in, rate_out, units_in, units_out, expires_at,
                           task_cid, posted_block, as_of_block, gas_fee)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
         ON CONFLICT (job_id) DO UPDATE SET
           owner = EXCLUDED.owner, c = EXCLUDED.c, model_id = EXCLUDED.model_id,
           sla_secs = EXCLUDED.sla_secs, designated = EXCLUDED.designated,
           rate_in = EXCLUDED.rate_in, rate_out = EXCLUDED.rate_out,
           units_in = EXCLUDED.units_in, units_out = EXCLUDED.units_out,
           expires_at = EXCLUDED.expires_at, task_cid = EXCLUDED.task_cid,
           posted_block = EXCLUDED.posted_block, gas_fee = EXCLUDED.gas_fee,
           as_of_block = GREATEST(jobs.as_of_block, EXCLUDED.as_of_block)`,
        [
          bytea(a.jobId),
          bytea(a.owner),
          bytea(a.c),
          a.modelId,
          a.slaSecs,
          a.designated,
          numeric(a.rateIn),
          numeric(a.rateOut),
          a.unitsIn,
          a.unitsOut,
          a.expiresAt,
          bytea(a.taskCid),
          blockNumber,
          numeric(a.gasFee),
        ],
      );
      return;
    }

    case "Claimed": {
      const a = event.args;
      await updateOne(
        db,
        `UPDATE jobs SET state = 1, provider_id = $2, claimed_at = $3,
                         as_of_block = GREATEST(as_of_block, $4)
         WHERE job_id = $1`,
        [bytea(a.jobId), a.provider, a.claimedAt, blockNumber],
        `Claimed for job ${a.jobId}`,
      );
      return;
    }

    case "Settled": {
      const a = event.args;
      // Cause 1 is settlement's own cause and appears in no `Ended` event (R34):
      // it is written here, alongside the state that earns it.
      await updateOne(
        db,
        `UPDATE jobs SET state = 2, ended_because = 1, completion_tok = $2,
                         result_cid = $3, fee = $5, as_of_block = GREATEST(as_of_block, $4)
         WHERE job_id = $1`,
        [bytea(a.jobId), a.completionTok, bytea(a.resultCid), blockNumber, numeric(a.fee)],
        `Settled for job ${a.jobId}`,
      );
      return;
    }

    case "Ended": {
      const a = event.args;
      // The cause travels through unexamined. On chain `Ended` only ever carries
      // 2 (cancelled), 3 (provider_fail) or 4 (reclaim); 1 belongs to `Settled`
      // and 5 is read-time only. The `ended_because` CHECK is the single place
      // that vocabulary is enforced, so anything outside it fails at the write
      // rather than being silently normalised into something plausible (R43).
      await updateOne(
        db,
        `UPDATE jobs SET state = 3, ended_because = $2,
                         as_of_block = GREATEST(as_of_block, $3)
         WHERE job_id = $1`,
        [bytea(a.jobId), a.cause, blockNumber],
        `Ended for job ${a.jobId}`,
      );
      return;
    }

    // -- ProviderRegistry -------------------------------------------------
    case "ProviderRegistered": {
      const a = event.args;
      // The row every other provider event updates. `register` emits this first
      // and then `ListedChanged`, `CapacityChanged` and `ReputationChanged` in
      // the same transaction, so the defaults it lands on are immediately
      // overwritten by real values.
      await db.query(
        `INSERT INTO providers (provider_id, operator) VALUES ($1, $2)
         ON CONFLICT (provider_id) DO UPDATE SET operator = EXCLUDED.operator`,
        [a.providerId, bytea(a.operator)],
      );
      return;
    }

    case "OperatorChanged": {
      const a = event.args;
      await updateOne(
        db,
        "UPDATE providers SET operator = $2 WHERE provider_id = $1",
        [a.providerId, bytea(a.operator)],
        `OperatorChanged for provider ${a.providerId}`,
      );
      return;
    }

    case "ListedChanged": {
      const a = event.args;
      await updateOne(
        db,
        "UPDATE providers SET listed = $2 WHERE provider_id = $1",
        [a.providerId, a.listed],
        `ListedChanged for provider ${a.providerId}`,
      );
      return;
    }

    case "CapacityChanged": {
      const a = event.args;
      await updateOne(
        db,
        "UPDATE providers SET capacity_ceiling = $2, capacity_requested = $3 WHERE provider_id = $1",
        [a.providerId, a.ceiling, a.requested],
        `CapacityChanged for provider ${a.providerId}`,
      );
      return;
    }

    case "ReputationChanged": {
      const a = event.args;
      // The event carries the clamped result, never a delta — which is exactly
      // what makes replaying it any number of times give the same answer.
      await updateOne(
        db,
        "UPDATE providers SET reputation = $2 WHERE provider_id = $1",
        [a.providerId, a.milli],
        `ReputationChanged for provider ${a.providerId}`,
      );
      return;
    }

    case "AllowedModelsChanged": {
      const a = event.args;
      // A full replacement, not a merge. On chain `setAllowedModels` bumps a
      // per-provider epoch and writes the new list against it, orphaning every
      // earlier entry, so the event is self-contained and appending to the
      // column would both diverge from the chain and break replay.
      await updateOne(
        db,
        "UPDATE providers SET allow_all_models = $2, allowed_models = $3 WHERE provider_id = $1",
        [a.providerId, a.allowAll, [...a.modelIds]],
        `AllowedModelsChanged for provider ${a.providerId}`,
      );
      return;
    }

    case "IdentityUpdated": {
      const a = event.args;
      // The chain stores only the box key; the evidence lives in the log alone,
      // and nothing on chain makes it JSON — or makes it storable (R20, R50).
      const evidence = jsonbFromBytes(a.evidence);
      await updateOne(
        db,
        `UPDATE providers SET box_key = $2, evidence = ${jsonbOrRaw(3, 4)}
         WHERE provider_id = $1`,
        [a.providerId, bytea(a.boxKey), evidence.candidate, evidence.raw],
        `IdentityUpdated for provider ${a.providerId}`,
      );
      return;
    }

    case "ModelRegistered": {
      const a = event.args;
      // `enabled` stays out of the conflict clause for the reason `Posted`
      // leaves the lifecycle columns alone: registration enables the model on
      // chain and emits only this event, so the column's default is right for a
      // new row and a later `ModelEnabledChanged` owns it from then on (R5).
      // `name` goes through the TEXT screen for the same reason `evidence` goes
      // through the jsonb one: a NUL in it is refused at the wire, before it is
      // a column's problem, and wedges the indexer identically (R50).
      await db.query(
        `INSERT INTO models (model_id, name) VALUES ($1, $2)
         ON CONFLICT (model_id) DO UPDATE SET name = EXCLUDED.name`,
        [a.modelId, textFromChainString(a.name)],
      );
      return;
    }

    case "ModelEnabledChanged": {
      const a = event.args;
      await updateOne(
        db,
        "UPDATE models SET enabled = $2 WHERE model_id = $1",
        [a.modelId, a.enabled],
        `ModelEnabledChanged for model ${a.modelId}`,
      );
      return;
    }

    case "AllowlistEntrySet": {
      const a = event.args;
      // An entry is never deleted on chain — revocation is a status flip — so
      // this is an upsert and status 0 keeps meaning "never listed".
      const entry = jsonbFromBytes(a.entry);
      await db.query(
        `INSERT INTO allowlist (key, status, entry) VALUES ($1, $2, ${jsonbOrRaw(3, 4)})
         ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, entry = EXCLUDED.entry`,
        [bytea(a.key), a.status, entry.candidate, entry.raw],
      );
      return;
    }

    // -- AskRegistry ------------------------------------------------------
    case "AsksPublished": {
      const a = event.args;
      // An upsert per quote, not a replacement of the provider's book (R35): a
      // slot the snapshot omits keeps its previous value on chain, and a
      // publisher drops one by naming it with BOTH legs zero. Quotes are applied
      // in the order they were signed in, so a snapshot naming the same slot
      // twice settles the same way here as on chain.
      //
      // The sentinel is both legs, never `rateOut` alone: a quote with a nonzero
      // `rateIn` and `rateOut == 0` is an input-metered model — priced on prompt
      // tokens and settling at `completionTok == 0` — and is a live slot. This
      // condition must stay byte-identical to `AskRegistry.setAsks`; a projection
      // that deletes what the chain kept hides every such ask from the book while
      // the chain happily clears jobs against it.
      for (const quote of a.quotes) {
        if (quote.rateIn === 0n && quote.rateOut === 0n) {
          // No existence check: withdrawing a slot that was never published is a
          // no-op on chain and must be one here too.
          await db.query(
            "DELETE FROM asks_chain WHERE provider_id = $1 AND model_id = $2 AND sla = $3",
            [a.providerId, quote.modelId, quote.sla],
          );
          continue;
        }
        await db.query(
          `INSERT INTO asks_chain (provider_id, model_id, sla, rate_in, rate_out)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider_id, model_id, sla)
           DO UPDATE SET rate_in = EXCLUDED.rate_in, rate_out = EXCLUDED.rate_out`,
          [a.providerId, quote.modelId, quote.sla, numeric(quote.rateIn), numeric(quote.rateOut)],
        );
      }
      return;
    }

    default: {
      // Unreachable while the switch covers `ChainEvent`. If a regenerated ABI
      // adds an event to the projected set, this stops compiling rather than
      // silently dropping it.
      // Named, not serialised: every decoded event carries `bigint` members and
      // `JSON.stringify` throws on those (R46) — an error path that throws a
      // TypeError instead of its own message is worse than no message.
      const unhandled: never = event;
      throw new Error(`no projection for event ${(unhandled as ChainEvent).eventName}`);
    }
  }
}

/**
 * Applies a range of logs and moves the cursor to `toBlock`, in one transaction.
 *
 * The atomicity is the point: the cursor is the node's only record of what has
 * been applied, so a commit that advanced it past rows that did not land would
 * lose those events for good. A throw anywhere in here rolls back the whole
 * range, and the next poll re-reads it from the unchanged cursor.
 *
 * `logs` must already be in `(blockNumber, logIndex)` order — the three VORQ
 * contracts interleave inside a block, and `fetchLogsChunked` sorts the merged
 * result for exactly this consumer (R31). The order is verified rather than
 * imposed: re-sorting here would paper over a reader that stopped sorting, and
 * the projection would then depend on which chunk boundary a block fell on.
 *
 * `toHash` is the hash of `toBlock` and is stored with it, in the same
 * transaction: the guard the next tick runs compares it, and a cursor whose hash
 * landed separately from its number could name a block it never indexed.
 *
 * Returns how many logs were applied; the rest were topics the projection does
 * not store.
 */
export async function reduceRange(
  db: Db,
  logs: readonly Log[],
  toBlock: bigint,
  toHash: Hex,
): Promise<number> {
  return db.tx(async (tx) => {
    let applied = 0;
    let lastBlock = -1n;
    let lastIndex = -1;

    for (const log of logs) {
      const { blockNumber, logIndex } = log;
      if (blockNumber === null || logIndex === null) {
        throw new Error(
          "a pending log reached the reducer. The index is built from mined " +
            "blocks, and a log with no block has no place in it.",
        );
      }
      if (blockNumber > toBlock) {
        throw new Error(
          `log at block ${blockNumber} is past toBlock ${toBlock}; the cursor would ` +
            "claim to have applied a range it had not read",
        );
      }
      if (blockNumber < lastBlock || (blockNumber === lastBlock && logIndex <= lastIndex)) {
        throw new Error(
          `logs are out of order at block ${blockNumber} index ${logIndex}, after ` +
            `block ${lastBlock} index ${lastIndex}. The reducer replays in ` +
            "(blockNumber, logIndex) order and does not re-sort.",
        );
      }
      lastBlock = blockNumber;
      lastIndex = logIndex;

      const event = decodeLog(log);
      if (event === null) continue;
      await applyEvent(tx, event, blockNumber);
      applied++;
    }

    await tx.query(
      `INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`,
      [toBlock, toHash],
    );

    return applied;
  });
}
