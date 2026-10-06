import { ApiError } from "./errors.js";

/**
 * The per-subject admission queue both relaying doors run on (R66).
 *
 * ## What it is for
 *
 * Two callers acting on one subject — one `job_id`, one job's `settle` — both
 * simulate against the same pre-op state, both pass, and the loser reverts
 * **after the relayer has paid for its execution**. Behind this queue the loser
 * re-simulates against the state the winner produced and is refused for free. It
 * needs no forgery: an SDK retrying a slow response does it by accident.
 *
 * Measured on the op door before this existed: two concurrent identical `fail`s
 * both simulated against the same pre-op state and both broadcast, and twenty of
 * them broadcast twenty times with no cap at all. **The key is `(op, subject)`
 * for every op, not `job_id` for `claim` alone** (R66) — leaving the one-shot
 * ops unqueued was defended on the grounds that the chain orders them, which is
 * exactly the on-chain enforcement that makes the loser revert after paying for
 * its own execution.
 *
 * What it does **not** claim to bound is races against external
 * self-submitters — a second node, or a provider submitting its own
 * transaction, is outside any in-process queue by definition. That residue is
 * accepted and priced into `gasFee`.
 *
 * ## Why it refuses rather than queues without limit
 *
 * The queue exists to stop the node racing itself; it is not a waiting room.
 * Past {@link MAX_QUEUE_DEPTH} the honest answer is "try again", not a
 * fabricated contract error — the queued request has not been simulated, and
 * reporting a gate it never evaluated would be a guess dressed as a verdict.
 * `429 busy` is retryable, and it is the one retryable refusal these doors have
 * that is entirely the node's own condition.
 *
 * The map entry is deleted when the last waiter leaves, so the map is bounded by
 * concurrent in-flight requests rather than by the number of subjects ever seen.
 *
 * ## Note on scope
 *
 * This is the **per-subject duplicate guard**. It is a different mechanism from
 * the relayer-account depth bound (R76), which bounds how many distinct subjects
 * may be in flight at once; the two do not merge and neither implies the other.
 *
 * One definition rather than two: `routes/ops.ts` and `routes/post.ts` each held
 * a verbatim copy, and a duplicated admission-control policy drifts — the depth
 * constant alone was spelled twice.
 */

/**
 * How many callers may be queued behind one subject.
 *
 * Exported so the tests that pin the `429 busy` path are written against the
 * bound rather than against a number copied out of here (R67).
 */
export const MAX_QUEUE_DEPTH = 8;

/**
 * Runs `fn` with at most one execution per key in flight, and refuses past
 * {@link MAX_QUEUE_DEPTH} rather than queueing without limit.
 *
 * `noun` is the plural the `429` message uses for the thing being queued
 * ("posts", "ops"), so an operator reading the log sees which door refused.
 */
export function subjectQueue(noun: string): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const queues = new Map<string, { tail: Promise<unknown>; depth: number }>();

  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = queues.get(key);
    if (existing !== undefined && existing.depth >= MAX_QUEUE_DEPTH) {
      throw new ApiError(429, "busy", `too many ${noun} are already queued for ${key}; retry shortly`);
    }

    const entry = existing ?? { tail: Promise.resolve(), depth: 0 };
    entry.depth += 1;
    queues.set(key, entry);

    // `.then(fn, fn)` rather than `await tail`: the queue must advance whether
    // the request in front succeeded or failed, and a rejected tail nobody
    // handles is an unhandled rejection that takes the process down.
    const run = entry.tail.then(fn, fn);
    entry.tail = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      entry.depth -= 1;
      if (entry.depth === 0 && queues.get(key) === entry) queues.delete(key);
    }
  };
}
