import { encodeFunctionData, parseEventLogs, type Abi, type Hex } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import type { Chain } from "../chain/client.js";
import { decodeRevert, isVerdict } from "../chain/revert.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";

/**
 * The payout keeper: pays providers, this node's relayer and the treasury what
 * `JobRegistry` has accrued for them.
 *
 * ## What it is for
 *
 * Settlement moves no tokens. It credits the provider's charge to
 * `earned[providerId]`, the protocol fee to `accrued`, and the gas fee to
 * `relayerEarned[relayer]` of the relayer that landed the claim — as a deposit
 * credits its deposit fee to the relayer that landed it. The tokens stay in the
 * registry until somebody calls `payProvider(id)` — which transfers the whole of
 * `earned` to the provider's **current** operator key — `payRelayer(relayer)`,
 * which transfers `relayerEarned` to that same address, or `payTreasury()`,
 * which transfers `accrued` to the treasury. All three are permissionless and
 * unsigned, so anyone may trigger them; this keeper is the someone, on a
 * schedule, so a payee is paid without having to ask.
 *
 * ## What it deliberately does not do
 *
 * It has **no privilege**. It signs nothing, and it holds no key beyond the
 * relayer wallet that pays gas for every relayed op. It cannot choose who is
 * paid or how much: the registry decides both.
 *
 * ## How it decides whom to pay
 *
 * Every provider the index knows is read once per pass — `earned(id)` at
 * `latest` — and paid when it holds anything, then this node's one relayer
 * account when `relayerEarned` is non-zero, then the treasury when `accrued` is
 * non-zero. Other coordinators' relayers are theirs to pay. A zero balance is skipped rather than relayed, because the
 * contract refuses it (`NothingToPay`) and the relayer would pay for the
 * refusal. Each payout is simulated first, so a payout somebody else triggered
 * between the read and the relay is a skipped row rather than a reverted
 * transaction, and the receipt is parsed for the payout event before this
 * reports one (R29).
 */

/** How long the keeper waits for one payout's receipt. */
const RECEIPT_TIMEOUT_MS = 120_000;

export interface PayoutDeps {
  db: Db;
  chain: Chain | null;
  config: Config;
}

export interface PayoutTick {
  /** Providers with earnings when the pass read them. */
  candidates: number;
  /** Provider payouts that landed and emitted `ProviderPaid`. */
  providersPaid: number;
  /** Whether this node's relayer payout landed and emitted `RelayerPaid`. */
  relayerPaid: boolean;
  /** Whether a treasury payout landed and emitted `TreasuryPaid`. */
  treasuryPaid: boolean;
}

/**
 * One pass. Per-payout failures are reported and swallowed: one provider whose
 * payout failed must not stop the next provider's, nor the relayer's or the
 * treasury's.
 */
export async function payoutTick(
  deps: PayoutDeps,
  onError: (error: unknown, payee: string) => void,
): Promise<PayoutTick | null> {
  const chain = deps.chain;
  if (chain === null) return null;
  const registry = deps.config.addresses.jobRegistry;

  const { rows } = await deps.db.query<{ provider_id: bigint }>(
    "SELECT provider_id FROM providers ORDER BY provider_id",
  );
  let candidates = 0;
  let providersPaid = 0;
  for (const { provider_id: providerId } of rows) {
    const id = Number(providerId);
    try {
      // R77-off-request-path: a keeper read with no caller, whose failure is reported to the log.
      const earned = await chain.publicClient.readContract({
        address: registry,
        abi: jobRegistryAbi,
        functionName: "earned",
        args: [id],
      });
      if (earned === 0n) continue;
      candidates += 1;
      const data = encodeFunctionData({ abi: jobRegistryAbi, functionName: "payProvider", args: [id] });
      if (await payOne(chain, registry, data, "ProviderPaid")) providersPaid += 1;
    } catch (error) {
      onError(error, `provider ${id}`);
    }
  }

  let relayerPaid = false;
  const relayer = chain.account.address;
  try {
    // R77-off-request-path: as `earned` above, a keeper read with no caller.
    const relayerEarned = await chain.publicClient.readContract({
      address: registry,
      abi: jobRegistryAbi,
      functionName: "relayerEarned",
      args: [relayer],
    });
    if (relayerEarned > 0n) {
      const data = encodeFunctionData({ abi: jobRegistryAbi, functionName: "payRelayer", args: [relayer] });
      relayerPaid = await payOne(chain, registry, data, "RelayerPaid");
    }
  } catch (error) {
    onError(error, `relayer ${relayer}`);
  }

  let treasuryPaid = false;
  try {
    // R77-off-request-path: as `earned` above, a keeper read with no caller.
    const accrued = await chain.publicClient.readContract({
      address: registry,
      abi: jobRegistryAbi,
      functionName: "accrued",
    });
    if (accrued > 0n) {
      const data = encodeFunctionData({ abi: jobRegistryAbi, functionName: "payTreasury" });
      treasuryPaid = await payOne(chain, registry, data, "TreasuryPaid");
    }
  } catch (error) {
    onError(error, "treasury");
  }

  return { candidates, providersPaid, relayerPaid, treasuryPaid };
}

/**
 * One payout: simulate, relay, and read the receipt for its event. `false` when
 * the simulate refused it `NothingToPay` — somebody else paid it out since the
 * read. Any other failure of the simulate throws, for the pass to report.
 */
async function payOne(
  chain: Chain,
  registry: Hex,
  data: Hex,
  eventName: "ProviderPaid" | "RelayerPaid" | "TreasuryPaid",
): Promise<boolean> {
  try {
    await chain.publicClient.call({ account: chain.account.address, to: registry, data });
  } catch (error) {
    // Drained between the read and now. Free, and correct.
    if (isVerdict(error) && decodeRevert(error, [jobRegistryAbi as Abi]).reason === "NothingToPay") {
      return false;
    }
    throw error;
  }
  const hash = await chain.relay({ to: registry, data });
  const receipt = await chain.receipt(hash, RECEIPT_TIMEOUT_MS);
  // R29: a mined transaction is not proof of the effect. The event is.
  return parseEventLogs({ abi: jobRegistryAbi, eventName, logs: receipt.logs }).length > 0;
}

/**
 * The keeper on a timer, shaped like the reclaim keeper: an exported `tick` so
 * tests drive passes deterministically, a re-entrancy guard because a pass can
 * outlast a short interval, and `unref` so housekeeping never holds a SIGTERM
 * open.
 */
export function startPayoutKeeper(
  deps: PayoutDeps,
  onError: (error: unknown, payee: string) => void,
  intervalMs: number,
): { stop: () => void; tick: () => Promise<PayoutTick | null> } {
  let running = false;
  const tick = async (): Promise<PayoutTick | null> => {
    if (running) return null;
    running = true;
    try {
      return await payoutTick(deps, onError);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick().catch((error: unknown) => onError(error, "")), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
