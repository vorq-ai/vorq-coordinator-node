import { jobRegistryAbi } from "../abi/jobRegistry.js";
import { atFloor, type Chain } from "../chain/client.js";
import type { Address } from "../config.js";
import type { Queryable } from "../db/db.js";
import { HELD } from "../match/held.js";
import { lockOf } from "../orders.js";
import { viewRead } from "./chain-failure.js";
import { subjectQueue } from "./queue.js";

/**
 * Can an owner fund what it orders?
 *
 * A client pays from a prepaid balance inside `JobRegistry`, and an order locks
 * its `cap + feeCap + gasFee` out of that balance only when a provider claims
 * it. Between the two the order rests in this node's database, so the chain's
 * balance does not yet show what it owes. These reads put the two together: the
 * submission door refuses an order the balance cannot cover once the owner's
 * other open orders are counted, and the withdrawal door refuses to release what
 * those orders will lock.
 */

/**
 * One queue per owner for every funds decision and the write it justifies —
 * a post's hold, a batch line's hold, a withdrawal's relay, a deposit's relay.
 *
 * Each of those reads `available` and then writes against it. Two of them on
 * one owner, interleaved, both read the same `available` and both write, which
 * leaves `reserved` above `balance`: held orders no claim can fund. Run under
 * this, the second reads what the first wrote. One instance for the process,
 * because the three callers — the submission door, the balance doors and the
 * batch worker — must queue behind each other, not each behind its own kind.
 */
const fundsQueue = subjectQueue("funds operations");

/** Runs `fn` with no other funds decision for `owner` in flight in this process. */
export function underOwnerFunds<T>(owner: Address, fn: () => Promise<T>): Promise<T> {
  return fundsQueue(owner.toLowerCase(), fn);
}

/**
 * The owner's prepaid balance — `JobRegistry.balanceOf`, which is already net of
 * every claimed job's lock — pinned to the node's floor like every read that
 * decides an answer (`atFloor`), so a deposit this node just relayed is seen. A
 * failed read is the node's, never a verdict on the request (`viewRead`).
 */
export function balanceOf(chain: Chain, jobRegistry: Address, owner: Address): Promise<bigint> {
  return viewRead("balance_read", () =>
    atFloor(chain, (pin) =>
      chain.publicClient.readContract({
        address: jobRegistry,
        abi: jobRegistryAbi,
        functionName: "balanceOf",
        args: [owner],
        ...pin,
      }),
    ),
  );
}

/**
 * What this owner's open, unexpired orders will lock when they are claimed:
 * `cap + feeCap + gasFee` each, `JobRegistry._locked` restated, at the gas fee
 * each was quoted.
 *
 * Each order locks separately, so a balance that covers one order and not ten
 * would otherwise accept all ten and fund only the first claim.
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
      WHERE owner = $1 AND state = 0 AND ${HELD} AND expires_at >= $2`,
    [owner, now.toString()],
  );
  let total = 0n;
  for (const row of rows) {
    total += lockOf(
      {
        rateIn: BigInt(row.rate_in),
        rateOut: BigInt(row.rate_out),
        unitsIn: BigInt(row.units_in),
        unitsOut: BigInt(row.units_out),
      },
      feeBps,
      BigInt(row.gas_fee),
    );
  }
  return total;
}

/** The owner's balance, what its open orders reserve, and what is left for anything new. */
export interface Funds {
  balance: bigint;
  reserved: bigint;
  /** `balance − reserved`, floored at 0. */
  available: bigint;
}

/** {@link balanceOf} and {@link openObligations} together. */
export async function fundsOf(
  chain: Chain,
  db: Queryable,
  jobRegistry: Address,
  owner: Address,
  feeBps: number,
  now: bigint,
): Promise<Funds> {
  const [balance, reserved] = await Promise.all([
    balanceOf(chain, jobRegistry, owner),
    openObligations(db, Buffer.from(owner.slice(2), "hex"), feeBps, now),
  ]);
  return { balance, reserved, available: balance > reserved ? balance - reserved : 0n };
}

/** What `owner` can still fund: its balance less what its open orders will lock. Negative when over-committed. */
export async function fundsLeft(
  chain: Chain,
  db: Queryable,
  jobRegistry: Address,
  owner: Address,
  feeBps: number,
  now: bigint,
): Promise<bigint> {
  const { balance, reserved } = await fundsOf(chain, db, jobRegistry, owner, feeBps, now);
  return balance - reserved;
}
