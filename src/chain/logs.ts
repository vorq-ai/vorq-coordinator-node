import type { Log, PublicClient } from "viem";
import type { Address } from "../config.js";

/** A span of blocks to read logs for, and the widest window the endpoint allows. */
export interface LogRange {
  /** Contracts to filter to. All topics are read — the reducer decides what it wants. */
  address: readonly Address[];
  fromBlock: bigint;
  /** Inclusive. */
  toBlock: bigint;
  /** Largest number of blocks one `eth_getLogs` may cover, bounds inclusive. */
  cap: number;
}

/**
 * JSON-RPC "limit exceeded", which is what a range-capped endpoint answers with.
 * viem maps it to `LimitExceededRpcError`, preserving the code.
 */
const LIMIT_EXCEEDED = -32005;

/**
 * Endpoints disagree about how they report an oversized range — some use
 * -32005, others report it in the message under a different code — so the
 * message is checked too. Only phrasings that specifically mean "the range or
 * its result set was too big" are listed; a generic upstream fault must not
 * match, because halving would then hide a real failure behind a retry loop.
 */
const RANGE_MESSAGE =
  /block range|range exceeded|range too large|too many blocks|query returned more than|more than \d+ results|log response size|exceeds? (?:the )?maximum (?:block )?range/i;

/** Walks the cause chain: viem wraps the transport error more than one deep. */
function isRangeError(error: unknown): boolean {
  for (let current = error, depth = 0; current != null && depth < 10; depth++) {
    const node = current as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    if (node.code === LIMIT_EXCEEDED) return true;
    for (const text of [node.message, node.details, node.shortMessage]) {
      if (typeof text === "string" && RANGE_MESSAGE.test(text)) return true;
    }
    current = node.cause;
  }
  return false;
}

/**
 * Orders logs by `(blockNumber, logIndex)`.
 *
 * The three VORQ contracts interleave by `logIndex` inside a block, and this
 * reader queries them together, so per-chunk order does not survive the merge
 * (R31). The reducer replays this stream in order; getting it wrong reorders
 * events within a block.
 */
function byPosition(a: Log, b: Log): number {
  const blockA = a.blockNumber ?? 0n;
  const blockB = b.blockNumber ?? 0n;
  if (blockA !== blockB) return blockA < blockB ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/**
 * Reads every log the given contracts emitted in `[fromBlock, toBlock]`,
 * chunked to stay under the endpoint's `eth_getLogs` range cap.
 *
 * The window starts at `cap` and saturates downward: when a request is refused
 * for being too wide, the window halves and the same chunk is retried, and the
 * size that finally worked is kept for the rest of the range. That matters
 * because a cap lower than the configured one is a property of the endpoint,
 * not of the chunk — rediscovering it on every window would provoke the same
 * refusals over and over.
 *
 * Chunking is the only option: the filter API is capped the same way and is not
 * a way around it (R36).
 *
 * Throws if a single-block window is still refused. That is an upstream fault
 * rather than a range problem, and returning the logs gathered so far would
 * hand the reducer a silently truncated stream.
 */
export async function fetchLogsChunked(client: PublicClient, range: LogRange): Promise<Log[]> {
  const { address, fromBlock, toBlock } = range;
  if (toBlock < fromBlock) return [];

  const collected: Log[] = [];
  const addresses = [...address];
  let window = BigInt(Math.max(1, Math.floor(range.cap)));
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    // `- 1n` because the bound is inclusive: a window of `cap` blocks starting
    // at `cursor` ends at `cursor + cap - 1`. Ending it at `cursor + cap` asks
    // for one block too many and is refused on every chunk.
    const last = cursor + window - 1n;
    const end = last < toBlock ? last : toBlock;

    try {
      const chunk = await client.getLogs({ address: addresses, fromBlock: cursor, toBlock: end });
      // Appended one at a time rather than spread: a busy chunk can hold more
      // logs than an engine accepts as call arguments, and `push(...chunk)`
      // would fail on exactly the ranges that matter most.
      for (const log of chunk) collected.push(log);
      cursor = end + 1n;
    } catch (error) {
      if (!isRangeError(error)) throw error;

      // Halve the span actually attempted, not the nominal window: the last
      // chunk of a range is clamped to `toBlock` and is usually narrower.
      const attempted = end - cursor + 1n;
      if (attempted <= 1n) {
        throw new Error(
          `eth_getLogs was refused as an oversized range for a single block (${cursor}); ` +
            "the range cannot be narrowed further, so this is an upstream fault",
          { cause: error },
        );
      }
      window = attempted / 2n;
    }
  }

  return collected.sort(byPosition);
}
