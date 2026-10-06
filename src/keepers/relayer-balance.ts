import { parseGwei } from "viem";
import type { Chain } from "../chain/client.js";

/**
 * The relayer balance watch: says the gas wallet is running low before it is
 * empty.
 *
 * The relayer pays for every post, claim, settle, fail and reclaim, and nothing
 * on chain pays it back — the gas fee a job carries goes to the treasury. So the
 * wallet only drains, and an empty one stops every settle on the node at once.
 * This reads the balance on a timer and reports a low one; the caller logs it at
 * `error`, which is what reaches Sentry.
 */

/**
 * How often the balance is read: once a day, and once at boot. A low wallet
 * reports on every pass, so this is also the repeat rate of the report while
 * nobody has topped it up.
 */
export const RELAYER_BALANCE_INTERVAL_MS = 86_400_000;

/** One read. `low` when the balance is under `lowBalanceGwei` (`RELAYER_LOW_BALANCE_GWEI`). */
export async function relayerBalanceTick(
  chain: Chain,
  lowBalanceGwei: number,
): Promise<{ balance: bigint; low: boolean }> {
  const balance = await chain.publicClient.getBalance({ address: chain.account.address });
  return { balance, low: balance < parseGwei(String(lowBalanceGwei)) };
}

/** The watch on a timer; same shape as the reclaim keeper. */
export function startRelayerBalanceWatch(
  chain: Chain,
  lowBalanceGwei: number,
  onLow: (balance: bigint) => void,
  onError: (error: unknown) => void,
  intervalMs: number = RELAYER_BALANCE_INTERVAL_MS,
): { stop: () => void; tick: () => Promise<void> } {
  const tick = async (): Promise<void> => {
    try {
      const { balance, low } = await relayerBalanceTick(chain, lowBalanceGwei);
      if (low) onLow(balance);
    } catch (error) {
      onError(error);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
