import { BlockNotFoundError, type Log } from "viem";
import { bloomHasAny } from "../chain/bloom.js";
import type { Chain, Header } from "../chain/client.js";
import { fetchLogsChunked } from "../chain/logs.js";
import type { Address, Config } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import { reduceRange } from "./reducer.js";

/**
 * The service that drives the reducer: cold start, steady-state polling, and
 * readiness.
 *
 * Three properties hold it up, and each of them is one of the reducer's
 * invariants seen from the outside:
 *
 *   * **The cursor advances only on success.** Every failure — an RPC fault, a
 *     rolled-back transaction, an orphan the reducer refused — leaves the cursor
 *     where it was, and the next poll re-closes exactly the same range. That is
 *     the whole retry mechanism: no backoff state, no dead-letter queue, no
 *     self-heal pass. A trusted RPC does not silently omit logs, and a
 *     deterministic reducer bug was never replay-fixable.
 *   * **Throws propagate.** `reduceRange` throws rather than skipping on an
 *     orphan, an out-of-order stream, a pending log or a log past `toBlock`.
 *     Nothing here catches those to carry on: a throw means the projection would
 *     otherwise diverge from the chain, and swallowing it converts a loud
 *     failure into silent corruption. The one place a failure is caught is the
 *     poll loop, which logs it and retries the same range on the next tick.
 *   * **One catch-up at a time.** Two overlapping reduces of the same range are
 *     precisely the out-of-order condition the reducer refuses, so every
 *     advance takes the same lock.
 */

/** What the read API's readiness check needs to know. */
export interface IndexerStatus {
  /**
   * The last block whose logs are fully applied, or `null` when nothing has been
   * indexed yet. `null` rather than a synthesised `deploy_block - 1`: on a fresh
   * devnet the two are indistinguishable by arithmetic, and one of them means
   * "caught up" while the other means "has not started".
   */
  cursor: bigint | null;
  /**
   * The newest head the indexer's own loop read. Never re-asked here: the loop
   * already reads it every tick, and a probe per request would double the node's
   * RPC load for an answer it holds.
   */
  head: bigint;
  /**
   * A cursor exists, nothing forked, the head is **at or past** it by no more
   * than `READY_LAG_BLOCKS`, and that head was read within the time those blocks
   * take.
   *
   * Both ends of that range are load-bearing. `head - cursor <= lag` alone is
   * satisfied by every negative lag, so a head *behind* the cursor — a failover
   * to a lagging endpoint, or a chain that got shorter — would read as the most
   * caught-up a node can be, which is the one direction readiness must never
   * err in.
   */
  ready: boolean;
  /**
   * The block the reorg guard tripped on, or `null`. Set once and never
   * cleared: indexing is stopped for the life of the process.
   */
  forked: bigint | null;
}

export interface Indexer {
  /**
   * Replays every topic the three VORQ contracts emitted, from the deploy block
   * up to the head, in windows (see {@link catchUpWindows}).
   *
   * Full replay is what makes orphan repair unnecessary: every exit's `Posted`
   * is in range by construction, so no horizon math is needed. Where a cursor
   * already exists this resumes from it rather than re-reading what is applied;
   * on an empty database — the case the name describes — that is the deploy
   * block, and this is a full replay.
   */
  coldStart(): Promise<void>;
  /**
   * Advances the index to the current head. Identical to
   * {@link Indexer.coldStart} by construction, and deliberately so: a poll after
   * a long stall *is* a cold start, and giving them separate code paths is how
   * one of the two ends up handing the log reader an unbounded span.
   */
  poll(): Promise<void>;
  /**
   * Reads the cursor, never the chain. Rejects when no head has been read within
   * `READY_LAG_BLOCKS × BLOCK_TIME_MS` of an unforked node: it cannot see the
   * chain, so it cannot say how far behind it is.
   */
  status(): Promise<IndexerStatus>;
  /**
   * Cold starts, then polls every `block_time_ms`. Resolves once the cold start
   * has landed, so a caller can treat that as the node's boot barrier; if the
   * cold start fails, this rejects and no loop is scheduled.
   *
   * One-shot: a stopped indexer is not restarted, and a second `start()` throws
   * rather than running two loops against one cursor.
   */
  start(): Promise<void>;
  /** Stops the loop and waits for any advance still in flight. Terminal. */
  stop(): Promise<void>;
}

/** A span of blocks read and reduced as one unit. */
export interface CatchUpWindow {
  from: bigint;
  /** Inclusive. */
  to: bigint;
}

/**
 * Tiles `[from, to]` into consecutive windows of at most `span` blocks, with no
 * gap and no overlap. Yields nothing when there is nothing to close.
 *
 * This is what bounds the indexer's memory. `fetchLogsChunked` accumulates every
 * log of the range it is given before returning — chunking is how it stays under
 * the endpoint's `eth_getLogs` cap, not a way of streaming — so handing it
 * `deploy_block → head` in one piece would hold the whole chain's logs in memory
 * at once, on exactly the boot where the chain is longest. Each window is read
 * and reduced on its own instead, and `span` is the endpoint's own cap: the
 * indexer therefore never holds more than a single `eth_getLogs` window's worth
 * of logs, however long the chain gets.
 *
 * Committing per window is the second half of it. A cold start that fails in its
 * hundredth window keeps the ninety-nine that landed and resumes from there,
 * because the cursor moved with them.
 */
export function* catchUpWindows(
  from: bigint,
  to: bigint,
  span: bigint,
): Generator<CatchUpWindow> {
  if (span < 1n) throw new RangeError(`a catch-up span must be at least one block, got ${span}`);

  for (let start = from; start <= to; start += span) {
    // `- 1n` because the bound is inclusive: a window of `span` blocks starting
    // at `start` ends at `start + span - 1`.
    const last = start + span - 1n;
    yield { from: start, to: last < to ? last : to };
  }
}

/**
 * The last block whose logs are applied, or `null` when nothing has been.
 *
 * The column is `BIGINT`, so it reads back as a `bigint` and must be compared
 * against `bigint`s (R45, R49). Exported because the cursor is authoritative for
 * every consumer of the projection, not just for this module: reconcile writes
 * only at or behind it (R10).
 */
export async function cursorBlock(db: Queryable): Promise<bigint | null> {
  const { rows } = await db.query<{ block_number: bigint }>(
    "SELECT block_number FROM cursor WHERE id = 1",
  );
  return rows[0]?.block_number ?? null;
}

/**
 * The widest gap the header path closes. Each block past the head costs one
 * header read; past three that stops being cheaper than one ranged
 * `eth_getLogs`, and the range path takes over.
 */
const HEADER_SPAN = 3n;

/**
 * What a tripped guard throws, everywhere it is thrown. One spelling, because
 * `/readyz`'s `reorg` reason and an operator's log line are the same event.
 */
const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const reorgStop = (block: bigint): Error =>
  new Error(`reorg under the cursor at block ${block}: indexing is stopped. Rebuild the projection.`);

/** The cursor with the hash the block under it was indexed with, for the guard. */
async function cursorRow(db: Queryable): Promise<{ block: bigint; hash: string } | null> {
  const { rows } = await db.query<{ block_number: bigint; block_hash: string }>(
    "SELECT block_number, block_hash FROM cursor WHERE id = 1",
  );
  return rows[0] === undefined ? null : { block: rows[0].block_number, hash: rows[0].block_hash };
}

/**
 * Builds the indexer. Touches neither the chain nor the database — the caller
 * drives it, with {@link Indexer.start} or a bare {@link Indexer.coldStart}.
 */
export function startIndexer(chain: Chain, db: Db, config: Config): Indexer {
  // Every topic, filtered to the three VORQ contracts. The reducer decides what
  // it stores; nothing is filtered by topic here, so an event added to the
  // projection needs no change on this side.
  const contracts: readonly Address[] = [
    config.addresses.jobRegistry,
    config.addresses.providerRegistry,
    config.addresses.askRegistry,
  ];
  const deployBlock = BigInt(config.addresses.deployBlock);
  const span = BigInt(config.getLogsCap);
  // Converted once, at the boundary, as R49 requires of every widened value.
  // Stated precisely, because the imprecise version of this is how a reader
  // talks themselves into the wrong fix: `<=` between a `bigint` and a `number`
  // is arithmetically *correct* in JavaScript, and TypeScript does not flag it
  // (checked). R49's trap is `===`, `includes` and `indexOf`, which compare
  // wrong and fail closed. Converting here costs nothing and means the readiness
  // test never has to be re-litigated against that distinction.
  const readyLagBlocks = BigInt(config.readyLagBlocks);
  const staleMs = config.readyLagBlocks * config.blockTimeMs;

  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  /** The block the guard tripped on. Terminal: nothing ever clears it. */
  let forked: bigint | null = null;
  /** The last head the loop read, and when. Readiness is served from this. */
  let seen: { head: bigint; at: number } | null = null;

  /**
   * Runs `work` unless an advance is already running, in which case the caller
   * joins that one.
   *
   * Joining rather than queueing is the point: a second advance would read
   * `cursor + 1` before the first had committed and reduce the same range twice,
   * which is the orphan/out-of-order condition `reduceRange` throws on. The
   * joiner sees the result of the run it joined, failure included — it never got
   * to try its own, and reporting someone else's success would be worse.
   */
  function exclusive(work: () => Promise<void>): Promise<void> {
    if (inflight !== null) return inflight;

    const run = work();
    inflight = run;
    // Released on success and failure alike, so a fault is retried on the next
    // call rather than latched forever. Both branches are handled, so this
    // derived promise never goes unhandled; the caller still observes `run`.
    const release = () => {
      if (inflight === run) inflight = null;
    };
    run.then(release, release);
    return run;
  }

  /**
   * The reorg guard: trips when the block the cursor rests on is no longer the
   * block that was indexed.
   *
   * One hash answers the whole question. A reorg at block X replaces every block
   * from X up — each one names its parent — so a cursor whose own block still
   * hashes the same sits on a chain that is intact underneath it, and one whose
   * block changed may have applied anything from X on out of a chain that is
   * gone. There is no unwind: the node stops, reports not-ready, and an operator
   * rebuilds from `deployBlock` (`dropDerived` + restart).
   */
  async function verifyCursor(
    at: { block: bigint; hash: string } | null,
    head: bigint,
  ): Promise<void> {
    if (at === null) return;

    let current: string;
    try {
      current = await chain.blockHash(at.block);
    } catch (error) {
      // The endpoint cannot produce the block the cursor rests on, and what that
      // means depends on where its head is.
      //
      //   * **Head at or past it.** There is no innocent reading: the endpoint
      //     claims a chain at least this long and cannot produce one of its
      //     blocks. Treated as a replacement of it, and it trips.
      //   * **Head behind it.** Indistinguishable from the lagging endpoint this
      //     module already tolerates by refusing to rewind — a failover to a
      //     node that is still syncing answers exactly this way, and latching
      //     `forked` on it would turn a transient failover into a stop only a
      //     rebuild clears. It is re-raised instead, so the tick fails, the
      //     cursor stays put and the range is retried; readiness is already
      //     false while the head is behind the cursor. A chain that really did
      //     get shorter is caught the moment it grows back past the cursor,
      //     because the block there then hashes differently.
      if (!(error instanceof BlockNotFoundError) || head < at.block) throw error;
      forked = at.block;
      throw reorgStop(at.block);
    }

    if (sameHash(current, at.hash)) return;
    forked = at.block;
    throw reorgStop(at.block);
  }

  /**
   * Closes a gap of at most {@link HEADER_SPAN} blocks from headers alone.
   *
   * * **Linked, not re-read.** Every header names its parent, so the chain from
   *   the cursor to the head is proven by `parentHash` alone. The lowest header
   *   not naming the cursor's hash is the block under the cursor replaced — the
   *   guard trips. A break higher up is a reorg that landed between two header
   *   reads, above anything applied: the tick fails and retries.
   * * **Logs only where the bloom says so,** and read by `blockHash` (EIP-234):
   *   pinned to the very header that was linked, so no reorg can slip a
   *   different block's logs in between. An idle block costs no `eth_getLogs`.
   */
  async function catchUpHeaders(
    at: { block: bigint; hash: string },
    head: Header,
  ): Promise<void> {
    const headers: Header[] = [head];
    for (let n = head.number - 1n; n > at.block; n--) headers.unshift(await chain.header(n));

    for (let i = headers.length - 1; i > 0; i--) {
      if (!sameHash(headers[i]!.parentHash, headers[i - 1]!.hash)) {
        throw new Error(`block ${headers[i]!.number} does not extend ${headers[i - 1]!.number}: reorg in flight, retrying`);
      }
    }
    if (!sameHash(headers[0]!.parentHash, at.hash)) {
      forked = at.block;
      throw reorgStop(at.block);
    }

    const logs: Log[] = [];
    for (const header of headers) {
      if (!bloomHasAny(header.logsBloom, contracts)) continue;
      const block = await chain.publicClient.getLogs({ address: [...contracts], blockHash: header.hash });
      for (const log of block) logs.push(log);
    }
    logs.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
        : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1,
    );
    await reduceRange(db, logs, head.number, head.hash);
  }

  /** Reads and reduces `[cursor + 1, head]`, one bounded window at a time. */
  async function catchUp(header: Header): Promise<void> {
    if (forked !== null) throw reorgStop(forked);
    const head = header.number;
    // The cursor is authoritative, and it is never overridden by `deploy_block`:
    // starting past it would skip blocks nothing had applied, and the first
    // event landing on a row that was never created is an orphan the reducer
    // refuses. `deploy_block` bounds the replay only when there is no cursor.
    let at = await cursorRow(db);

    if (at !== null && head === at.block) {
      // Level with the head: its hash is the guard, and nothing else is read.
      if (sameHash(header.hash, at.hash)) return;
      forked = at.block;
      throw reorgStop(at.block);
    }
    if (at !== null && head > at.block && head - at.block <= HEADER_SPAN) {
      return catchUpHeaders(at, header);
    }

    const from = at === null ? deployBlock : at.block + 1n;

    // No window is produced when `head < from`, which is how a head that reports
    // lower than what is applied — an RPC failover to a node that is itself
    // behind — leaves the cursor alone instead of rewinding it to claim less
    // than the index holds.
    let guarded = false;
    for (const window of catchUpWindows(from, head, span)) {
      // **Three reads, in this order, and the order is the guard.** A reorg can
      // land between any two of them, so each ordering decision is the one that
      // leaves no interleaving unaccounted for.
      //
      //   * **The window's hash, first.** Its rows are then committed under the
      //     hash the chain carried *before* they were read. Read after the logs
      //     instead and a reorg in between stores the replacement chain's hash
      //     over the old chain's rows: self-consistent, matching forever, never
      //     detected.
      //   * **The cursor check, second — after that hash and before the logs.**
      //     Taken first, a reorg landing between it and the window's hash would
      //     leave the check passing on the old chain while both the hash and the
      //     logs come from the new one — again a self-consistent pair, and the
      //     ranges already committed below the cursor would keep the old chain's
      //     rows with nothing left to notice. Taken here, that same reorg is
      //     what the check itself sees, and it trips.
      //   * **The logs, last.** A reorg after the check gives new-chain rows
      //     under an old-chain hash, which mismatches at the very next check.
      //
      //   * **And the check runs before every window, not once per tick.** A
      //     catch-up commits several ranges and a reorg can land between any two
      //     of them; checked only at the top, the ranges that already committed
      //     would never be re-examined. Every range is verified against the
      //     chain immediately before the next one extends it.
      //
      // The cost is one `eth_getBlockByNumber` per window. The steady state never
      // gets here: gaps up to `HEADER_SPAN` take the header path.
      const toHash = await chain.blockHash(window.to);
      await verifyCursor(at, head);
      guarded = true;

      const logs = await fetchLogsChunked(chain.publicClient, {
        address: contracts,
        fromBlock: window.from,
        toBlock: window.to,
        cap: config.getLogsCap,
      });
      // Called even when the window carried no logs: `reduceRange` writes the
      // cursor for an empty range too, and short-circuiting on an empty result
      // would leave a chain with no VORQ activity looking permanently
      // un-indexed, and therefore never ready.
      await reduceRange(db, logs, window.to, toHash);
      // Carried rather than re-read: this is exactly the pair just committed.
      at = { block: window.to, hash: toHash };
    }

    // Nothing to close — the index is level with the head. The guard still runs,
    // so a node that is caught up reports a reorg under its cursor on the tick
    // it happens rather than waiting for a block that extends the chain.
    if (!guarded) await verifyCursor(at, head);
  }

  const advance = (): Promise<void> =>
    exclusive(async () => {
      const head = await chain.head();
      // Recorded before the catch-up, so a tick whose logs fail still reports
      // how far behind it is.
      seen = { head: head.number, at: Date.now() };
      await catchUp(head);
    });

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, config.blockTimeMs);
  }

  async function tick(): Promise<void> {
    try {
      await advance();
    } catch (error) {
      // The only caught failure in this module, and it is caught to retry the
      // same range rather than to carry on past it: the cursor did not move, so
      // the next tick re-closes the range this one failed on. A loop that died
      // here would need a process restart to index again after a transient RPC
      // fault. A failure that is not transient keeps being logged, and readiness
      // turns false as the head pulls away from the cursor.
      console.error("indexer:", error);
    }
    // A tripped guard is the one failure that is not retried: the range under
    // the cursor is gone, so re-reading it would apply the replacement chain on
    // top of the projection it replaced. The loop ends here and `/readyz`
    // answers `reorg` until an operator rebuilds.
    if (forked !== null) return;
    schedule();
  }

  return {
    coldStart: advance,
    poll: advance,

    async status() {
      const cursor = await cursorBlock(db);
      // A head older than the lag's worth of blocks measures a wedged loop, not
      // the chain. A forked loop has stopped on purpose and keeps its last head.
      if (seen === null || (forked === null && Date.now() - seen.at > staleMs)) {
        throw new Error("no chain head read within the ready lag");
      }
      const head = seen.head;
      return {
        cursor,
        head,
        // A forked node is never ready however close its cursor is: the blocks
        // it is close to are not the ones it applied. Nor is a node the head is
        // *behind*: the index holds blocks this endpoint has not reached, and
        // the subtraction alone would call that perfectly caught up.
        ready:
          forked === null &&
          cursor !== null &&
          head >= cursor &&
          head - cursor <= readyLagBlocks,
        forked,
      };
    },

    async start() {
      if (started) throw new Error("the indexer is already started");
      started = true;
      await advance();
      schedule();
    },

    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // The advance in flight is awaited so the caller can close the pool behind
      // this without pulling a connection out from under a transaction. Its
      // failure is not this caller's to observe — whoever started it has it.
      await Promise.allSettled([inflight]);
    },
  };
}
