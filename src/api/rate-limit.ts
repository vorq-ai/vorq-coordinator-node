import { ApiError } from "./errors.js";

/** The window a wallet's posts are counted over. */
export const JOB_RATE_WINDOW_MS = 86_400_000;

/**
 * How many jobs one wallet may post for one model inside {@link JOB_RATE_WINDOW_MS}.
 *
 * Held in this process's memory and nowhere else, so it is a soft limit by
 * construction: a restart forgets every count, and two instances each count
 * their own. That is the trade — no table, no read on the request path — and it
 * is the right one for what this bounds, which is how much relay gas one wallet
 * can spend on a testnet, not anything a contract depends on.
 */
export interface JobLimiter {
  /** Refuses `429` when the wallet has no slot left for the model. Counts nothing. */
  check(owner: string, modelId: bigint): void;
  /**
   * Takes a slot, or refuses `429`. The returned function gives the slot back,
   * for a post that did not land: only a job that reached the chain counts.
   */
  take(owner: string, modelId: bigint): () => void;
}

/** `limit` of `0` is no limit at all. `now` is injectable for the tests. */
export function jobLimiter(limit: number, now: () => number = Date.now): JobLimiter {
  if (limit === 0) return { check: () => undefined, take: () => () => undefined };

  const slots = new Map<string, number[]>();
  let swept = now();

  // The stamps still inside the window, oldest first.
  const live = (key: string): number[] => {
    const floor = now() - JOB_RATE_WINDOW_MS;
    const stamps = (slots.get(key) ?? []).filter((stamp) => stamp > floor);
    if (stamps.length === 0) slots.delete(key);
    else slots.set(key, stamps);
    return stamps;
  };

  // A key is otherwise pruned only when its own wallet comes back, so once a
  // window every key is visited and the map stays bounded by the wallets seen
  // in the last two windows rather than by every wallet ever seen.
  const sweep = (): void => {
    if (now() - swept < JOB_RATE_WINDOW_MS) return;
    swept = now();
    for (const key of [...slots.keys()]) live(key);
  };

  const admit = (owner: string, modelId: bigint): { key: string; stamps: number[] } => {
    const key = `${owner.toLowerCase()}:${modelId}`;
    const stamps = live(key);
    if (stamps.length >= limit) {
      const opens = new Date(stamps[0] + JOB_RATE_WINDOW_MS).toISOString();
      throw new ApiError(
        429,
        "rate_limit_exceeded",
        `this wallet has posted ${limit} jobs for model ${modelId} in the last 24 hours, ` +
          `which is this node's limit; the next slot opens at ${opens}`,
      );
    }
    return { key, stamps };
  };

  return {
    check: (owner, modelId) => void admit(owner, modelId),
    take: (owner, modelId) => {
      sweep();
      const { key, stamps } = admit(owner, modelId);
      const stamp = now();
      slots.set(key, [...stamps, stamp]);
      return () => {
        const held = slots.get(key);
        const index = held?.indexOf(stamp) ?? -1;
        if (held === undefined || index === -1) return;
        held.splice(index, 1);
        if (held.length === 0) slots.delete(key);
      };
    },
  };
}
