import { encodeFunctionData, parseEventLogs, type Hex } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import type { Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";

/**
 * The `reclaim` keeper: the one automatic on-chain write this node performs.
 *
 * ## What it is for
 *
 * `JobRegistry.reclaim(jobId)` is the protocol's only permissionless, unsigned
 * mutation. When a claimed job blows its SLA it does two things at once: it
 * refunds the client's locked capital in full, and it applies the −40 reputation
 * penalty that makes abandonment expensive.
 *
 * Neither happens on its own. The contract deliberately requires **no** signature
 * so that no single party can strand an escrow by doing nothing — but "anyone may
 * call it" is not "someone will". The client whose money is locked is typically
 * offline on the hosted path, and the provider that abandoned the job has every
 * reason not to. Without a keeper, capital sits locked until somebody notices and
 * abandonment is free, which quietly removes the teeth from the reputation
 * system the capacity ramp is built on.
 *
 * ## What it deliberately does not do
 *
 * It has **no privilege**. It signs nothing, and it holds no key beyond the
 * relayer wallet that already pays gas for every relayed op — a wallet with zero
 * standing in either registry. Everything it can accomplish, any stranger with a
 * funded account could accomplish identically, which is exactly the property that
 * makes running it uncontroversial.
 *
 * ## Two things it must get right
 *
 * **Chain time, not wall time.** The contract compares against `block.timestamp`
 * (`JobRegistry.reclaim`: `block.timestamp <= claimedAt + slaSecs` reverts). A
 * keeper that filtered on its own clock would, on any chain whose timestamp drifts
 * from real time, either burn gas on jobs the contract still refuses or sit on
 * jobs it would happily accept.
 *
 * **Simulate before relaying.** A provider settling in the last second of its SLA
 * is not an error, it is the system working; losing that race should cost nothing.
 * The simulate makes a lost race a skipped row instead of a reverted transaction,
 * following the same mandatory-simulate rule every write door here obeys.
 *
 * And one it must not assume: a transaction that succeeded is not proof the
 * intended thing happened (R29). The receipt is parsed for the `Ended` event
 * before this reports a reclaim.
 */

/**
 * How often the sweep runs. Not configurable, on purpose.
 *
 * There is nothing an operator gains by tuning it: the deadline that matters is
 * the SLA, which is signed into each job and measured in hours, so a minute of
 * lateness in noticing is immaterial and a faster timer would only add chain
 * reads. A knob here would be a knob whose only correct value is this one.
 */
export const RECLAIM_INTERVAL_MS = 60_000;

/**
 * The most reclaims attempted in one pass.
 *
 * Bounded because the relayer's nonce is a single counter — `Chain.relay` is
 * serial by physics — so an unbounded pass after an outage would monopolise it
 * and stall every client-facing relay behind housekeeping. The backlog is not
 * dropped, only spread: the next tick takes the next batch, oldest first.
 */
export const RECLAIM_BATCH = 25;

/** Only `Claimed` rows are candidates; the contract refuses every other state. */
const STATE_CLAIMED = 1;

export interface ReclaimDeps {
  db: Db;
  chain: Chain | null;
  config: Config;
}

export interface ReclaimTick {
  /** Rows whose SLA had expired according to the chain's own clock. */
  candidates: number;
  /** Reclaims that landed and emitted `Ended`. */
  reclaimed: number;
  /** Candidates the simulate refused — a settle or a fail won the race. */
  skipped: number;
}

/**
 * One pass: read the chain's clock, find expired claims, simulate, relay.
 *
 * Per-job failures are reported and swallowed. One job whose provider settled
 * mid-pass must not stop the pass — the remaining jobs are unrelated, and their
 * clients' capital is just as locked.
 */
export async function reclaimTick(
  deps: ReclaimDeps,
  onError: (error: unknown, jobId: string) => void,
): Promise<ReclaimTick | null> {
  const chain = deps.chain;
  if (chain === null) return null;

  // The chain's clock, because the contract's comparison is against
  // `block.timestamp` and nothing else.
  const head = await chain.publicClient.getBlock({ blockTag: "latest" });
  const chainNow = head.timestamp;

  const { rows } = await deps.db.query<{ job_id: Buffer }>(
    `SELECT job_id FROM jobs
      WHERE state = $1 AND claimed_at + sla_secs < $2
      ORDER BY claimed_at ASC
      LIMIT $3`,
    [STATE_CLAIMED, chainNow.toString(), RECLAIM_BATCH],
  );
  if (rows.length === 0) return { candidates: 0, reclaimed: 0, skipped: 0 };

  let reclaimed = 0;
  let skipped = 0;
  for (const row of rows) {
    const jobId = `0x${row.job_id.toString("hex")}` as Hex;
    try {
      if (await reclaimOne(deps, chain, jobId)) reclaimed += 1;
      else skipped += 1;
    } catch (error) {
      onError(error, jobId);
    }
  }
  return { candidates: rows.length, reclaimed, skipped };
}

/**
 * One job. `true` if a reclaim landed, `false` if the chain refused it.
 *
 * The refusal is the *expected* outcome of a lost race — the projection can be a
 * block or two behind, and a provider settling inside its window is the system
 * working — so it is a return value rather than a throw. Anything else (an RPC
 * that fell over, a relay queue that filled) throws and is reported.
 */
async function reclaimOne(deps: ReclaimDeps, chain: Chain, jobId: Hex): Promise<boolean> {
  try {
    await chain.publicClient.simulateContract({
      address: deps.config.addresses.jobRegistry,
      abi: jobRegistryAbi,
      functionName: "reclaim",
      args: [jobId],
      account: chain.account,
    });
  } catch {
    // `NotClaimed` or `SlaNotExpired`: somebody terminated this job between the
    // projection read and now. Free, and correct.
    return false;
  }

  const data = encodeFunctionData({ abi: jobRegistryAbi, functionName: "reclaim", args: [jobId] });
  const hash = await chain.relay({ to: deps.config.addresses.jobRegistry, data });
  const receipt = await chain.receipt(hash, 120_000);

  // R29: a mined transaction is not proof of the effect. `Ended` is.
  const ended = parseEventLogs({ abi: jobRegistryAbi, eventName: "Ended", logs: receipt.logs });
  return ended.length > 0;
}

/**
 * The keeper on a timer. Same shape as the batch worker: an exported `tick` so
 * tests drive passes deterministically, a re-entrancy guard because a pass can
 * outlast the interval, and `unref` so housekeeping never holds a SIGTERM open.
 */
export function startReclaimKeeper(
  deps: ReclaimDeps,
  onError: (error: unknown, jobId: string) => void,
  intervalMs: number = RECLAIM_INTERVAL_MS,
): { stop: () => void; tick: () => Promise<ReclaimTick | null> } {
  let running = false;
  const tick = async (): Promise<ReclaimTick | null> => {
    if (running) return null;
    running = true;
    try {
      return await reclaimTick(deps, onError);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick().catch((error: unknown) => onError(error, "")), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
