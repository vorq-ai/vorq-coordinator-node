import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import {
  CHAIN_PARAMS_TTL_MS,
  chainParams,
  headBlockOf,
  makeChain,
} from "../src/chain/client.js";
import { fetchLogsChunked } from "../src/chain/logs.js";
import type { Addresses, Config } from "../src/config.js";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";

/**
 * These are unit tests: no chain, no network. Every client below is built on a
 * viem `custom()` transport backed by a canned handler, so the code under test
 * runs through viem's real encode/decode/format path while the "endpoint" is a
 * function in this file.
 *
 * Two properties of the endpoint we write against are modelled exactly, because
 * getting either one wrong is a silent off-by-one in production:
 *   - the `eth_getLogs` cap is measured as `toBlock - fromBlock + 1 > cap`
 *     (bounds inclusive), so a legal window of `cap` blocks ends at
 *     `fromBlock + cap - 1`;
 *   - it is refused with JSON-RPC code -32005, which viem maps to
 *     `LimitExceededRpcError`.
 */

const JOB_REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const PROVIDER_REGISTRY = "0x2222222222222222222222222222222222222222" as const;
const ASK_REGISTRY = "0x3333333333333333333333333333333333333333" as const;
const CONTRACTS: readonly Address[] = [JOB_REGISTRY, PROVIDER_REGISTRY, ASK_REGISTRY];

/** A valid secp256k1 scalar. Not a credential — no chain has ever used it. */
const DUMMY_KEY = `0x${"11".repeat(32)}` as const;

const ADDRESSES: Addresses = {
  chainId: 31337,
  deployBlock: 0,
  jobRegistry: JOB_REGISTRY,
  providerRegistry: PROVIDER_REGISTRY,
  askRegistry: ASK_REGISTRY,
  usdc: "0x4444444444444444444444444444444444444444",
  decimals: 6,
  tokenDomain: { name: "USDC", version: "2" },
};

function config(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    getLogsCap: 5000,
    dbUrl: "postgres://unused",
    relayerKey: DUMMY_KEY,
    blockTimeMs: 450,
    port: 8402,
    readyLagBlocks: 30,
    // No browser calls a node under test. Spec 02: an empty list registers no
    // CORS at all, which is the shipped default.
    corsOrigins: [],
    maxBlobBytes: MAX_BLOB_BYTES,
    fileRetentionSeconds: 2_592_000,
    pinS3: {
        endpoint: "http://127.0.0.1:1",
        key: "unused",
        secret: "unused",
        bucket: "unused",
        region: "us-east-1",
      },
    relayMaxDepth: 32,
    relayQueueTimeoutMs: 10_000,
    relayerLowBalanceGwei: 50_000_000,
    // Plan 3's escrow, off: the shipped default, and nothing here touches it.
    escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 },
    match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
    jobRateLimit: 0,
    addresses: ADDRESSES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The canned endpoint
// ---------------------------------------------------------------------------

interface GetLogsCall {
  from: bigint;
  to: bigint;
  /** Bounds inclusive — the same measure the real proxy applies. */
  span: bigint;
  failed: boolean;
}

interface StubOptions {
  /** Largest span served. Anything wider is refused with -32005. */
  maxSpan?: number;
  /** Highest block the chain holds a log for. */
  head?: number;
  latest?: bigint;
  /** Config values `eth_call` answers with. Mutable so a refresh can observe a change. */
  params?: { feeBps: number; gasFee: bigint; treasury: Address; slaAllowed: boolean };
  /** Replaces the -32005 refusal, to prove non-range errors are not swallowed. */
  failWith?: { code: number; message: string };
}

interface Stub {
  client: PublicClient;
  getLogsCalls: GetLogsCall[];
  ethCalls: string[];
  /** Every block tag asked for, in order. Proves what a fallback did or did not do. */
  blockTags: string[];
  options: Required<Pick<StubOptions, "params">> & StubOptions;
}

/**
 * Builds a public client over a canned handler.
 *
 * `retryCount: 0` is load-bearing, not tuning. viem's default `shouldRetry`
 * treats -32005 (`LimitExceededRpcError`) as retryable and would issue each
 * refused request four times, so the call counts these tests assert on would
 * measure viem's retry loop rather than the chunker's halving.
 */
function makeStub(options: StubOptions = {}): Stub {
  const {
    maxSpan = Number.MAX_SAFE_INTEGER,
    head = 1_000_000,
    latest = 1000n,
    failWith,
  } = options;
  const params = options.params ?? {
    feeBps: 250,
    gasFee: 1_500_000n,
    treasury: "0x6666666666666666666666666666666666666666" as Address,
    slaAllowed: true,
  };

  const getLogsCalls: GetLogsCall[] = [];
  const ethCalls: string[] = [];
  const blockTags: string[] = [];

  const handler = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async request({ method, params: rpcParams }: { method: string; params?: any }) {
      switch (method) {
        case "eth_blockNumber":
          return numberToHex(latest);

        case "eth_getBlockByNumber": {
          const tag = rpcParams[0];
          blockTags.push(String(tag));
          if (tag === "latest") {
            return { number: numberToHex(latest), hash: `0x${"cd".repeat(32)}` };
          }
          // A block by number, whose hash is a function of it: the reorg guard's
          // whole question is whether that pairing still holds.
          if (typeof tag === "string" && tag.startsWith("0x")) {
            return { number: tag, hash: keccak256(toHex(`block:${BigInt(tag)}`)) };
          }
          throw { code: -32602, message: `unexpected block tag ${String(tag)}` };
        }

        case "eth_call": {
          const { functionName } = decodeFunctionData({
            abi: jobRegistryAbi,
            data: rpcParams[0].data,
          });
          ethCalls.push(functionName);
          switch (functionName) {
            case "feeBps":
              return encodeFunctionResult({
                abi: jobRegistryAbi,
                functionName: "feeBps",
                result: params.feeBps,
              });
            case "gasFee":
              return encodeFunctionResult({
                abi: jobRegistryAbi,
                functionName: "gasFee",
                result: params.gasFee,
              });
            case "treasury":
              return encodeFunctionResult({
                abi: jobRegistryAbi,
                functionName: "treasury",
                result: params.treasury,
              });
            case "allowedSla":
              return encodeFunctionResult({
                abi: jobRegistryAbi,
                functionName: "allowedSla",
                result: params.slaAllowed,
              });
            default:
              throw { code: -32601, message: `unexpected call ${functionName}` };
          }
        }

        case "eth_getLogs": {
          const filter = rpcParams[0];
          const from = BigInt(filter.fromBlock);
          const to = BigInt(filter.toBlock);
          const span = to - from + 1n;

          if (span > BigInt(maxSpan)) {
            getLogsCalls.push({ from, to, span, failed: true });
            throw failWith ?? { code: -32005, message: `block range exceeded: cap ${maxSpan}` };
          }
          getLogsCalls.push({ from, to, span, failed: false });

          const wanted = new Set<string>(
            (Array.isArray(filter.address) ? filter.address : [filter.address]).map((a: string) =>
              a.toLowerCase(),
            ),
          );

          // Returned grouped by contract, which is deliberately NOT
          // (blockNumber, logIndex) order. Three VORQ contracts interleave by
          // logIndex inside a block (R31); a merge that trusts the endpoint's
          // ordering produces a stream the reducer cannot replay. Emitting the
          // groups in address order is what makes the sort load-bearing.
          const out = [];
          for (const [slot, address] of CONTRACTS.entries()) {
            if (!wanted.has(address.toLowerCase())) continue;
            for (let b = Number(from); b <= Math.min(Number(to), head); b++) {
              out.push({
                address,
                topics: [`0x${"11".repeat(32)}`],
                data: "0x",
                // logIndex within a block: slot 0 -> 0, slot 1 -> 1, slot 2 -> 2
                blockNumber: numberToHex(BigInt(b)),
                blockHash: `0x${b.toString(16).padStart(64, "0")}`,
                logIndex: numberToHex(BigInt(slot)),
                transactionHash: `0x${b.toString(16).padStart(64, "0")}`,
                transactionIndex: "0x0",
                removed: false,
              });
            }
          }
          return out;
        }

        default:
          throw { code: -32601, message: `unexpected method ${method}` };
      }
    },
  };

  const client = createPublicClient({
    transport: custom(handler, { retryCount: 0 }),
  }) as PublicClient;

  return { client, getLogsCalls, ethCalls, blockTags, options: { ...options, params } };
}

/** Every block in `[from, to]` carries one log per contract, so this is the count. */
const expectedLogCount = (from: number, to: number) => (to - from + 1) * CONTRACTS.length;

// ---------------------------------------------------------------------------

describe("fetchLogsChunked", () => {
  it("splits a range wider than the cap into cap-sized windows and merges them", async () => {
    const stub = makeStub();

    const logs = await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 0n,
      toBlock: 11_999n,
      cap: 5000,
    });

    expect(stub.getLogsCalls.map((c) => [c.from, c.to])).toEqual([
      [0n, 4999n],
      [5000n, 9999n],
      [10_000n, 11_999n],
    ]);
    expect(logs).toHaveLength(expectedLogCount(0, 11_999));
  });

  it("treats the cap as an inclusive bound: a range of exactly cap blocks is one call", async () => {
    // The endpoint refuses when `to - from + 1 > cap`. A window built as
    // `from + cap` instead of `from + cap - 1` is one block too wide and is
    // refused on every single chunk — the failure this pins down.
    const stub = makeStub({ maxSpan: 5000 });

    await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 0n,
      toBlock: 4999n,
      cap: 5000,
    });

    expect(stub.getLogsCalls).toHaveLength(1);
    expect(stub.getLogsCalls[0]).toMatchObject({ from: 0n, to: 4999n, span: 5000n, failed: false });
  });

  it("never requests a span wider than the cap", async () => {
    const stub = makeStub({ maxSpan: 5000 });

    await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 7n,
      toBlock: 20_006n,
      cap: 5000,
    });

    expect(stub.getLogsCalls.every((c) => c.span <= 5000n)).toBe(true);
    expect(stub.getLogsCalls.some((c) => c.failed)).toBe(false);
  });

  it("halves the window on -32005 and keeps the size that worked", async () => {
    // The endpoint's real cap (1000) is below the configured one (5000), which
    // is exactly the case adaptive halving exists for.
    const stub = makeStub({ maxSpan: 1000 });

    const logs = await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 0n,
      toBlock: 11_999n,
      cap: 5000,
    });

    const failed = stub.getLogsCalls.filter((c) => c.failed);
    const ok = stub.getLogsCalls.filter((c) => !c.failed);

    // 5000 -> 2500 -> 1250 all refused; 625 is the first span served.
    expect(failed.map((c) => c.span)).toEqual([5000n, 2500n, 1250n]);
    expect(ok[0]?.span).toBe(625n);

    // The discovered size persists: having learned the endpoint's limit once,
    // the chunker must not re-provoke -32005 on every subsequent window.
    expect(stub.getLogsCalls.filter((c) => c.failed)).toHaveLength(3);
    expect(ok.every((c) => c.span <= 625n)).toBe(true);

    // Halving must not drop or duplicate a block.
    expect(logs).toHaveLength(expectedLogCount(0, 11_999));
  });

  it("throws when a single-block window still fails", async () => {
    // Nothing is servable, so halving bottoms out. Returning the partial result
    // here would silently truncate the index; the only correct answer is to fail.
    const stub = makeStub({ maxSpan: 0 });

    await expect(
      fetchLogsChunked(stub.client, {
        address: CONTRACTS,
        fromBlock: 100n,
        toBlock: 200n,
        cap: 5000,
      }),
    ).rejects.toThrow(/single block/i);

    expect(stub.getLogsCalls.at(-1)?.span).toBe(1n);
  });

  it("propagates a non-range error instead of halving", async () => {
    const stub = makeStub({
      maxSpan: 0,
      failWith: { code: -32603, message: "internal error" },
    });

    await expect(
      fetchLogsChunked(stub.client, {
        address: CONTRACTS,
        fromBlock: 0n,
        toBlock: 9999n,
        cap: 5000,
      }),
    ).rejects.toThrow(/internal error/i);

    // One attempt, no halving: an upstream fault is not a range problem.
    expect(stub.getLogsCalls).toHaveLength(1);
  });

  it("returns logs ordered by (blockNumber, logIndex) across chunk boundaries", async () => {
    const stub = makeStub();

    const logs = await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 0n,
      toBlock: 20n,
      cap: 7,
    });

    expect(stub.getLogsCalls.length).toBeGreaterThan(1);

    // Logs from a concrete (non-pending) range always carry both, so an absent
    // one would mean the merge invented an entry rather than a null slipping by.
    expect(logs.every((l) => l.blockNumber !== null && l.logIndex !== null)).toBe(true);

    const keys = logs.map((l) => [l.blockNumber ?? -1n, l.logIndex ?? -1] as const);
    for (let i = 1; i < keys.length; i++) {
      const [pb, pi] = keys[i - 1]!;
      const [cb, ci] = keys[i]!;
      expect(cb > pb || (cb === pb && ci > pi)).toBe(true);
    }

    // And the interleaving is real: block 0 carries all three contracts.
    expect(logs.slice(0, 3).map((l) => l.address.toLowerCase())).toEqual(
      CONTRACTS.map((a) => a.toLowerCase()),
    );
  });

  it("returns nothing, and calls nothing, for an empty range", async () => {
    const stub = makeStub();

    const logs = await fetchLogsChunked(stub.client, {
      address: CONTRACTS,
      fromBlock: 10n,
      toBlock: 9n,
      cap: 5000,
    });

    expect(logs).toEqual([]);
    expect(stub.getLogsCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("headBlock", () => {
  it("returns the chain's own latest, resolved on the call", async () => {
    const stub = makeStub({ latest: 1000n });

    await expect(headBlockOf(stub.client)).resolves.toBe(1000n);
  });

  it("re-resolves on every call, so a moving head is never served from a cache", async () => {
    // The regression this guards is viem's own: `getBlockNumber` caches for
    // `cacheTime`, which **defaults to the polling interval** — a client built
    // without an explicit `cacheTime` answers a head up to four seconds old, and
    // readiness would then measure the cache. `headBlockOf` passes `0` itself,
    // so this client is deliberately left on the default.
    let latest = 100n;
    const client = createPublicClient({
      transport: custom(
        {
          async request({ method }: { method: string; params?: any }) {
            if (method === "eth_blockNumber") return numberToHex(latest);
            throw { code: -32601, message: method };
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;

    await expect(headBlockOf(client)).resolves.toBe(100n);
    latest = 164n;
    await expect(headBlockOf(client)).resolves.toBe(164n);
  });

  it("is exposed on the Chain built by makeChain, with the hash of one block", async () => {
    const stub = makeStub({ latest: 936n });
    const chain = makeChain(config(), custom(stub.client, { retryCount: 0 }));

    await expect(chain.headBlock()).resolves.toBe(936n);
    // The guard's read: a number in, that block's hash out.
    await expect(chain.blockHash(936n)).resolves.toBe(keccak256(toHex("block:936")));
    expect(chain.account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(chain.chain.id).toBe(ADDRESSES.chainId);
    // chainParams accepts the Chain as well as a bare client.
    await expect(chainParams(chain, ADDRESSES).feeBps()).resolves.toBe(250);
  });

  it("rejects a malformed relayer key without echoing it", () => {
    expect(() => makeChain(config({ relayerKey: "not-a-key" }))).toThrow(
      /RELAYER_KEY must be a 0x-prefixed 32-byte hex private key/,
    );
    expect(() => makeChain(config({ relayerKey: "not-a-key" }))).not.toThrow(/not-a-key/);
  });
});

// ---------------------------------------------------------------------------

describe("chainParams", () => {
  beforeEach(() => {
    // Only `Date` is faked. The TTL is measured with `Date.now()`, while viem's
    // internals stay on real timers — faking those risks deadlocking a transport.
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches inside the TTL and refreshes after it", async () => {
    const stub = makeStub();
    const params = chainParams(stub.client, ADDRESSES);

    await expect(params.feeBps()).resolves.toBe(250);
    await expect(params.feeBps()).resolves.toBe(250);
    expect(stub.ethCalls.filter((c) => c === "feeBps")).toHaveLength(1);

    // A value that changed on chain must not be visible until the TTL lapses...
    stub.options.params.feeBps = 500;
    vi.advanceTimersByTime(CHAIN_PARAMS_TTL_MS - 1);
    await expect(params.feeBps()).resolves.toBe(250);
    expect(stub.ethCalls.filter((c) => c === "feeBps")).toHaveLength(1);

    // ...and must be visible once it has.
    vi.advanceTimersByTime(2);
    await expect(params.feeBps()).resolves.toBe(500);
    expect(stub.ethCalls.filter((c) => c === "feeBps")).toHaveLength(2);
  });

  it("uses a 60 s TTL", () => {
    expect(CHAIN_PARAMS_TTL_MS).toBe(60_000);
  });

  it("reads gasFee and treasury from the chain, each cached independently", async () => {
    const stub = makeStub();
    const params = chainParams(stub.client, ADDRESSES);

    await expect(params.gasFee()).resolves.toBe(1_500_000n);
    await expect(params.treasury()).resolves.toBe(
      "0x6666666666666666666666666666666666666666",
    );
    await expect(params.gasFee()).resolves.toBe(1_500_000n);

    expect(stub.ethCalls.filter((c) => c === "gasFee")).toHaveLength(1);
    expect(stub.ethCalls.filter((c) => c === "treasury")).toHaveLength(1);
  });

  it("caches slaAllowed per secs", async () => {
    const stub = makeStub();
    const params = chainParams(stub.client, ADDRESSES);

    await params.slaAllowed(60);
    await params.slaAllowed(60);
    expect(stub.ethCalls.filter((c) => c === "allowedSla")).toHaveLength(1);

    await params.slaAllowed(300);
    await params.slaAllowed(300);
    expect(stub.ethCalls.filter((c) => c === "allowedSla")).toHaveLength(2);
  });

  it("does not stampede: concurrent misses share one upstream call", async () => {
    const stub = makeStub();
    const params = chainParams(stub.client, ADDRESSES);

    const [a, b, c] = await Promise.all([params.gasFee(), params.gasFee(), params.gasFee()]);

    expect([a, b, c]).toEqual([1_500_000n, 1_500_000n, 1_500_000n]);
    expect(stub.ethCalls.filter((x) => x === "gasFee")).toHaveLength(1);
  });

  it("bust() forces the next read to hit the chain", async () => {
    const stub = makeStub();
    const params = chainParams(stub.client, ADDRESSES);

    await params.gasFee();
    await params.slaAllowed(60);
    stub.options.params.gasFee = 9n;
    stub.options.params.slaAllowed = false;

    params.bust();

    // The relay-time re-check must see the current chain state, TTL or not.
    await expect(params.gasFee()).resolves.toBe(9n);
    await expect(params.slaAllowed(60)).resolves.toBe(false);
    expect(stub.ethCalls.filter((x) => x === "gasFee")).toHaveLength(2);
    expect(stub.ethCalls.filter((x) => x === "allowedSla")).toHaveLength(2);
  });

  it("does not cache a value a bust invalidated mid-flight", async () => {
    let gasFee = 1n;
    let open: () => void = () => {};
    let gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const client = createPublicClient({
      transport: custom(
        {
          async request({ method }: { method: string }) {
            if (method !== "eth_call") throw { code: -32601, message: method };
            // Sampled when the call is made, not when the gate opens: this
            // models a read that observed the chain before the bust and is
            // merely slow to come back.
            const observed = gasFee;
            await gate;
            return encodeFunctionResult({
              abi: jobRegistryAbi,
              functionName: "gasFee",
              result: observed,
            });
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;

    const params = chainParams(client, ADDRESSES);

    const first = params.gasFee(); // in flight
    params.bust(); // ...and invalidated before it lands
    gasFee = 2n;
    open();

    // The caller that started the read still gets what the chain told it.
    await expect(first).resolves.toBe(1n);

    // But the busted value must not have been cached: the next read goes back
    // to the chain. Caching it would make bust() a no-op under concurrency.
    gate = Promise.resolve();
    await expect(params.gasFee()).resolves.toBe(2n);
  });

  it("retries after a failed read rather than latching the failure", async () => {
    let fail = true;
    const client = createPublicClient({
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: any }) {
            if (method !== "eth_call") throw { code: -32601, message: method };
            if (fail) throw { code: -32603, message: "boom" };
            return encodeFunctionResult({
              abi: jobRegistryAbi,
              functionName: "gasFee",
              result: 7n,
            });
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;

    const params = chainParams(client, ADDRESSES);
    await expect(params.gasFee()).rejects.toThrow();
    fail = false;
    await expect(params.gasFee()).resolves.toBe(7n);
  });
});
