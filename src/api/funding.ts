import { erc20Abi } from "viem";
import { atFloor, type Chain } from "../chain/client.js";
import type { Address } from "../config.js";
import type { Queryable } from "../db/db.js";
import { capOf, feeOf } from "../orders.js";
import { viewRead } from "./chain-failure.js";

/**
 * Can a payer fund what it signs?
 *
 * `post` moves no money: the escrow is pulled from the owner's wallet at
 * **claim**, through the authorization parked with the job. A wallet that holds
 * less than the pull therefore posts perfectly and is then refused by the
 * payment token on every claim attempt until the order expires — measured on
 * Base Sepolia 2026-10-17: fifteen orders from empty wallets, each retried by
 * the provider every few seconds for a day, and the client shown a job that
 * never started. These reads are what refuse such an order before it is posted
 * and what lets the claim gate see the pull it otherwise cannot.
 */

/**
 * The payer's token balance, pinned to the node's floor like every read that
 * decides an answer (`atFloor`). A failed read is the node's, never a verdict on
 * the request (`viewRead`).
 */
export function tokenBalance(chain: Chain, token: Address, owner: Address): Promise<bigint> {
  return viewRead("payer_balance_read", () =>
    atFloor(chain, (pin) =>
      chain.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        ...pin,
      }),
    ),
  );
}

/**
 * What this owner's open, unexpired jobs will pull when they are claimed:
 * `cap + feeCap + gasFeeSnap` each, `JobRegistry._locked` restated.
 *
 * Each job pulls separately, so a wallet that covers one order and not ten
 * would otherwise post all ten and fund only the first claim. Write-through rows
 * count: they are this node's own posts a few seconds old — exactly the burst
 * the sum exists for.
 */
export async function openObligations(
  db: Queryable,
  owner: Buffer,
  feeBps: number,
  now: bigint,
): Promise<bigint> {
  const { rows } = await db.query<{
    rate_in: string;
    rate_out: string;
    units_in: string;
    units_out: string;
    gas_fee: string;
  }>(
    `SELECT rate_in, rate_out, units_in, units_out, gas_fee FROM jobs
      WHERE owner = $1 AND state = 0 AND expires_at > $2`,
    [owner, now.toString()],
  );
  let total = 0n;
  for (const row of rows) {
    const cap = capOf({
      rateIn: BigInt(row.rate_in),
      rateOut: BigInt(row.rate_out),
      unitsIn: BigInt(row.units_in),
      unitsOut: BigInt(row.units_out),
    });
    total += cap + feeOf(cap, feeBps) + BigInt(row.gas_fee);
  }
  return total;
}

/** What `owner` can still fund: its balance less what its open jobs will pull. */
export async function fundsLeft(
  chain: Chain,
  db: Queryable,
  token: Address,
  owner: Address,
  feeBps: number,
  now: bigint,
): Promise<bigint> {
  const [balance, open] = await Promise.all([
    tokenBalance(chain, token, owner),
    openObligations(db, Buffer.from(owner.slice(2), "hex"), feeBps, now),
  ]);
  return balance - open;
}
