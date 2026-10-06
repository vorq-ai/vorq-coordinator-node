import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addressesFile,
  CHAIN_ID,
  isLimitExceeded,
  PROXY_RANGE_CAP,
  publicClientOf,
  snapshotTable,
  startNode,
  waitForReady,
  wipeProjection,
  type NodeOptions,
  type RunningNode,
} from "./support/harness.js";

/**
 * Scenario 3 — **range-cap chunking**.
 *
 * Every `eth_getLogs` on this stack goes through the proxy on `:8545`, which
 * refuses a span wider than `RANGE_CAP` with `-32005`. That is not a fixture
 * quirk: it is what every hosted RPC endpoint does, and chunking is the only way
 * round it — the filter API is capped the same way (R36), and `:8546` is
 * uncapped anvil for debugging only.
 *
 * Two halves:
 *
 *   1. **Configured correctly** (`GETLOGS_CAP = 5000`, the proxy's own cap):
 *      a full cold start from `deploy_block` succeeds and never provokes a
 *      refusal.
 *   2. **Mis-configured** (`GETLOGS_CAP = 50000`): the first window is
 *      refused, the chunker halves and retries, and the cold start still
 *      completes with the identical projection.
 *
 * **R8, and it is the reason this scenario makes its own chain.** The failure R8
 * names is a scenario that "asserts a `-32005` that its own request cannot
 * trigger": on a young chain, `deployBlock → HEAD` is under the cap and a client
 * cap of 50 000 produces a request of a couple of dozen blocks, which is refused
 * by nothing.
 *
 * The precondition used to be *checked* and left to luck — and luck is what it
 * was. `make down` discards the chain and the next `make up` rebuilds it from the
 * pinned fork block, so **a shallow chain is the normal state**. This scenario
 * passed once against a stack that had been running long enough to accumulate
 * 79 471 blocks and failed on a clean one, which makes it not an acceptance gate
 * but a question about machine uptime.
 *
 * **The depth comes from the fork's own history, not from mining it.** This is a
 * fork of a live network: there are 47 million real blocks behind the pin, and
 * the VORQ contracts existed in none of them. So the two nodes here are handed a
 * replay floor {@link LOWERED_BY} blocks **below** the book's `deployBlock` — a
 * range that is legitimately, verifiably empty of anything this projection could
 * record — and the span the chunker has to cross is then wider than the
 * misconfigured cap by construction. Nothing is mined, and the depth assertion
 * below can no longer fail for a reason that has nothing to do with chunking.
 *
 * Two consequences, both deliberate:
 *
 *   * **The projections still compare equal.** A floor below `deployBlock` adds
 *     only empty windows, so both nodes build the same book the rest of the
 *     suite sees — which is what makes the byte-identical comparison at the end
 *     still mean something.
 *   * **The proxy still refuses the oversized request with `-32005`.** The cap
 *     is on the *span asked for*, not on what the range contains, so a 50 000
 *     block window over pre-deploy history is refused exactly as one over live
 *     history would be. That refusal is the whole scenario and it is untouched.
 *
 * Ranges below the pin are not anvil's own: it serves them from the upstream it
 * forked, so these replays are **slower than the rest of the suite** — hence the
 * raised timeouts here. Slower, not weaker: every assertion is the one it was.
 *
 * The floor is handed over as `ADDRESSES_JSON` rather than by editing the
 * published file, because `state/addresses.json` is what every *other* scenario
 * reads and what the stack itself publishes. The loader takes one or the other
 * and refuses both at once, so these nodes' environment drops `ADDRESSES_FILE`.
 *
 * Nothing about what is asserted changed. The client's cap is still 50 000 and is
 * not raised to make the refusal easier; the proxy's own `RANGE_CAP` is still
 * left alone, because it is shared stack state this suite does not mutate; and
 * the refusal is still a real `-32005` from the real proxy on the endpoint the
 * node reads through. This scenario now reaches for no cheatcode at all — the
 * depth is the fork's own history — and the node under test still talks only to
 * 8545 (R36).
 *
 * **R42** — viem retries `-32005` by default, so each refused window costs four
 * round trips rather than one. Every assertion here is on the **outcome**: that
 * a refusal happened at all, that the windows narrowed, and that the projection
 * came out the same. Nothing counts calls.
 */

const CORRECT_SCHEMA = "vorq_devnet_range_cap_ok";
const OVERSIZED_SCHEMA = "vorq_devnet_range_cap_wide";

/** The mis-configured cap. Ten times the proxy's, so the first window cannot pass. */
const MISCONFIGURED_CAP = 50_000;

/**
 * How far below the book's own `deployBlock` these two nodes start replaying.
 *
 * One block more than the misconfigured cap, so the very first window the
 * chunker asks for is a full `MISCONFIGURED_CAP` blocks rather than one clamped
 * to the head — which is the difference between provoking a real `-32005` and
 * proving nothing (R8).
 */
const LOWERED_BY = BigInt(MISCONFIGURED_CAP) + 1n;

let correct: RunningNode | undefined;
let wide: RunningNode | undefined;
let head = 0n;
let deployBlock = 0n;
/** The published book, with the replay floor lowered into pre-deploy history. */
let loweredAddresses = "";

beforeAll(async () => {
  const book = addressesFile();
  deployBlock = BigInt(Number(book.deployBlock)) - LOWERED_BY;
  loweredAddresses = JSON.stringify({ ...book, deployBlock: Number(deployBlock) });
  head = await publicClientOf(CHAIN_ID).getBlockNumber({ cacheTime: 0 });
});

/**
 * A node of this scenario's: the lowered floor inline, and no `ADDRESSES_FILE`.
 *
 * `loadConfig` refuses an environment carrying both — "pick one" — so dropping
 * the path is not tidiness, it is the only way this node boots.
 */
const loweredFloor = (options: NodeOptions): NodeOptions => ({
  ...options,
  env: { ...options.env, ADDRESSES_FILE: undefined, ADDRESSES_JSON: loweredAddresses },
});

afterAll(async () => {
  await correct?.stop();
  await wide?.stop();
});

const DERIVED: readonly [table: string, order: string][] = [
  ["jobs", "job_id"],
  ["providers", "provider_id"],
  ["models", "model_id"],
  ["allowlist", "key"],
  ["asks_chain", "provider_id, model_id, sla"],
];

describe("range cap", () => {
  it("cold starts through the capped proxy with the matching cap, unrefused", async () => {
    correct = await startNode(loweredFloor({ schema: CORRECT_SCHEMA }), { coldStart: false });
    await wipeProjection(correct.db);
    await correct.indexer.start();
    await waitForReady(correct);

    const getLogs = correct.rpc.filter((call) => call.method === "eth_getLogs");
    // A full replay of a chain this long is many windows, which is the point:
    // a single-window replay would prove nothing about chunking.
    expect(getLogs.length).toBeGreaterThan(1);
    expect(getLogs.some((call) => isLimitExceeded(call.error))).toBe(false);

    // Every request is inside the cap, bounds inclusive. The `- 1` in the
    // chunker's `cursor + window - 1` is what makes this true; without it every
    // window asks for one block too many and is refused on the first chunk.
    for (const call of getLogs) {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }];
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      expect(span).toBeLessThanOrEqual(BigInt(PROXY_RANGE_CAP));
    }
  }, 900_000);

  it("survives a mis-configured cap: -32005 provokes adaptive splitting", async () => {
    // R8's precondition. It holds by construction now — the floor is
    // `LOWERED_BY` blocks under a `deployBlock` the chain has already passed —
    // and it is still asserted, because a span the chunker cannot fill is
    // exactly the way this scenario passes while exercising nothing, and an
    // assertion that can only ever be true costs a line and catches the day the
    // arithmetic above changes.
    expect(
      head - deployBlock,
      `this scenario replays from ${LOWERED_BY} blocks below the book's deployBlock ` +
        `(floor ${deployBlock}) so the oversized window is genuinely oversized (R8); the head is ` +
        `${head}, which does not clear it. Check that the fork stack is up and published.`,
    ).toBeGreaterThan(BigInt(MISCONFIGURED_CAP));

    wide = await startNode(
      loweredFloor({ schema: OVERSIZED_SCHEMA, getLogsCap: MISCONFIGURED_CAP }),
      { coldStart: false },
    );
    await wipeProjection(wide.db);
    await wide.indexer.start();
    await waitForReady(wide);

    const getLogs = wide.rpc.filter((call) => call.method === "eth_getLogs");

    // The refusal actually happened — this is the assertion R8 says a scenario
    // usually cannot make honestly.
    const refused = getLogs.filter((call) => isLimitExceeded(call.error));
    expect(refused.length).toBeGreaterThan(0);

    // The first request really was oversized: `MISCONFIGURED_CAP` blocks,
    // measured from the request itself rather than assumed from the config.
    const [firstFilter] = getLogs[0].params as [{ fromBlock: string; toBlock: string }];
    expect(BigInt(firstFilter.toBlock) - BigInt(firstFilter.fromBlock) + 1n).toBe(
      BigInt(MISCONFIGURED_CAP),
    );
    expect(isLimitExceeded(getLogs[0].error)).toBe(true);

    // And it narrowed until it fit. The **discovered** window is what the rest of
    // the replay uses — it saturates downward and is kept, which is why a
    // mis-configured node pays for the discovery once rather than on every
    // window.
    const accepted = getLogs.filter((call) => call.error === undefined);
    expect(accepted.length).toBeGreaterThan(0);
    for (const call of accepted) {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }];
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      expect(span).toBeLessThanOrEqual(BigInt(PROXY_RANGE_CAP));
    }
    // Halving from 50 000 lands on 3125, and never on a value the proxy allows
    // that is larger — the point is that it stopped at the first size that
    // worked rather than dropping to one block.
    const widestAccepted = accepted.reduce((widest, call) => {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }];
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      return span > widest ? span : widest;
    }, 0n);
    expect(widestAccepted).toBeGreaterThan(1n);

    // The whole point: the projection is the same one the correctly configured
    // node built. A cap that provokes refusals costs round trips and changes
    // nothing about the answer.
    for (const [table, order] of DERIVED) {
      expect(await snapshotTable(wide.db, table, order), table).toEqual(
        await snapshotTable(correct!.db, table, order),
      );
    }
  }, 900_000);
});
