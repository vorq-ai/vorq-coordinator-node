import { encodeFunctionData, parseEventLogs, type Hex } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import { errorNameOf, GAS_OVERHEAD, GAS_PER_LINE, MAX_LINES_PER_TRANSACTION } from "../batches/worker.js";
import type { Chain } from "../chain/client.js";
import type { Address } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import { writePostedRows } from "../index/write-through.js";
import { taskCidHex, type Terms } from "../orders.js";

/**
 * Held orders: paid orders that no live ask cleared when they arrived.
 *
 * The relayer pays the gas of a `post` and is repaid only when a provider
 * claims the job, so an order nobody will claim is gas spent for nothing — and
 * a client can send as many as it likes. Such an order is therefore not posted.
 * It is written to `jobs` as an open row that still carries the two signatures
 * `post` takes, and it goes on chain when a provider's poll leases it: the
 * provider stated the floors it accepts, the row passed them, so the post is
 * one a claim follows.
 *
 * **`auth_sig IS NOT NULL` is the whole marker.** Everything else about the row
 * is an ordinary open job, which is why the book, the lease, the funds check
 * and the duplicate pre-check need no second code path. The reducer's `Posted`
 * arm clears both signatures, so "the chain has it" and "no longer held" are
 * one write.
 */
export const HELD = "auth_sig IS NOT NULL";

const RECEIPT_TIMEOUT_MS = 60_000;

const bytes = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");
const hex = (buffer: Buffer): Hex => `0x${buffer.toString("hex")}`;

export interface HeldOrder {
  jobId: Hex;
  owner: Address;
  terms: Terms;
  taskCid: string;
  /** The relay gas fee the quote was signed against. `Posted` writes the chain's own over it. */
  gasFee: bigint;
  orderSig: Hex;
  authSig: Hex;
}

/** Writes the held row. `false` when a row for this `job_id` already exists. */
export async function holdOrder(db: Queryable, order: HeldOrder): Promise<boolean> {
  const { terms } = order;
  const { rowCount } = await db.query(
    `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated,
                       rate_in, rate_out, units_in, units_out, expires_at,
                       task_cid, posted_block, as_of_block, gas_fee, order_sig, auth_sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0,
             COALESCE((SELECT block_number FROM cursor WHERE id = 1), 0), $13, $14, $15)
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
      bytes(order.authSig),
    ],
  );
  return (rowCount ?? 0) > 0;
}

interface HeldRow {
  job_id: Buffer;
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
  order_sig: Buffer;
  auth_sig: Buffer;
}

export interface PublishDeps {
  db: Db;
  chain: Chain | undefined;
  jobRegistry: Address;
}

/**
 * Posts the held orders `providerId` has just been leased for `modelId`, in one
 * `postMany`. Returns how many landed.
 *
 * Called by the provider poll between writing its leases and reading them
 * back, so every job the poll answers is on chain by the time the daemon sees
 * it. Whatever could not be posted loses its lease first, so the poll never
 * hands out a job the chain does not have:
 *
 *   * a line the contract refused (`PostSkipped` with a reason — expired, the
 *     funds moved) is deleted, held rows only;
 *   * a line refused as `DuplicateJob` is already on chain — an earlier post of
 *     it landed unseen — so it keeps its row and lease and stops being held;
 *   * a line with no verdict (out of gas), a reverted or failed relay, a
 *     missing chain and whatever is past one transaction's worth keep the row
 *     and drop the lease, and the next poll tries again.
 */
export async function publishHeld(
  deps: PublishDeps,
  providerId: bigint,
  modelId: bigint,
): Promise<number> {
  const { db, chain, jobRegistry } = deps;
  const { rows } = await db.query<HeldRow>(
    `SELECT j.job_id, j.owner, j.c, j.model_id, j.sla_secs, j.designated, j.rate_in, j.rate_out,
            j.units_in, j.units_out, j.expires_at, j.task_cid, j.order_sig, j.auth_sig
       FROM jobs j JOIN job_leases l ON l.job_id = j.job_id
      WHERE l.provider_id = $1 AND l.expires_at > now()
        AND j.model_id = $2 AND j.state = 0 AND j.${HELD}
      ORDER BY j.job_id
      LIMIT $3`,
    [providerId.toString(), modelId.toString(), MAX_LINES_PER_TRANSACTION],
  );
  if (rows.length === 0) return 0;

  const ids = rows.map((row) => row.job_id);
  const unlease = (jobIds: Buffer[]) =>
    db.query("DELETE FROM job_leases WHERE job_id = ANY($1::bytea[])", [jobIds]);

  // Held rows this transaction has no room for are not answered unposted.
  if (rows.length === MAX_LINES_PER_TRANSACTION) {
    await db.query(
      `DELETE FROM job_leases l USING jobs j
        WHERE j.job_id = l.job_id AND l.provider_id = $1
          AND j.model_id = $2 AND j.state = 0 AND j.${HELD}
          AND NOT (l.job_id = ANY($3::bytea[]))`,
      [providerId.toString(), modelId.toString(), ids],
    );
  }

  if (chain === undefined) {
    await unlease(ids);
    return 0;
  }

  const data = encodeFunctionData({
    abi: jobRegistryAbi,
    functionName: "postMany",
    args: [
      rows.map((row) => ({
        c: hex(row.c),
        modelId: Number(row.model_id),
        slaSecs: Number(row.sla_secs),
        rateIn: BigInt(row.rate_in),
        rateOut: BigInt(row.rate_out),
        unitsIn: Number(row.units_in),
        unitsOut: Number(row.units_out),
        designated: Number(row.designated),
        expiresAt: BigInt(row.expires_at),
        taskCid: taskCidHex(row.task_cid.toString("utf8")),
      })),
      rows.map((row) => hex(row.owner) as Address),
      rows.map((row) => hex(row.order_sig)),
      rows.map((row) => hex(row.auth_sig)),
    ],
  });

  let receipt;
  try {
    const txHash = await chain.relay({
      to: jobRegistry,
      data,
      gas: GAS_OVERHEAD + GAS_PER_LINE * BigInt(rows.length),
    });
    receipt = await chain.receipt(txHash, RECEIPT_TIMEOUT_MS);
    // A reverted transaction posted nothing and carries no per-line verdicts.
    if (receipt.status !== "success") throw new Error(`postMany ${txHash} reverted`);
  } catch (error) {
    await unlease(ids);
    throw error;
  }

  const refused: Buffer[] = [];
  const undecided: Buffer[] = [];
  const onChain: Buffer[] = [];
  for (const event of parseEventLogs({ abi: jobRegistryAbi, eventName: "PostSkipped", logs: receipt.logs })) {
    const { index, reason } = event.args as { index: bigint; reason: Hex };
    const row = rows[Number(index)];
    if (row === undefined) continue;
    // Empty revert data is the sub-call running out of gas, not a verdict.
    if (reason === "0x") undecided.push(row.job_id);
    else if (errorNameOf(reason) === "DuplicateJob") onChain.push(row.job_id);
    else refused.push(row.job_id);
  }
  if (onChain.length > 0) {
    await db.query(
      "UPDATE jobs SET order_sig = NULL, auth_sig = NULL WHERE job_id = ANY($1::bytea[])",
      [onChain],
    );
  }
  if (refused.length + undecided.length > 0) await unlease([...refused, ...undecided]);
  if (refused.length > 0) {
    await db.query(`DELETE FROM jobs WHERE job_id = ANY($1::bytea[]) AND ${HELD}`, [refused]);
  }

  // The reducer's `Posted` arm stamps `posted_block` and clears the signatures.
  await writePostedRows(db, jobRegistry, receipt.logs, receipt.blockNumber);
  return rows.length - refused.length - undecided.length - onChain.length;
}

/**
 * Cancels a held order in its row. `"on_chain"` when the job is not held, or is
 * leased and so being posted right now: the chain's `cancel` is then the door.
 *
 * The row is locked before the lease is looked for. The lease step locks the
 * rows it picks and skips locked ones, so a poll either sees this cancel or
 * this cancel sees its lease, and an order is never both cancelled here and
 * posted.
 */
export async function cancelHeld(
  db: Db,
  jobId: Hex,
  signedBy: (owner: Address) => Promise<boolean>,
): Promise<"cancelled" | "not_owner" | "on_chain"> {
  const key = bytes(jobId);
  return db.tx(async (tx) => {
    const { rows } = await tx.query<{ owner: Buffer }>(
      `SELECT owner FROM jobs WHERE job_id = $1 AND state = 0 AND ${HELD} FOR UPDATE`,
      [key],
    );
    const owner = rows[0]?.owner;
    if (owner === undefined) return "on_chain";
    const leases = await tx.query(
      "SELECT 1 FROM job_leases WHERE job_id = $1 AND expires_at > now()",
      [key],
    );
    if (leases.rows.length > 0) return "on_chain";
    if (!(await signedBy(hex(owner) as Address))) return "not_owner";
    await tx.query(
      "UPDATE jobs SET state = 3, ended_because = 2, order_sig = NULL, auth_sig = NULL WHERE job_id = $1",
      [key],
    );
    return "cancelled";
  });
}
