import { afterAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  anvilAdmin,
  BLOCK_TIME_MS,
  driveBlocks,
  mineTo,
  publicClientOf,
  refusesConnections,
  startNode,
  startNodeProcess,
  startRpcGate,
  waitFor,
  waitForCursor,
  waitForReady,
  waitForSocket,
  wipeProjection,
  type NodeProcess,
  type RpcGate,
} from "./support/harness.js";

/**
 * Scenario 4 — **readiness**.
 *
 * `GET /readyz` is `503` while the index is cold and `200` once it has caught
 * up, and every index-backed route answers the `not_ready` envelope in between.
 *
 * The gate is what makes *"a node answers from its index or not at all"* true.
 * Without it a cold node serves an empty book as though it were the market: a
 * `200 {jobs: []}` and a `200 {jobs: [...]}` are indistinguishable to a client,
 * which is exactly the failure a readiness probe exists to prevent.
 *
 * **Driven through the real `src/main.ts`, as its own process** (R82). The
 * window this scenario is about is a property of the boot *order* — listen, then
 * cold start — so a harness that sequenced it in-process would be asserting
 * against its own sequencing rather than the shipped binary's. That is R64/R65's
 * shape one level up from the stub, and it is what the previous round reported.
 * Here the process is spawned exactly as `npm start` runs it, and every request
 * crosses a real socket to it.
 *
 * The window is held open by a valve on `eth_getLogs` rather than by luck: a
 * full replay of this chain closes in about a second, which is not an interval a
 * test can reliably stand inside. Everything else the process asks the chain is
 * forwarded untouched, so `/evm/chain` and the head are the real chain's answers
 * throughout.
 *
 * The last scenario is the **reorg guard**, and it is the one thing here that
 * cannot be arranged through the capped proxy at all: `evm_snapshot` and
 * `evm_revert` are the test-only namespace `:8545` refuses outright, so they are
 * sent to the uncapped anvil on `:8546` while the node under test keeps reading
 * only `:8545` (R36).
 */

/**
 * How far past the snapshot the reorg scenario indexes before it reverts, and
 * how far past the cursor it then rebuilds.
 *
 * Small on purpose. The revert discards every block above the snapshot, so a
 * deep one would destroy chain history the earlier scenario files put there —
 * and the guard needs exactly one replaced block under the cursor to trip, not
 * many.
 */
const REORG_DEPTH = 5n;

let node: NodeProcess | undefined;
let gate: RpcGate | undefined;

afterAll(async () => {
  await node?.stop();
  await gate?.close();
});

describe("readiness", () => {
  it("refuses connections, then answers 503 not_ready, then 200 — through src/main.ts", async () => {
    gate = await startRpcGate();
    gate.hold();

    // `resetCursor` — a schema left over from an earlier run would already carry
    // a cursor, and this scenario would then measure nothing.
    node = await startNodeProcess(
      { schema: "vorq_devnet_readiness", rpcUrl: gate.url },
      { resetCursor: true },
    );

    // Nothing is listening yet. This is the assertion the previous boot order
    // could not get past: under *cold start first*, this stayed true for the
    // whole replay and a health check read the node as dead.
    expect(await refusesConnections(node.baseUrl)).toBe(true);

    // …and now it is listening, with an empty index, because `app.listen()` no
    // longer waits on the cold start. The first status the socket ever produced
    // is 503, not a 200 off an empty book.
    expect(await waitForSocket(node)).toBe(503);

    const cold = await node.json<{
      ready: boolean;
      reason: string;
      cursor: null;
      head_block: string;
      lag: null;
    }>("/readyz");

    expect(cold.status).toBe(503);
    expect(cold.body.ready).toBe(false);
    // `cold_start`, not `trailing`: the two are different operator situations —
    // one has never indexed, the other has fallen behind — and the envelope
    // distinguishes them.
    expect(cold.body.reason).toBe("cold_start");
    expect(cold.body.cursor).toBeNull();
    expect(cold.body.lag).toBeNull();
    // The head is real.
    expect(cold.body.head_block).toBeGreaterThan(0);

    // The process is inside its replay, not merely slow to start: the gate has
    // the first `eth_getLogs` in hand.
    expect(gate.seen()).toBeGreaterThan(0);

    // Every gated route, refused with the same envelope. `x-vorq-retryable` is
    // the contract a client switches on, never `error.type` (R57).
    for (const path of ["/evm/jobs", "/evm/asks", "/evm/providers", "/evm/models", "/v1/models"]) {
      const response = await node.request(path);
      const body = (await response.json()) as { error: { type: string } };
      expect(response.status, path).toBe(503);
      expect(body.error.type, path).toBe("not_ready");
      expect(response.headers.get("x-vorq-retryable"), path).toBe("true");
    }

    // The chain-backed routes are outside the gate and answer while cold — a
    // claim refused for a second because the index was catching up is a claim a
    // competitor takes (R22).
    const chainInfo = await node.request("/evm/chain");
    expect(chainInfo.status).toBe(200);
    await chainInfo.text();

    // …and now let the cold start run.
    gate.open();
    await waitForReady(node);

    const ready = await node.json<{ ready: boolean; reason: string; cursor: string; lag: string }>(
      "/readyz",
    );
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ ready: true, reason: "ready" });
    expect(BigInt(ready.body.cursor)).toBeGreaterThan(0n);
    // Inside `READY_LAG_BLOCKS`, which is what "ready" means — read off the
    // node's own configuration rather than restated, so the bound cannot drift
    // away from the one the node was actually given.
    expect(BigInt(ready.body.lag)).toBeLessThanOrEqual(BigInt(node.config.readyLagBlocks));

    // The gate is open: the same routes answer now.
    const jobs = await node.json<{ as_of_block: string }>("/evm/jobs");
    expect(jobs.status).toBe(200);
    expect(BigInt(jobs.body.as_of_block)).toBeGreaterThan(0n);

    // A SIGTERM ends it cleanly and the port closes with it — the ordinary stop,
    // as opposed to the failed boot below.
    const { baseUrl } = node;
    expect(await node.stop()).toBe(0);
    node = undefined;
    expect(await refusesConnections(baseUrl)).toBe(true);
  });

  /**
   * **The other half of listening first** (R82): a cold start that fails must
   * close the server and exit non-zero, not leave a process listening and
   * permanently not-ready.
   *
   * With the port open before the replay runs, an unhandled failure inside
   * `indexer.start()` would leave exactly that: a process a supervisor reads as
   * alive, answering `503 not_ready` forever, which it cannot recover from
   * because `Indexer.start()` is one-shot. The sequence here is deterministic
   * rather than raced — hold, observe the socket answering 503, then fail — so
   * the process is provably listening at the moment the cold start dies.
   */
  it("closes the server and exits non-zero when the cold start fails", async () => {
    const failing = await startRpcGate();
    failing.hold();

    const booting = await startNodeProcess(
      { schema: "vorq_devnet_readiness_boot_fail", rpcUrl: failing.url },
      { resetCursor: true },
    );

    try {
      // Listening, and not ready: the state the failure has to be cleaned out of.
      expect(await waitForSocket(booting)).toBe(503);

      failing.fail();

      // Non-zero, because a supervisor restart is the only repair for a consumed
      // one-shot cold start.
      const code = await booting.exited;
      expect(code, booting.output().slice(-2000)).toBe(1);

      // And the port is closed. A process that exited with the socket still open
      // would not be observable this way at all — this is the assertion that
      // separates "shut down" from "gave up and kept listening".
      expect(await refusesConnections(booting.baseUrl)).toBe(true);
    } finally {
      await booting.stop();
      await failing.close();
    }
  });

  /**
   * The bound, moved by one (R78). `READY_LAG_BLOCKS = 0` means *"ready
   * only when the cursor is exactly at the head"*, and on a chain producing
   * blocks continuously that is a state the node passes through and leaves. What
   * must never happen is a node reporting ready with a cursor further behind
   * than the configured bound — so the assertion is on the *relationship*,
   * evaluated from the envelope the node itself published.
   *
   * Deleting the `head - cursor <= readyLagBlocks` comparison in
   * `indexer.status()` makes `ready` true at any lag and turns this red.
   *
   * In-process, deliberately: this one is about `status()`'s arithmetic and not
   * about the boot order, and it samples across a moving head. The sampling
   * budget is a **block time** rather than a fixed 100 ms: this chain produces a
   * block every 2 s, and twenty samples 100 ms apart would all land inside one
   * block and see a single instant twenty times over.
   */
  it("never reports ready with a lag past READY_LAG_BLOCKS", async () => {
    const strict = await startNode(
      { schema: "vorq_devnet_readiness_strict", readyLagBlocks: 0, blockTimeMs: BLOCK_TIME_MS },
      { coldStart: false },
    );
    try {
      await strict.indexer.start();

      // Sampled repeatedly while the chain moves under the node, so the check
      // sees both sides of the boundary rather than one lucky instant. Ten
      // samples at half a block each span five blocks.
      for (let i = 0; i < 10; i++) {
        const { status, body } = await strict.json<{
          ready: boolean;
          cursor: string | null;
          head_block: string | null;
          lag: string | null;
        }>("/readyz");

        if (status === 200) {
          expect(body.ready).toBe(true);
          expect(body.lag).not.toBeNull();
          expect(BigInt(body.lag!)).toBeLessThanOrEqual(0n);
        } else {
          expect(status).toBe(503);
          expect(body.ready).toBe(false);
        }
        await new Promise((resolve) => setTimeout(resolve, BLOCK_TIME_MS / 2));
      }
    } finally {
      await strict.stop();
    }
  });

  /**
   * **The reorg guard, against a chain that really does reorg.**
   *
   * `/readyz` distinguishes `reorg` from `trailing` because they are different
   * operator situations: a trailing node catches up on its own, and a forked one
   * never does — the blocks it is close to are not the blocks it applied, and
   * only a rebuild clears it. The unit suite proves the arithmetic; this proves
   * the node reaches that state against a real endpoint, on real blocks it
   * really indexed.
   *
   * The chain is driven with `evm_snapshot` / `evm_revert` on the **uncapped**
   * anvil, because the proxy refuses the whole test-only namespace — fixture
   * setup, exactly as {@link mineTo} is, while the node reads only `:8545`
   * throughout (R36).
   *
   * The sequence, and every step of it is load-bearing:
   *
   *   1. index to the head, so the cursor rests on a block this node applied;
   *   2. snapshot, then let the chain and the cursor move past the snapshot;
   *   3. revert — the chain is now shorter than the cursor, which is the
   *      *lagging endpoint* the guard deliberately tolerates, so nothing trips
   *      yet;
   *   4. put a transaction nothing else could have produced into the first
   *      replacement block, and mine past the cursor again. The block at the
   *      cursor's height is now a different block, and the guard trips on the
   *      first tick that sees it.
   *
   * Step 4's transaction is not decoration. Empty blocks are a function of their
   * parent and their timestamp, and `anvil_mine` stamps a whole batch with one
   * time — so a replacement run of empty blocks can reproduce the originals
   * *exactly*, leaving the hash at the cursor unchanged and the guard with
   * nothing to see. One unique transaction below the cursor makes every block
   * above it different by construction.
   *
   * And the mine is not optional either: a chain left short would leave the node
   * retrying a range forever and answering `trailing`, which is the same `503`
   * for a different reason and would pass a weaker assertion.
   */
  it("answers 503 reorg after the chain it indexed is replaced", async () => {
    const forked = await startNode(
      { schema: "vorq_devnet_readiness_reorg", blockTimeMs: BLOCK_TIME_MS },
      { coldStart: false },
    );
    try {
      // Wiped rather than resumed: this scenario ends with a projection holding
      // blocks the chain no longer has, which is exactly the state a *later* run
      // must not start from.
      await wipeProjection(forked.db);
      await forked.indexer.start();
      await waitForReady(forked);

      const { chainId } = forked.config.addresses;
      const client = publicClientOf(chainId);
      const snapshot = await anvilAdmin<Hex>("evm_snapshot", []);

      // Past the snapshot, and indexed: the cursor now rests on a block that the
      // revert is about to destroy. Without this the revert would land above the
      // cursor and the guard would have nothing to notice.
      const atSnapshot = await client.getBlockNumber({ cacheTime: 0 });
      const indexedPast = atSnapshot + REORG_DEPTH;
      await mineTo(chainId, indexedPast);
      await waitForCursor(forked.db, indexedPast);

      // Back to the snapshot. The chain is now *shorter* than the cursor, which
      // the guard tolerates on purpose — it is indistinguishable from a failover
      // to an endpoint that is itself behind.
      expect(await anvilAdmin<boolean>("evm_revert", [snapshot])).toBe(true);

      // …and now it grows back, on different blocks: one real transaction first,
      // then depth. The block at the cursor's height exists again and hashes
      // differently, so the guard trips.
      await driveBlocks(chainId, 1);
      await mineTo(chainId, indexedPast + REORG_DEPTH);

      const reorged = await waitFor(
        "the node to report a reorg",
        async () => {
          const answer = await forked.json<{ ready: boolean; reason: string; cursor: string }>(
            "/readyz",
          );
          return answer.body.reason === "reorg" ? answer : null;
        },
        // The readiness probe is cached for a block time and the indexer ticks on
        // the same interval, so the verdict cannot arrive sooner than two ticks.
        { timeoutMs: 120_000, intervalMs: BLOCK_TIME_MS / 2 },
      );

      expect(reorged.status).toBe(503);
      expect(reorged.body.ready).toBe(false);
      // Not `trailing`: a forked node reports a state no amount of waiting
      // recovers from, and conflating the two is the defect this distinguishes.
      expect(reorged.body.reason).toBe("reorg");

      // Terminal, and it stays terminal: the loop has ended, so the node does not
      // quietly recover by indexing the replacement chain on top of what it
      // applied. Sampled after a further block, which is long enough for a tick
      // that was going to continue to have continued.
      await new Promise((resolve) => setTimeout(resolve, BLOCK_TIME_MS * 2));
      const still = await forked.json<{ reason: string }>("/readyz");
      expect(still.status).toBe(503);
      expect(still.body.reason).toBe("reorg");

      // And the gate is closed on the index-backed routes, which is what the
      // reason exists to protect.
      const jobs = await forked.json<{ error: { type: string } }>("/evm/jobs");
      expect(jobs.status).toBe(503);
      expect(jobs.body.error.type).toBe("not_ready");
    } finally {
      await forked.stop();
    }
  }, 300_000);
});
