import type { Hex } from "viem";
import type { Address } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import type { Terms } from "../orders.js";

/**
 * Held orders: every accepted order, until a provider's claim puts it on chain.
 *
 * `JobRegistry.claim` carries the client's signed order, so an order goes on
 * chain in the same transaction that claims it and nothing is posted before
 * that. Until then the order is a `jobs` row this node wrote — open, carrying the
 * order signature `claim` needs — and the book, the lease, the funds check and
 * the duplicate check read it like any other row.
 *
 * **`order_sig IS NOT NULL` is the whole marker.** It means "this node's own row,
 * not the chain's": the reducer's `Posted` arm clears it once the claim that
 * carried the order is indexed, and a cancelled order keeps it, because no chain
 * event will ever describe that cancellation. A reorg rebuild keeps exactly these
 * rows (`src/db/db.ts`).
 */
export const HELD = "order_sig IS NOT NULL";

const bytes = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");
const hex = (buffer: Buffer): Hex => `0x${buffer.toString("hex")}`;

export interface HeldOrder {
  jobId: Hex;
  owner: Address;
  terms: Terms;
  taskCid: string;
  /** The relay gas fee the order was quoted at. A claim is refused while the live one differs. */
  gasFee: bigint;
  orderSig: Hex;
}

/**
 * Writes the held row. `false` when a row for this `job_id` already exists.
 *
 * `posted_block` is the index cursor at acceptance — the block the order is
 * known from — so the book's age filter, its oldest-first lease order and the
 * escrow-orphan clause all read an open order the way they read a posted one.
 * The reducer's `Posted` writes the claim's own block over it.
 */
export async function holdOrder(db: Queryable, order: HeldOrder): Promise<boolean> {
  const { terms } = order;
  const { rowCount } = await db.query(
    `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated,
                       rate_in, rate_out, units_in, units_out, expires_at,
                       task_cid, posted_block, as_of_block, gas_fee, order_sig)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, at.block, at.block, $13, $14
       FROM (SELECT COALESCE((SELECT block_number FROM cursor WHERE id = 1), 0) AS block) at
     ON CONFLICT (job_id) DO NOTHING`,
    [
      bytes(order.jobId),
      bytes(order.owner),
      bytes(terms.c),
      terms.modelId.toString(),
      terms.slaSecs.toString(),
      terms.designated.toString(),
      terms.rateIn.toString(),
      terms.rateOut.toString(),
      terms.unitsIn.toString(),
      terms.unitsOut.toString(),
      terms.expiresAt.toString(),
      Buffer.from(order.taskCid, "utf8"),
      order.gasFee.toString(),
      bytes(order.orderSig),
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** A held order as `claim` takes it back out of its row. */
export interface ClaimableOrder {
  owner: Address;
  terms: Terms;
  taskCid: string;
  gasFee: bigint;
  orderSig: Hex;
}

interface HeldRow {
  owner: Buffer;
  c: Buffer;
  model_id: bigint;
  sla_secs: bigint;
  designated: bigint;
  rate_in: bigint;
  rate_out: bigint;
  units_in: bigint;
  units_out: bigint;
  expires_at: bigint;
  task_cid: Buffer;
  gas_fee: bigint;
  order_sig: Buffer;
}

/**
 * Takes a held order for `providerId`'s claim, or `null` when there is no open
 * held order under this id.
 *
 * The row is locked while the claimant's lease is written over it for
 * `holdMs`, which is how {@link cancelHeld} — locking the same row — learns that
 * a claim is in flight and refuses: an order is never both cancelled here and
 * claimed on chain. The lease outlives the relay; once the claim lands the row
 * is no longer open, and a lease on a row nobody can take is inert.
 */
export async function takeForClaim(
  db: Db,
  jobId: Hex,
  providerId: bigint,
  holdMs: number,
): Promise<ClaimableOrder | null> {
  const key = bytes(jobId);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<HeldRow>(
      `SELECT owner, c, model_id, sla_secs, designated, rate_in, rate_out, units_in, units_out,
              expires_at, task_cid, gas_fee, order_sig
         FROM jobs WHERE job_id = $1 AND state = 0 AND ${HELD} FOR UPDATE`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) return null;
    await tx.query(
      `INSERT INTO job_leases (job_id, provider_id, offered_at, expires_at)
       VALUES ($1, $2, now(), now() + ($3::bigint * interval '1 millisecond'))
       ON CONFLICT (job_id) DO UPDATE SET
         provider_id = EXCLUDED.provider_id, offered_at = EXCLUDED.offered_at,
         expires_at = GREATEST(job_leases.expires_at, EXCLUDED.expires_at)`,
      [key, providerId.toString(), holdMs],
    );
    return {
      owner: hex(row.owner) as Address,
      terms: {
        c: hex(row.c),
        modelId: BigInt(row.model_id),
        slaSecs: BigInt(row.sla_secs),
        rateIn: BigInt(row.rate_in),
        rateOut: BigInt(row.rate_out),
        unitsIn: BigInt(row.units_in),
        unitsOut: BigInt(row.units_out),
        designated: BigInt(row.designated),
        expiresAt: BigInt(row.expires_at),
      },
      taskCid: row.task_cid.toString("utf8"),
      gasFee: BigInt(row.gas_fee),
      orderSig: hex(row.order_sig),
    };
  });
}

/**
 * Gives back the lease {@link takeForClaim} wrote, for a claim the chain
 * refused: the order is still open, and the next poller may take it.
 */
export async function dropLease(db: Queryable, jobId: Hex, providerId: bigint): Promise<void> {
  await db.query("DELETE FROM job_leases WHERE job_id = $1 AND provider_id = $2", [
    bytes(jobId),
    providerId.toString(),
  ]);
}

/** What {@link cancelHeld} did. */
export type CancelOutcome =
  /** The order is ended in its row. Nothing was relayed: it was never on chain. */
  | "cancelled"
  /** The signature does not recover to the order's owner. */
  | "not_owner"
  /** No order under this id. */
  | "unknown"
  /** The order is no longer open: claimed, settled or already cancelled. */
  | "not_open"
  /** A provider holds the order's lease; its claim may be in flight. */
  | "leased";

/**
 * Cancels an open order in its row. **Nothing is relayed**: an unclaimed order
 * exists only here, and the claim relay builds `claim` from this row, so ending
 * the row is the whole cancellation.
 *
 * The row is locked before the lease is looked for. The lease step and the
 * claim relay ({@link takeForClaim}) lock the rows they take, so a claim either
 * sees this cancel or this cancel sees its lease. `onChain` is asked last, under
 * the lock: a claim whose relay outlived its lease is on chain by then, and the
 * row is not ended under it.
 */
export async function cancelHeld(
  db: Db,
  jobId: Hex,
  signedBy: (owner: Address) => Promise<boolean>,
  onChain: () => Promise<boolean>,
): Promise<CancelOutcome> {
  const key = bytes(jobId);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ owner: Buffer; state: number; held: boolean }>(
      `SELECT owner, state, ${HELD} AS held FROM jobs WHERE job_id = $1 FOR UPDATE`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) return "unknown";
    if (!(await signedBy(hex(row.owner) as Address))) return "not_owner";
    if (row.state !== 0 || !row.held) return "not_open";
    const leases = await tx.query(
      "SELECT 1 FROM job_leases WHERE job_id = $1 AND expires_at > now()",
      [key],
    );
    if (leases.rows.length > 0) return "leased";
    if (await onChain()) return "not_open";
    await tx.query("UPDATE jobs SET state = 3, ended_because = 2 WHERE job_id = $1", [key]);
    await tx.query("DELETE FROM job_leases WHERE job_id = $1", [key]);
    return "cancelled";
  });
}
