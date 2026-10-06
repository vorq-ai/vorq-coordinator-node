import {
  bytesToHex,
  custom,
  hexToBytes,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  numberToHex,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../src/abi/providerRegistry.js";
import { makeChain, type Chain } from "../src/chain/client.js";
import type { Addresses, Config } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import { catchUpWindows, cursorBlock, startIndexer, type Indexer } from "../src/index/indexer.js";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";

/**
 * Indexer tests. No chain and no network: the "endpoint" is a canned handler in
 * this file, driven through viem's real transport, so `fetchLogsChunked`,
 * `head()`, `header()`, `blockHash()` and the whole decode path run for real.
 *
 * The database half is gated on `TEST_DATABASE_URL` and stays in the **unit** suite
 * (R25) — the no-network rule is about chain access, not a local Postgres:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_indexer_test";

const JOB_REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const PROVIDER_REGISTRY = "0x2222222222222222222222222222222222222222" as const;
const ASK_REGISTRY = "0x3333333333333333333333333333333333333333" as const;

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OPERATOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

/** A valid secp256k1 scalar. Not a credential — no chain has ever used it. */
const DUMMY_KEY = `0x${"11".repeat(32)}` as const;

const word = (fill: string): Hex => `0x${fill.repeat(32)}`;

const JOB_A = word("01");
const JOB_B = word("02");
const C_A = word("c1");

const EXPIRES = 4_102_444_800n;

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

/** Every table the reducer writes. `pins` and `quotes_live` are not derived (R44). */
const DERIVED = ["allowlist", "asks_chain", "cursor", "jobs", "models", "providers"] as const;

function config(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    getLogsCap: 5000,
    dbUrl: TEST_DATABASE_URL ?? "postgres://unused",
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
// Log synthesis
// ---------------------------------------------------------------------------

interface Encoded {
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
}

/**
 * Encodes an event exactly as the EVM would: indexed members into topics, the
 * rest into the data word, both driven off the vendored ABI — so the topics
 * these tests emit are the ones the contracts really emit.
 */
function encodeLog(abi: Abi, eventName: string, args: Record<string, unknown>): Encoded {
  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  );
  if (event === undefined) throw new Error(`the ABI declares no event named ${eventName}`);

  const topics = encodeEventTopics({ abi, eventName, args }) as [Hex, ...Hex[]];
  const body = event.inputs.filter((input) => !input.indexed);
  return {
    topics,
    data: encodeAbiParameters(
      body,
      body.map((input) => args[input.name as string]),
    ),
  };
}

/** One log the canned chain holds, at a definite position. */
interface Canned {
  address: Address;
  block: bigint;
  index: number;
  encoded: Encoded;
}

const at = (address: Address, block: bigint, encoded: Encoded, index = 0): Canned => ({
  address,
  block,
  index,
  encoded,
});

const posted = (block: bigint, jobId: Hex = JOB_A): Canned =>
  at(
    JOB_REGISTRY,
    block,
    encodeLog(jobRegistryAbi, "Posted", {
      jobId,
      modelId: 7,
      designated: 0,
      owner: OWNER,
      c: C_A,
      expiresAt: EXPIRES,
      slaSecs: 3600,
      rateIn: 1_000_000n,
      rateOut: 2_000_000n,
      unitsIn: 1000,
      unitsOut: 2000,
      gasFee: 30_000n,
      taskCid: word("7a"),
    }),
  );

const claimed = (block: bigint, jobId: Hex = JOB_A, provider = 3): Canned =>
  at(
    JOB_REGISTRY,
    block,
    encodeLog(jobRegistryAbi, "Claimed", { jobId, provider, claimedAt: 1_700_000_000n }),
  );

/**
 * `providerId` is required rather than defaulted: it is an indexed member, and
 * viem encodes an `undefined` indexed arg as a wildcard — the topic is simply
 * left out, producing a log the decoder then refuses.
 */
const providerRegistered = (block: bigint, providerId: number): Canned =>
  at(
    PROVIDER_REGISTRY,
    block,
    encodeLog(providerRegistryAbi, "ProviderRegistered", { providerId, operator: OPERATOR }),
  );

// ---------------------------------------------------------------------------
// The canned chain
// ---------------------------------------------------------------------------

/**
 * One window the endpoint was asked for. The width is deliberately not recorded:
 * asserting on it proves nothing about the indexer, because `fetchLogsChunked`
 * splits whatever span it is handed into the same cap-sized requests either way.
 */
interface GetLogsCall {
  from: bigint;
  /** Inclusive. */
  to: bigint;
  addresses: string[];
  /** Asked by `blockHash` (EIP-234) rather than by range. */
  byHash: boolean;
}

interface StubOptions {
  logs?: Canned[];
  /** What `latest` resolves to — the head this node indexes at. */
  latest?: bigint;
  /** Widest span the endpoint serves. Anything wider is refused with -32005. */
  maxSpan?: number;
  /**
   * Called before each `eth_getLogs` is answered. The seam that makes what the
   * indexer has already committed observable *between* windows, which is the
   * only thing that distinguishes reducing per window from accumulating.
   */
  onGetLogs?: (from: bigint, to: bigint) => Promise<void> | void;
  /**
   * Called **after** a block's hash has been served, with its number.
   *
   * The seam for the ordering inside the window loop: the guard reads two block
   * hashes per window, and what separates a correct order from a plausible one
   * is what a reorg landing *between* those two reads does. Nothing else can
   * express that instant.
   */
  onBlockHash?: (block: bigint) => void;
  /**
   * Blocks this endpoint cannot produce — it answers `null`, which viem raises
   * as `BlockNotFoundError`.
   *
   * Listed rather than derived from `latest`, because the two cases the guard
   * has to tell apart differ only in where the head is: an endpoint that is
   * behind the cursor and one that claims a chain past the cursor and still
   * cannot serve a block of it.
   */
  missingBlocks?: bigint[];
}

interface Stub {
  chain: Chain;
  getLogsCalls: GetLogsCall[];
  /** Every block tag asked for, in order. */
  blockTags: string[];
  /** How many times the head was resolved (`eth_blockNumber` or the `latest` header). */
  headReads: number;
  logs: Canned[];
  setLatest(block: bigint): void;
  /**
   * Re-hashes every block from `from` up, leaving their numbers alone — a reorg
   * under whatever indexed them, which is the only thing the guard can see.
   */
  reorgFrom(from: bigint): void;
  /**
   * Makes `eth_getLogs` fail, for every window or only for the ones `when`
   * selects. `null` clears it.
   */
  failGetLogs(
    error: { code: number; message: string } | null,
    when?: (from: bigint, to: bigint) => boolean,
  ): void;
}

function makeStub(options: StubOptions = {}): Stub {
  const logs = [...(options.logs ?? [])];
  const maxSpan = BigInt(options.maxSpan ?? Number.MAX_SAFE_INTEGER);
  let latest = options.latest ?? 0n;
  let failure: { code: number; message: string } | null = null;
  let failWhen: (from: bigint, to: bigint) => boolean = () => true;

  // Where each reorg started. A block's hash is a function of its number and of
  // how many reorgs have reached it, so a reorg changes the hash of everything
  // from its point on and nothing below it.
  const reorgs: bigint[] = [];
  const byHash = new Map<string, bigint>();
  const hashAt = (block: bigint): Hex => {
    const hash = keccak256(toHex(`${reorgs.filter((from) => block >= from).length}:${block}`));
    byHash.set(hash, block);
    return hash;
  };
  // Address bits only: the indexer filters by contract, never by topic.
  const bloomAt = (block: bigint): Hex => {
    const bloom = new Uint8Array(256);
    for (const log of logs.filter((l) => l.block === block)) {
      const hash = hexToBytes(keccak256(log.address));
      for (const i of [0, 2, 4]) {
        const bit = ((hash[i]! << 8) | hash[i + 1]!) & 2047;
        bloom[255 - (bit >> 3)]! |= 1 << (bit & 7);
      }
    }
    return bytesToHex(bloom);
  };
  const headerAt = (block: bigint) => ({
    number: numberToHex(block),
    hash: hashAt(block),
    parentHash: block === 0n ? word("00") : hashAt(block - 1n),
    logsBloom: bloomAt(block),
  });

  const getLogsCalls: GetLogsCall[] = [];
  const blockTags: string[] = [];

  const stub = { getLogsCalls, blockTags, headReads: 0, logs } as Stub;

  const handler = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async request({ method, params }: { method: string; params?: any }) {
      switch (method) {
        case "eth_blockNumber":
          stub.headReads += 1;
          return numberToHex(latest);

        case "eth_getBlockByNumber": {
          const tag = String(params[0]);
          blockTags.push(tag);
          // `latest` and a plain block number, and nothing else. A reader that
          // still asks for `finalized` fails here rather than being served.
          if (tag === "latest") {
            stub.headReads += 1;
            return headerAt(latest);
          }
          if (tag.startsWith("0x")) {
            const block = BigInt(tag);
            if (options.missingBlocks?.includes(block) === true) return null;
            const answer = headerAt(block);
            options.onBlockHash?.(block);
            return answer;
          }
          throw { code: -32602, message: `unexpected block tag ${tag}` };
        }

        case "eth_getLogs": {
          const filter = params[0];
          const pinned = filter.blockHash === undefined ? undefined : byHash.get(filter.blockHash);
          if (filter.blockHash !== undefined && pinned === undefined) {
            throw { code: -32000, message: `unknown block hash ${filter.blockHash}` };
          }
          const from = pinned ?? BigInt(filter.fromBlock);
          const to = pinned ?? BigInt(filter.toBlock);
          const addresses: string[] = (
            Array.isArray(filter.address) ? filter.address : [filter.address]
          ).map((a: string) => a.toLowerCase());
          getLogsCalls.push({ from, to, addresses, byHash: pinned !== undefined });
          await options.onGetLogs?.(from, to);

          if (failure !== null && failWhen(from, to)) throw failure;
          if (to - from + 1n > maxSpan) {
            throw { code: -32005, message: `block range exceeded: cap ${maxSpan}` };
          }

          const wanted = new Set(addresses);
          return (
            logs
              .filter(
                (log) =>
                  log.block >= from && log.block <= to && wanted.has(log.address.toLowerCase()),
              )
              // Returned newest-first, which is deliberately NOT the order the
              // reducer replays in. The pipeline owes the reducer
              // (blockNumber, logIndex) order (R31); handing it back sorted here
              // would make a pipeline that had stopped sorting still pass.
              .sort((a, b) => (a.block === b.block ? b.index - a.index : Number(b.block - a.block)))
              .map((log) => ({
                address: log.address,
                topics: log.encoded.topics,
                data: log.encoded.data,
                blockNumber: numberToHex(log.block),
                blockHash: word("bb"),
                logIndex: numberToHex(BigInt(log.index)),
                transactionHash: word("cc"),
                transactionIndex: "0x0",
                removed: false,
              }))
          );
        }

        default:
          throw { code: -32601, message: `unexpected method ${method}` };
      }
    },
  };

  // `retryCount: 0` so an injected failure is one upstream call, not viem's
  // retry loop — otherwise the call counts here measure viem rather than the
  // indexer (R42).
  const chain = makeChain(config(), custom(handler, { retryCount: 0 }));

  stub.chain = chain;
  stub.setLatest = (block) => {
    latest = block;
  };
  stub.reorgFrom = (from) => {
    reorgs.push(from);
  };
  stub.failGetLogs = (error, when) => {
    failure = error;
    failWhen = when ?? (() => true);
  };
  return stub;
}

const windows = (calls: readonly GetLogsCall[]): [bigint, bigint][] =>
  calls.map((call) => [call.from, call.to]);

// ---------------------------------------------------------------------------
// catchUpWindows — no chain, no database
// ---------------------------------------------------------------------------

describe("catchUpWindows", () => {
  const listed = (from: bigint, to: bigint, span: bigint) =>
    [...catchUpWindows(from, to, span)].map((w) => [w.from, w.to]);

  it("tiles the range in spans of at most `span`, the last one clamped", () => {
    expect(listed(0n, 9n, 4n)).toEqual([
      [0n, 3n],
      [4n, 7n],
      [8n, 9n],
    ]);
  });

  it("emits one window when the span covers the whole range", () => {
    expect(listed(10n, 20n, 5000n)).toEqual([[10n, 20n]]);
  });

  it("treats the span as an inclusive width: a range of exactly `span` is one window", () => {
    // The off-by-one that matters: a window built as `from + span` is one block
    // too wide and the endpoint refuses every single one of them.
    expect(listed(0n, 4999n, 5000n)).toEqual([[0n, 4999n]]);
  });

  it("emits a single-block window for a single-block range", () => {
    expect(listed(7n, 7n, 5000n)).toEqual([[7n, 7n]]);
  });

  it("emits nothing when there is nothing to close", () => {
    expect(listed(11n, 10n, 5000n)).toEqual([]);
  });

  it("covers the range exactly, with no gap and no overlap", () => {
    for (const [from, to, span] of [
      [0n, 100n, 7n],
      [3n, 3n, 1n],
      [1000n, 1_000_000n, 5000n],
      [5n, 6n, 1n],
    ] as const) {
      const tiled = listed(from, to, span);
      expect(tiled[0]?.[0]).toBe(from);
      expect(tiled.at(-1)?.[1]).toBe(to);
      for (const [start, end] of tiled) {
        expect(end).toBeGreaterThanOrEqual(start);
        expect(end - start + 1n).toBeLessThanOrEqual(span);
      }
      for (let i = 1; i < tiled.length; i++) {
        expect(tiled[i]![0]).toBe(tiled[i - 1]![1] + 1n);
      }
    }
  });

  it("refuses a span that would never advance", () => {
    expect(() => listed(0n, 10n, 0n)).toThrow(/span/i);
  });
});

// ---------------------------------------------------------------------------
// The indexer — against a real Postgres
// ---------------------------------------------------------------------------

function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("startIndexer", () => {
  let db: Db;
  /** Every indexer a test started, stopped in afterEach so no loop outlives it. */
  let running: Indexer[] = [];

  const start = (stub: Stub, overrides: Partial<Config> = {}): Indexer => {
    const indexer = startIndexer(stub.chain, db, config(overrides));
    running.push(indexer);
    return indexer;
  };

  beforeAll(async () => {
    db = openDb(scopedToTestSchema(TEST_DATABASE_URL as string));
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE ${DERIVED.join(", ")}`);
  });

  afterEach(async () => {
    for (const indexer of running) await indexer.stop();
    running = [];
    vi.restoreAllMocks();
  });

  const state = async (jobId: Hex = JOB_A): Promise<number | undefined> => {
    const { rows } = await db.query<{ state: number }>(
      "SELECT state FROM jobs WHERE job_id = decode($1, 'hex')",
      [jobId.slice(2)],
    );
    return rows[0]?.state;
  };

  describe("cold start", () => {
    it("replays from the deploy block and lands the cursor on the head", async () => {
      const stub = makeStub({ logs: [posted(5n), claimed(7n)], latest: 10n });

      await start(stub).coldStart();

      expect(windows(stub.getLogsCalls)).toEqual([[0n, 10n]]);
      expect(await cursorBlock(db)).toBe(10n);
      expect(await state()).toBe(1);
    });

    it("reads only the three VORQ contracts, all topics", async () => {
      const stub = makeStub({ logs: [providerRegistered(2n, 1)], latest: 4n });

      await start(stub).coldStart();

      expect(stub.getLogsCalls[0]?.addresses).toEqual(
        [JOB_REGISTRY, PROVIDER_REGISTRY, ASK_REGISTRY].map((a) => a.toLowerCase()),
      );
      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM providers");
      // `count(*)` is a BIGINT, so it reads back as a bigint (R45).
      expect(rows[0]?.count).toBe(1n);
    });

    it("never reads below the deploy block", async () => {
      const stub = makeStub({ logs: [posted(105n)], latest: 120n });

      await start(stub, { addresses: { ...ADDRESSES, deployBlock: 100 } }).coldStart();

      expect(stub.getLogsCalls.every((call) => call.from >= 100n)).toBe(true);
      expect(await cursorBlock(db)).toBe(120n);
      expect(await state()).toBe(0);
    });

    it("closes an empty range: no logs still advances the cursor", async () => {
      const stub = makeStub({ logs: [], latest: 42n });

      await start(stub).coldStart();

      // `reduceRange` writes the cursor for an empty range too, and the range is
      // only skipped when there is genuinely nothing to close. Short-circuiting
      // on `logs.length === 0` would leave a chain with no VORQ activity looking
      // permanently un-indexed, and therefore never ready.
      expect(await cursorBlock(db)).toBe(42n);
    });

    it("does nothing at all when the head has not moved past the cursor", async () => {
      const stub = makeStub({ logs: [posted(1n)], latest: 3n });
      const indexer = start(stub);

      await indexer.coldStart();
      const after = stub.getLogsCalls.length;
      await indexer.poll();

      expect(stub.getLogsCalls).toHaveLength(after);
      expect(await cursorBlock(db)).toBe(3n);
    });
  });

  describe("window bounds", () => {
    it("reduces each window before reading the next, so only one is ever held", async () => {
      // The hazard this closes: `fetchLogsChunked` accumulates every log of the
      // span it is given before returning — its chunking exists to stay under
      // the endpoint's cap, not to stream — so a cold start handed
      // `deploy_block → head` in one piece holds the whole chain's logs at once.
      //
      // The requested ranges alone cannot show this, and asserting only those
      // was this test's first, useless form: given the whole span,
      // `fetchLogsChunked` chunks it into the very same cap-sized requests. What
      // separates the two is *when the cursor moves*. Sampling it as each window
      // is requested pins that down: 4999 and 9999 are only visible if the
      // window before was reduced and committed first.
      const observed: (bigint | null)[] = [];
      const observedHashes: (string | undefined)[] = [];
      const stub = makeStub({
        logs: [posted(3n), claimed(6000n), providerRegistered(11_000n, 4)],
        latest: 11_999n,
        maxSpan: 5000,
        onGetLogs: async () => {
          observed.push(await cursorBlock(db));
          const { rows } = await db.query<{ block_hash: string }>(
            "SELECT block_hash FROM cursor WHERE id = 1",
          );
          observedHashes.push(rows[0]?.block_hash);
        },
      });

      await start(stub).coldStart();

      expect(windows(stub.getLogsCalls)).toEqual([
        [0n, 4999n],
        [5000n, 9999n],
        [10_000n, 11_999n],
      ]);
      expect(observed).toEqual([null, 4999n, 9999n]);
      // ...and each intermediate cursor carries the hash of **its own window's**
      // last block, not the head's: a guard fed `blockHash(head)` would compare
      // the wrong block on every tick of a catch-up that takes more than one
      // window, and would pass through a reorg under the window it stopped at.
      expect(observedHashes).toEqual([
        undefined,
        await stub.chain.blockHash(4999n),
        await stub.chain.blockHash(9999n),
      ]);
      expect(await cursorBlock(db)).toBe(11_999n);
      // Posted in the first window, Claimed in the second: the windows commit
      // separately, so the row must survive across the boundary.
      expect(await state()).toBe(1);
    });

    it("commits each window, so a failure keeps what landed and resumes from there", async () => {
      const stub = makeStub({
        logs: [posted(3n), claimed(6000n)],
        latest: 11_999n,
        maxSpan: 5000,
      });
      const indexer = start(stub);

      // Fail the third window only. This is the observable proof that windows
      // are reduced one at a time rather than accumulated: had the indexer
      // gathered all three before reducing, nothing at all would have committed.
      stub.failGetLogs({ code: -32603, message: "internal error" }, (from) => from >= 10_000n);

      await expect(indexer.coldStart()).rejects.toThrow(/internal error/i);

      expect(await cursorBlock(db)).toBe(9999n);
      expect(await state()).toBe(1);

      // ...and the next run picks up exactly where the failure left it.
      stub.failGetLogs(null);
      await indexer.poll();
      expect(stub.getLogsCalls.at(-1)).toMatchObject({ from: 10_000n, to: 11_999n });
      expect(await cursorBlock(db)).toBe(11_999n);
    });
  });

  describe("steady state", () => {
    it("a failed poll leaves the cursor unmoved and the next poll re-closes the range", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 5n });
      const indexer = start(stub);
      await indexer.coldStart();
      expect(await cursorBlock(db)).toBe(5n);

      stub.logs.push(claimed(8n));
      stub.setLatest(9n);
      stub.failGetLogs({ code: -32603, message: "internal error" });

      await expect(indexer.poll()).rejects.toThrow(/internal error/i);
      expect(await cursorBlock(db)).toBe(5n);
      expect(await state()).toBe(0);

      stub.failGetLogs(null);
      await indexer.poll();

      expect(stub.getLogsCalls.at(-1)).toMatchObject({ from: 6n, to: 9n });
      expect(await cursorBlock(db)).toBe(9n);
      expect(await state()).toBe(1);
    });

    it("lets a reducer throw propagate rather than skipping the event", async () => {
      // A Claimed with no Posted in front of it. `reduceRange` throws on that
      // (R10), and swallowing it would turn a loud failure into a projection
      // that silently disagrees with the chain.
      const stub = makeStub({ logs: [claimed(4n, JOB_B)], latest: 6n });

      await expect(start(stub).coldStart()).rejects.toThrow(/no such row/i);
      expect(await cursorBlock(db)).toBeNull();
    });

    it("never rewinds the cursor when the head reports lower than what is applied", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 20n });
      const indexer = start(stub);
      await indexer.coldStart();

      // A failover to a lagging RPC. Reducing an empty `[cursor+1, head]` here
      // would write a cursor behind what is already applied, and the index would
      // claim less than it holds.
      stub.setLatest(5n);
      const before = stub.getLogsCalls.length;
      await indexer.poll();

      expect(stub.getLogsCalls).toHaveLength(before);
      expect(await cursorBlock(db)).toBe(20n);
    });

    it("coalesces concurrent polls into one run", async () => {
      // Two overlapping polls would reduce the same range twice, which is
      // exactly the out-of-order/orphan condition `reduceRange` throws on.
      const stub = makeStub({ logs: [posted(2n)], latest: 5n });
      const indexer = start(stub);

      await Promise.all([indexer.poll(), indexer.poll(), indexer.coldStart()]);

      expect(stub.getLogsCalls).toHaveLength(1);
      expect(stub.headReads).toBe(1);
      expect(await cursorBlock(db)).toBe(5n);
    });
  });

  describe("status", () => {
    it("rejects before the loop has read a head: it cannot see the chain", async () => {
      const stub = makeStub({ latest: 3n });

      await expect(start(stub).status()).rejects.toThrow(/no chain head/);
      expect(stub.headReads).toBe(0);
    });

    it("is not ready before anything is indexed, and reports no cursor", async () => {
      const stub = makeStub({ latest: 3n });
      const indexer = start(stub);
      stub.failGetLogs({ code: -32603, message: "internal error" });
      await expect(indexer.poll()).rejects.toThrow();

      await expect(indexer.status()).resolves.toEqual({
        cursor: null,
        head: 3n,
        ready: false,
        forked: null,
      });
    });

    it("is ready once the cursor is within READY_LAG_BLOCKS of the head", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 100n });
      const indexer = start(stub, { readyLagBlocks: 30 });
      await indexer.coldStart();

      await expect(indexer.status()).resolves.toEqual({
        cursor: 100n,
        head: 100n,
        ready: true,
        forked: null,
      });

      // A tick that reads the head and fails its logs leaves the cursor behind.
      stub.failGetLogs({ code: -32603, message: "internal error" });

      // Exactly the lag is still ready: the bound is inclusive.
      stub.setLatest(130n);
      await expect(indexer.poll()).rejects.toThrow();
      await expect(indexer.status()).resolves.toMatchObject({ ready: true, head: 130n });

      // One past it is not.
      stub.setLatest(131n);
      await expect(indexer.poll()).rejects.toThrow();
      await expect(indexer.status()).resolves.toMatchObject({ ready: false, cursor: 100n });

      // ...and catching up flips it back.
      stub.failGetLogs(null);
      await indexer.poll();
      await expect(indexer.status()).resolves.toEqual({
        cursor: 131n,
        head: 131n,
        ready: true,
        forked: null,
      });
    });

    it("is not ready when the head is behind the cursor", async () => {
      // A negative lag satisfies `head - cursor <= readyLagBlocks` on its own,
      // so without the `head >= cursor` half an endpoint that had fallen behind
      // — or a chain that got shorter — would read as the most caught-up a node
      // can be. `/readyz` still reports the signed lag; it is a diagnostic.
      const stub = makeStub({ logs: [posted(2n)], latest: 20n });
      const indexer = start(stub, { readyLagBlocks: 30 });
      await indexer.coldStart();
      await expect(indexer.status()).resolves.toMatchObject({ ready: true });

      stub.setLatest(5n);
      await indexer.poll();

      await expect(indexer.status()).resolves.toEqual({
        cursor: 20n,
        head: 5n,
        ready: false,
        forked: null,
      });
    });

    it("never asks the chain: the loop's last head is the answer", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = start(stub);
      await indexer.coldStart();
      const reads = stub.headReads;
      const tags = stub.blockTags.length;

      for (let i = 0; i < 5; i++) await indexer.status();

      expect(stub.headReads).toBe(reads);
      expect(stub.blockTags).toHaveLength(tags);
    });

    it("rejects once the last head is older than the lag's worth of blocks", async () => {
      // A wedged loop must not keep reporting the lag it had when it wedged.
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = start(stub, { readyLagBlocks: 5, blockTimeMs: 1000 });
      await indexer.coldStart();
      await expect(indexer.status()).resolves.toMatchObject({ ready: true });

      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 5_001);

      await expect(indexer.status()).rejects.toThrow(/no chain head/);
    });

    it("keeps reporting a fork after the loop has stopped reading heads", async () => {
      const stub = makeStub({ logs: [posted(5n)], latest: 120n });
      const indexer = start(stub, { readyLagBlocks: 5, blockTimeMs: 1000 });
      await indexer.poll();
      stub.reorgFrom(118n);
      stub.setLatest(125n);
      await expect(indexer.poll()).rejects.toThrow(/reorg/);

      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);

      await expect(indexer.status()).resolves.toMatchObject({ ready: false, forked: 120n });
    });
  });

  describe("the header path", () => {
    /** Cold-started at `latest`, with the call logs cleared behind it. */
    const warm = async (stub: Stub): Promise<Indexer> => {
      const indexer = start(stub);
      await indexer.coldStart();
      stub.getLogsCalls.length = 0;
      stub.blockTags.length = 0;
      return indexer;
    };

    it("closes an idle block with one header and no eth_getLogs", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = await warm(stub);

      stub.setLatest(11n);
      await indexer.poll();

      expect(stub.blockTags).toEqual(["latest"]);
      expect(stub.getLogsCalls).toEqual([]);
      const { rows } = await db.query<{ block_number: bigint; block_hash: string }>(
        "SELECT block_number, block_hash FROM cursor WHERE id = 1",
      );
      expect(rows[0]).toEqual({ block_number: 11n, block_hash: await stub.chain.blockHash(11n) });
    });

    it("reads logs by blockHash only for a block whose bloom names a VORQ contract", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = await warm(stub);

      stub.logs.push(claimed(12n));
      stub.setLatest(13n);
      await indexer.poll();

      expect(stub.blockTags).toEqual(["latest", "0xc", "0xb"]);
      expect(stub.getLogsCalls).toMatchObject([{ from: 12n, to: 12n, byHash: true }]);
      expect(await cursorBlock(db)).toBe(13n);
      expect(await state()).toBe(1);
    });

    it("applies several logs of one block in logIndex order", async () => {
      const stub = makeStub({ logs: [], latest: 10n });
      const indexer = await warm(stub);

      stub.logs.push(at(JOB_REGISTRY, 11n, posted(11n).encoded, 0), at(JOB_REGISTRY, 11n, claimed(11n).encoded, 1));
      stub.setLatest(11n);
      await indexer.poll();

      expect(await state()).toBe(1);
    });

    it("hands a gap wider than three blocks to the range path", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = await warm(stub);

      stub.setLatest(14n);
      await indexer.poll();

      expect(stub.getLogsCalls).toMatchObject([{ from: 11n, to: 14n, byHash: false }]);
      expect(await cursorBlock(db)).toBe(14n);
    });

    it("trips when the lowest header does not extend the cursor", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = await warm(stub);

      stub.reorgFrom(10n);
      stub.setLatest(12n);

      await expect(indexer.poll()).rejects.toThrow(/reorg under the cursor at block 10/);
      expect(await cursorBlock(db)).toBe(10n);
      await expect(indexer.status()).resolves.toMatchObject({ ready: false, forked: 10n });
    });

    it("retries, without tripping, a reorg that lands between two header reads", async () => {
      let stub: Stub;
      let fired = false;
      stub = makeStub({
        logs: [posted(2n)],
        latest: 10n,
        onBlockHash: (block) => {
          // Headers are read head-down: 12 is served, then 11 is replaced
          // before it is read, so 12 no longer names the 11 that comes back.
          if (block === 12n && !fired) {
            fired = true;
            stub.reorgFrom(11n);
          }
        },
      });
      const indexer = await warm(stub);

      stub.setLatest(13n);
      await expect(indexer.poll()).rejects.toThrow(/reorg in flight/);
      expect(await cursorBlock(db)).toBe(10n);
      await expect(indexer.status()).resolves.toMatchObject({ forked: null });

      await indexer.poll();
      expect(await cursorBlock(db)).toBe(13n);
    });

    it("trips when the head is level with the cursor but hashes differently", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 10n });
      const indexer = await warm(stub);

      stub.reorgFrom(10n);
      await expect(indexer.poll()).rejects.toThrow(/reorg under the cursor at block 10/);
      expect(stub.blockTags).toEqual(["latest"]);
    });
  });

  describe("the reorg guard", () => {
    it("stores the hash of the block the cursor rests on", async () => {
      const stub = makeStub({ logs: [posted(5n)], latest: 120n });

      await start(stub).poll();

      const { rows } = await db.query<{ block_number: bigint; block_hash: string }>(
        "SELECT block_number, block_hash FROM cursor WHERE id = 1",
      );
      expect(rows[0]).toEqual({
        block_number: 120n,
        block_hash: await stub.chain.blockHash(120n),
      });
    });

    it("stops and drops readiness when the block under the cursor changed", async () => {
      const stub = makeStub({ logs: [posted(5n)], latest: 120n });
      const indexer = start(stub);
      await indexer.poll();

      // Blocks 118.. now hash differently: everything the cursor rests on may
      // describe a chain that is gone, and there is no unwind.
      stub.reorgFrom(118n);
      stub.setLatest(125n);

      await expect(indexer.poll()).rejects.toThrow(/reorg under the cursor at block 120/);
      await expect(indexer.status()).resolves.toMatchObject({
        cursor: 120n,
        ready: false,
        forked: 120n,
      });
      // ...and it stays stopped: nothing past the fork is ever applied.
      await expect(indexer.poll()).rejects.toThrow(/reorg/);
      expect(await cursorBlock(db)).toBe(120n);
    });

    it("trips on a chain replaced while the window was being read", async () => {
      // The interleaving the order inside `catchUp` exists for. The window's
      // hash is read **before** its logs, so a reorg landing while the logs are
      // in flight commits them under the hash the head had when the window
      // began — and the next tick compares that hash and trips. Read the hash
      // after the logs instead and the cursor carries the *replacement* chain's
      // hash over the *old* chain's rows: a self-consistent pair, matching
      // forever, and a permanently wrong projection reported ready.
      let stub: Stub;
      stub = makeStub({
        logs: [posted(5n)],
        latest: 100n,
        onGetLogs: (from) => {
          if (from === 101n) stub.reorgFrom(105n);
        },
      });
      const indexer = start(stub);

      await indexer.poll();
      expect(await cursorBlock(db)).toBe(100n);

      // Window 101..110. The reorg lands between its hash and its logs.
      stub.setLatest(110n);
      await indexer.poll();
      expect(await cursorBlock(db)).toBe(110n);

      await expect(indexer.poll()).rejects.toThrow(/reorg under the cursor at block 110/);
      await expect(indexer.status()).resolves.toMatchObject({ ready: false, forked: 110n });
    });

    it("verifies the cursor before every window of a catch-up, not once per tick", async () => {
      // The gap a single top-of-tick check leaves. A catch-up commits several
      // ranges, and a reorg landing between two of them rewrites blocks a
      // window that has already committed: the next window would then write a
      // cursor read from the replacement chain — self-consistent with it — and
      // no later tick could tell that the rows behind it came from a chain that
      // is gone. Here the reorg rewrites block 3000, inside the first window,
      // while that window's logs are in flight; the check in front of the second
      // window is the only thing that can see it.
      let stub: Stub;
      stub = makeStub({
        logs: [posted(3n), claimed(6000n)],
        latest: 11_999n,
        maxSpan: 5000,
        onGetLogs: (from) => {
          if (from === 0n) stub.reorgFrom(3000n);
        },
      });
      const indexer = start(stub);

      await expect(indexer.coldStart()).rejects.toThrow(/reorg under the cursor at block 4999/);

      // It stopped at the last range it can still vouch for: the second window
      // was never even read, and no cursor past the first was written.
      expect(windows(stub.getLogsCalls)).toEqual([[0n, 4999n]]);
      expect(await cursorBlock(db)).toBe(4999n);
      await expect(indexer.status()).resolves.toMatchObject({ ready: false, forked: 4999n });
    });

    it("trips on a reorg that lands between the window's hash and the cursor check", async () => {
      // The instant the read order inside the loop is chosen for. The window's
      // hash is read first, then the cursor is checked, then the logs: a reorg
      // arriving between the first two is caught by the check itself. Check the
      // cursor first instead and this same interleaving passes the check on the
      // old chain while both the window's hash and its logs come from the new
      // one — a self-consistent commit, and the ranges below the cursor keep the
      // old chain's rows with nothing left to notice.
      let stub: Stub;
      stub = makeStub({
        logs: [posted(5n)],
        latest: 100n,
        onBlockHash: (block) => {
          // After block 110's hash has been served — the window's — and before
          // the cursor's own block is asked for.
          if (block === 110n) stub.reorgFrom(100n);
        },
      });
      const indexer = start(stub);

      await indexer.poll();
      expect(await cursorBlock(db)).toBe(100n);

      stub.setLatest(110n);
      await expect(indexer.poll()).rejects.toThrow(/reorg under the cursor at block 100/);

      // Nothing was read and nothing was committed on the chain that replaced it.
      expect(stub.getLogsCalls.filter((call) => call.from === 101n)).toHaveLength(0);
      expect(await cursorBlock(db)).toBe(100n);
      await expect(indexer.status()).resolves.toMatchObject({ ready: false, forked: 100n });
    });

    it("trips when the endpoint's chain reaches past the cursor but has no such block", async () => {
      // A replacement chain that does not contain the block under the cursor at
      // all. An endpoint claiming a chain this long and unable to produce one of
      // its blocks has no innocent reading, so the missing block is a reorg told
      // a different way rather than an RPC fault to retry.
      const stub = makeStub({ logs: [posted(2n)], latest: 20n });
      const indexer = start(stub);
      await indexer.coldStart();
      expect(await cursorBlock(db)).toBe(20n);

      const pruned = makeStub({ logs: [posted(2n)], latest: 25n, missingBlocks: [20n] });
      const afterFailover = startIndexer(pruned.chain, db, config());
      running.push(afterFailover);

      await expect(afterFailover.poll()).rejects.toThrow(/reorg under the cursor at block 20/);
      await expect(afterFailover.status()).resolves.toMatchObject({ ready: false, forked: 20n });
    });

    it("does not trip when the endpoint is simply behind the cursor", async () => {
      // The same answer — no such block — from an endpoint whose head has not
      // reached it. Indistinguishable from a failover to a node that is still
      // syncing, so it is a failure to retry and never a latched fork: the tick
      // fails, the cursor stands, and readiness is already false because the
      // head is behind it. A chain that really did get shorter is caught when it
      // grows back past the cursor and the block there hashes differently.
      const stub = makeStub({ logs: [posted(2n)], latest: 20n });
      const indexer = start(stub);
      await indexer.coldStart();

      const lagging = makeStub({ logs: [posted(2n)], latest: 5n, missingBlocks: [20n] });
      const afterFailover = startIndexer(lagging.chain, db, config());
      running.push(afterFailover);

      // viem's own `BlockNotFoundError`, re-raised rather than converted: the
      // tick fails and the range is retried, exactly as any RPC fault is.
      await expect(afterFailover.poll()).rejects.toThrow(/Block at number "20" could not be found/);
      await expect(afterFailover.status()).resolves.toEqual({
        cursor: 20n,
        head: 5n,
        ready: false,
        forked: null,
      });
      expect(await cursorBlock(db)).toBe(20n);
    });

    it("keeps the loop from rescheduling once the guard has tripped", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const stub = makeStub({ logs: [posted(5n)], latest: 120n });
      const indexer = start(stub, { blockTimeMs: 5 });
      await indexer.start();

      stub.reorgFrom(118n);
      stub.setLatest(125n);
      await vi.waitFor(() => {
        expect(errors).toHaveBeenCalled();
      });

      // A loop that carried on would keep asking the endpoint for the head; a
      // stopped one never asks again.
      const after = stub.headReads;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stub.headReads).toBe(after);
    });
  });

  describe("the poll loop", () => {
    it("cold starts, then keeps polling on the block-time interval", async () => {
      const stub = makeStub({ logs: [posted(2n)], latest: 5n });
      const indexer = start(stub, { blockTimeMs: 5 });

      await indexer.start();
      expect(await cursorBlock(db)).toBe(5n);

      stub.logs.push(claimed(8n));
      stub.setLatest(9n);

      await vi.waitFor(async () => {
        expect(await cursorBlock(db)).toBe(9n);
      });
      expect(await state()).toBe(1);

      await indexer.stop();
      const after = stub.getLogsCalls.length;
      stub.setLatest(50n);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(stub.getLogsCalls).toHaveLength(after);
    });

    it("keeps polling after a failure instead of dying on it", async () => {
      // The cursor not advancing is the whole retry mechanism (R2's corollary):
      // a loop that stopped on the first transient RPC fault would need a
      // process restart to index again.
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const stub = makeStub({ logs: [posted(2n)], latest: 5n });
      const indexer = start(stub, { blockTimeMs: 5 });

      await indexer.start();

      stub.failGetLogs({ code: -32603, message: "internal error" });
      stub.logs.push(claimed(8n));
      stub.setLatest(9n);

      await vi.waitFor(() => {
        expect(errors).toHaveBeenCalled();
      });
      expect(await cursorBlock(db)).toBe(5n);

      stub.failGetLogs(null);
      await vi.waitFor(async () => {
        expect(await cursorBlock(db)).toBe(9n);
      });
    });

    it("refuses a second start, so two loops can never race", async () => {
      const stub = makeStub({ latest: 1n });
      const indexer = start(stub, { blockTimeMs: 5 });

      await indexer.start();
      await expect(indexer.start()).rejects.toThrow(/already started/i);
    });
  });
});
