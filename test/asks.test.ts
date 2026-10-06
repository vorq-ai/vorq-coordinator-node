import type { FastifyInstance } from "fastify";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { askRegistryAbi } from "../src/abi/askRegistry.js";
import { buildApp } from "../src/api/app.js";
import { MAX_PUSH_BYTES } from "../src/api/routes/asks.js";
import { publishSnapshot, startPublisher, storeSnapshot } from "../src/asks/publisher.js";
import { MAX_QUOTES } from "../src/asks/push.js";
import { RelayUnavailableError } from "../src/chain/client.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { EIP712_NAMES, UINT128_MAX } from "../src/orders.js";
import { formatUsd, parseUsd } from "../src/money.js";
import {
  refusedBroadcast,
  stubChain,
  stubTxHash,
  testConfig,
  unreachableEndpoint,
  type StubChain,
} from "./support/stub-chain.js";

/**
 * `PUT /evm/asks`, `GET /evm/asks`, the publisher, and the relay queue's bound.
 *
 * Driven against a canned endpoint and a canned store: no database and no chain,
 * so this file runs in every `npm test` (R25, R40).
 *
 * **The EIP-712 domain and the two type strings are written out literally**,
 * from `vorq-evm-contracts/src/AskRegistry.sol`, and never imported from
 * `src/asks/push.ts` (R32, R64). A wrong member order that both sides share
 * agrees with itself and recovers a consistent — and wrong — address.
 */

const config = testConfig();
const { chainId, askRegistry } = config.addresses;

/** Throwaway scalars. Neither has ever held value on any chain. */
const operator = privateKeyToAccount(`0x${"aa".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"bb".repeat(32)}`);

const PROVIDER_ID = 7n;
const TOKEN = "vorq_sess_0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Signing, to the contract's own typehash strings
// ---------------------------------------------------------------------------

const domain = {
  name: EIP712_NAMES.ask,
  version: "2",
  chainId,
  verifyingContract: askRegistry,
} as const;

/**
 * `AskSnapshot(uint32 providerId,uint64 signedAt,Ask[] quotes)`
 * `Ask(uint32 modelId,uint32 sla,uint128 rateIn,uint128 rateOut)`
 */
const types = {
  AskSnapshot: [
    { name: "providerId", type: "uint32" },
    { name: "signedAt", type: "uint64" },
    { name: "quotes", type: "Ask[]" },
  ],
  Ask: [
    { name: "modelId", type: "uint32" },
    { name: "sla", type: "uint32" },
    { name: "rateIn", type: "uint128" },
    { name: "rateOut", type: "uint128" },
  ],
} as const;

interface WireQuote {
  model_id: number;
  sla: number;
  rate_in: string;
  rate_out: string;
}
interface WireSnapshot {
  provider_id: number;
  signed_at: number;
  quotes: WireQuote[];
}

const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/**
 * Runs `body` with `Date.now` frozen, for the two tests that sit **on** the skew
 * bound.
 *
 * Those fixtures are built from a clock the test samples and the route
 * (`src/api/routes/asks.ts`) re-samples for itself. A request that lands one
 * wall-clock second after the sample reads `now + 3601` as exactly `now + 3600`
 * — the *accepted* edge — and the run fails `- 400 / + 503` on a race that has
 * nothing to do with the property under test. Measured: one failure in four full
 * `test:ci` runs, and reproduced deterministically by shifting the fixture one
 * second. Pre-existing Plan 2 code; Plan 3's added tests only made the suite slow
 * enough to cross the second boundary often.
 *
 * Only `Date.now` is frozen — not the timers — because the route's receipt wait
 * is a real timer and a test that mocked it would hang rather than fail.
 */
const atAFrozenClock = async (body: () => Promise<void>): Promise<void> => {
  const pinned = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(pinned);
  try {
    await body();
  } finally {
    clock.mockRestore();
  }
};

const quote = (overrides: Partial<WireQuote> = {}): WireQuote => ({
  model_id: 1,
  sla: 3600,
  rate_in: "0.03",
  rate_out: "0.09",
  ...overrides,
});

const snapshot = (overrides: Partial<WireSnapshot> = {}): WireSnapshot => ({
  provider_id: Number(PROVIDER_ID),
  signed_at: Number(now()),
  quotes: [quote()],
  ...overrides,
});

/** The snapshot as `quotes_live` stores it: every member the atomic decimal string. */
const stored = (s: WireSnapshot) => ({
  provider_id: String(s.provider_id),
  signed_at: String(s.signed_at),
  quotes: s.quotes.map((q) => ({
    model_id: String(q.model_id),
    sla: String(q.sla),
    rate_in: parseUsd(q.rate_in, 6).toString(),
    rate_out: parseUsd(q.rate_out, 6).toString(),
  })),
});

const message = (s: WireSnapshot) => ({
  providerId: Number(s.provider_id),
  signedAt: BigInt(s.signed_at),
  quotes: s.quotes.map((q) => ({
    modelId: Number(q.model_id),
    sla: Number(q.sla),
    rateIn: parseUsd(q.rate_in, 6),
    rateOut: parseUsd(q.rate_out, 6),
  })),
});

const sign = (s: WireSnapshot, signer = operator): Promise<Hex> =>
  signer.signTypedData({ domain, types, primaryType: "AskSnapshot", message: message(s) });

const body = async (s: WireSnapshot, signer = operator) => ({
  snapshot: s,
  signature: await sign(s, signer),
});

// ---------------------------------------------------------------------------
// An `AsksPublished` log, as a receipt carries one
// ---------------------------------------------------------------------------

/**
 * One `AsksPublished` log — and, because `address` is a parameter, a **wrong**
 * one.
 *
 * The three discriminations `landed()` makes are all against this log: the
 * provider it names, the `signedAt` it carries, and the contract it came from.
 * With a builder that could only produce the *right* log, none of them was
 * expressible, so every one of them could be deleted with the suite still green
 * — fail-open, and R29 exists entirely to stop the fail-open case (R81,
 * R64/R65). A forged, stale or foreign proof has to be constructible before any
 * test can assert it is refused.
 */
function asksPublishedLog(
  providerId: bigint,
  signedAt: bigint,
  quotes: WireQuote[],
  address: `0x${string}` = askRegistry,
) {
  const topics = encodeEventTopics({
    abi: askRegistryAbi,
    eventName: "AsksPublished",
    args: { providerId: Number(providerId) },
  });
  const data = encodeAbiParameters(
    [
      { name: "signedAt", type: "uint64" },
      {
        name: "quotes",
        type: "tuple[]",
        components: [
          { name: "modelId", type: "uint32" },
          { name: "sla", type: "uint32" },
          { name: "rateIn", type: "uint128" },
          { name: "rateOut", type: "uint128" },
        ],
      },
    ],
    [
      signedAt,
      quotes.map((q) => ({
        modelId: Number(q.model_id),
        sla: Number(q.sla),
        rateIn: parseUsd(q.rate_in, 6),
        rateOut: parseUsd(q.rate_out, 6),
      })),
    ],
  );
  return {
    address,
    topics,
    data,
    blockNumber: "0x3e8",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: stubTxHash(1),
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

// ---------------------------------------------------------------------------
// The store these routes read and write
// ---------------------------------------------------------------------------

interface QuoteRow {
  provider_id: bigint;
  snapshot: string;
  signature: Buffer;
  signed_at: bigint;
  published_signed_at: bigint;
}

interface AskRow {
  provider_id: bigint;
  model_id: bigint;
  sla: bigint;
  rate_in: bigint;
  rate_out: bigint;
  listed?: boolean;
}

interface StoreOptions {
  /** Operator address → provider id, as the providers projection answers. */
  operators?: Map<string, bigint>;
  quotes?: Map<bigint, QuoteRow>;
  asks?: AskRow[];
  /** No session row, so `requireSession` refuses. */
  noSession?: boolean;
}

interface Store {
  db: Db;
  quotes: Map<bigint, QuoteRow>;
  /** Every statement, so "nothing was written" is provable. */
  statements: string[];
}

function stubDb(options: StoreOptions = {}): Store {
  const operators =
    options.operators ?? new Map([[operator.address.toLowerCase(), PROVIDER_ID]]);
  const quotes = options.quotes ?? new Map<bigint, QuoteRow>();
  const asks = options.asks ?? [];
  const statements: string[] = [];

  const query = (async (text: string, params: readonly unknown[] = []) => {
    statements.push(text);

    if (text.includes("FROM sessions")) {
      if (options.noSession === true || params[0] !== TOKEN) return { rows: [] };
      return {
        rows: [
          {
            token: TOKEN,
            address: Buffer.from(operator.address.slice(2), "hex"),
            role: "provider",
            provider_id: PROVIDER_ID,
            expires_at: now() + 3600n,
          },
        ],
      };
    }

    if (text.includes("FROM providers WHERE operator")) {
      const key = `0x${(params[0] as Buffer).toString("hex")}`;
      const id = operators.get(key.toLowerCase());
      return { rows: id === undefined ? [] : [{ provider_id: id }] };
    }

    if (text.includes("FROM quotes_live") && text.includes("signed_at > published_signed_at")) {
      return {
        rows: [...quotes.values()]
          .filter((row) => row.signed_at > row.published_signed_at)
          .map((row) => ({ ...row })),
      };
    }

    if (text.includes("FROM quotes_live")) {
      const row = quotes.get(BigInt(params[0] as bigint));
      return { rows: row === undefined ? [] : [{ ...row }] };
    }

    if (text.includes("INSERT INTO quotes_live")) {
      const [providerId, snapshotText, signature, signedAt] = params as [
        bigint,
        string,
        Buffer,
        bigint,
      ];
      const previous = quotes.get(providerId);
      quotes.set(providerId, {
        provider_id: providerId,
        snapshot: snapshotText,
        signature,
        signed_at: signedAt,
        published_signed_at: previous?.published_signed_at ?? 0n,
      });
      return { rows: [] };
    }

    if (text.includes("UPDATE quotes_live")) {
      const [providerId, publishedAt] = params as [bigint, bigint];
      const row = quotes.get(providerId);
      // The monotonic guard is applied **only because the SQL asks for it** —
      // the same rule as the `p.listed` join below. A stub that raises the floor
      // monotonically whatever the statement says is a stub in which
      // `AND published_signed_at < $2` can be deleted with everything still
      // green, and the deletion is fail-open: a late confirmation would then
      // walk a provider's published floor backwards (R64/R65, R81).
      const guarded = text.includes("published_signed_at < $2");
      if (row !== undefined && (!guarded || row.published_signed_at < publishedAt)) {
        row.published_signed_at = publishedAt;
      }
      return { rows: [] };
    }

    if (text.includes("FROM asks_chain")) {
      const modelFilter = text.includes("model_id = $1") ? (params[0] as bigint) : null;
      // Filtered only because the query says so. A stub that applies the join
      // whatever the SQL asks for cannot see the join being deleted, and the
      // test that exists to pin it passes with the mechanism gone (R64).
      const listedOnly = text.includes("p.listed");
      const rows = asks
        .filter((row) => !listedOnly || row.listed !== false)
        .filter((row) => modelFilter === null || row.model_id === modelFilter)
        .sort((a, b) =>
          a.provider_id === b.provider_id
            ? Number(a.model_id - b.model_id)
            : Number(a.provider_id - b.provider_id),
        );
      const limit = Number(params[params.length - 2] as number);
      const offset = Number(params[params.length - 1] as number);
      return { rows: rows.slice(offset, offset + limit) };
    }

    if (text.includes("FROM cursor")) return { rows: [{ block_number: 9n }] };

    throw new Error(`stubDb: unexpected query ${text}`);
  }) as Db["query"];

  const db: Db = {
    query,
    tx: (fn) => fn({ query }),
    migrate: () => Promise.reject(new Error("stubDb: no migration expected")),
    close: async () => undefined,
  };
  return { db, quotes, statements };
}

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ChainOptions {
  /** What `lastSignedAt(providerId)` answers, before and after the relay. */
  lastSignedAt?: () => bigint;
  receiptLogs?: () => unknown[];
  /** `eth_getTransactionReceipt` answers `null`: broadcast, never mined. */
  receiptMissing?: boolean;
  sendError?: () => unknown;
  callError?: () => unknown;
  sendDelayMs?: number;
  relayMaxDepth?: number;
  relayQueueTimeoutMs?: number;
}

interface Harness {
  app: FastifyInstance;
  stub: StubChain;
  store: Store;
}

let open: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

function harness(store: StoreOptions = {}, chainOptions: ChainOptions = {}): Harness {
  const cfg = testConfig({
    relayMaxDepth: chainOptions.relayMaxDepth ?? 32,
    relayQueueTimeoutMs: chainOptions.relayQueueTimeoutMs ?? 10_000,
    relayerLowBalanceGwei: 50_000_000,
  });
  const answer = chainOptions.lastSignedAt ?? (() => 0n);
  const stub = stubChain(cfg, {
    views: {
      get lastSignedAt() {
        return answer();
      },
      // `resolveProviderId` settles a projection miss against the chain, so a
      // signer the projection does not know still costs one `idOf` (deps.ts).
      idOf: 0,
    },
    receiptLogs: chainOptions.receiptLogs,
    receiptMissing: chainOptions.receiptMissing,
    sendError: chainOptions.sendError,
    callError: chainOptions.callError,
    sendDelayMs: chainOptions.sendDelayMs,
  });
  const built = stubDb(store);
  const app = buildApp({
    db: built.db,
    indexer: stubIndexer(),
    config: cfg,
    chain: stub.chain,
  });
  open.push(app);
  return { app, stub, store: built };
}

const push = (app: FastifyInstance, payload: unknown, token: string | null = TOKEN) =>
  app.inject({
    method: "PUT",
    url: "/evm/asks",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

/** The `setAsks` batch the node actually broadcast, decoded from its calldata. */
const relayedBatch = (stub: StubChain) => {
  expect(stub.broadcasts).toHaveLength(1);
  const data = stub.relayed[0];
  expect(data).toBeDefined();
  const decoded = decodeFunctionData({ abi: askRegistryAbi, data: data as Hex });
  expect(decoded.functionName).toBe("setAsks");
  return decoded.args as readonly [readonly unknown[], readonly Hex[]];
};

// ---------------------------------------------------------------------------
// PUT /evm/asks — the push
// ---------------------------------------------------------------------------

describe("PUT /evm/asks", () => {
  it("accepts a signed snapshot, publishes it, and answers R17's body", async () => {
    const s = snapshot();
    const { app, stub, store } = harness(
      {},
      { receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)] },
    );

    const res = await push(app, await body(s));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider_id: Number(PROVIDER_ID),
      signed_at: s.signed_at,
      published: true,
      tx_hash: stubTxHash(1),
    });
    // R28: this door reads no index, so it stamps no block.
    expect(res.json()).not.toHaveProperty("as_of_block");

    // The calldata is the pushed snapshot, value for value (R54).
    const [batch, sigs] = relayedBatch(stub);
    expect(batch).toHaveLength(1);
    expect(sigs).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      providerId: Number(PROVIDER_ID),
      signedAt: BigInt(s.signed_at),
      quotes: [{ modelId: 1, sla: 3600, rateIn: 30_000n, rateOut: 90_000n }],
    });

    const row = store.quotes.get(PROVIDER_ID);
    expect(row?.signed_at).toBe(BigInt(s.signed_at));
    expect(row?.published_signed_at).toBe(BigInt(s.signed_at));
  });

  it("carries a uint128 rate through the wire, the row and the calldata exactly", async () => {
    // 39 digits in atomic units: a USD string carries it with nothing rounded.
    const rate = UINT128_MAX;
    const usd = formatUsd(rate, 6);
    const s = snapshot({ quotes: [quote({ rate_in: usd, rate_out: usd })] });
    const { app, stub } = harness(
      {},
      { receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)] },
    );

    expect((await push(app, await body(s))).statusCode).toBe(200);
    const [batch] = relayedBatch(stub);
    expect(batch[0]).toMatchObject({ quotes: [{ rateIn: rate, rateOut: rate }] });
  });

  it("403s a snapshot signed by a key that is no provider (R14)", async () => {
    const { app, stub, store } = harness();
    const res = await push(app, await body(snapshot(), stranger));

    expect(res.statusCode).toBe(403);
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    // `not_registered`, not `provider_mismatch`: the provider SDK branches on
    // this code to tell "this wallet is not a provider yet" from every other
    // 403, so which refusal fired is part of the contract and not a detail.
    expect(res.json().error).toMatchObject({
      type: "invalid_op_signature",
      code: "not_registered",
    });
    expect(stub.broadcasts).toEqual([]);
    expect(store.quotes.size).toBe(0);
  });

  it("403s a snapshot naming a provider the signer does not operate", async () => {
    // The snapshot names its own provider and the contract refuses a mismatch.
    // Refusing it here is what keeps the node from fronting gas for an entry
    // `setAsks` would silently skip.
    const { app, stub } = harness({
      operators: new Map([[operator.address.toLowerCase(), 9n]]),
    });
    const res = await push(app, await body(snapshot()));

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "provider_mismatch" });
    expect(stub.broadcasts).toEqual([]);
  });

  it("accepts exactly 64 quotes and 400s the 65th (R19)", async () => {
    const at = (n: number) => snapshot({ quotes: Array.from({ length: n }, () => quote()) });

    const full = at(MAX_QUOTES);
    const ok = harness(
      {},
      { receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(full.signed_at), full.quotes)] },
    );
    expect((await push(ok.app, await body(full))).statusCode).toBe(200);

    const over = at(MAX_QUOTES + 1);
    const { app, stub } = harness();
    const res = await push(app, await body(over));

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      type: "invalid_request_error",
      param: "snapshot.quotes",
    });
    expect(stub.broadcasts).toEqual([]);
  });

  it("400s a signed_at beyond now + 3600, mirroring the chain's own skip", async () => {
    // One second past the bound, and the clock frozen so it stays one second
    // past it while the request is in flight. See {@link atAFrozenClock}.
    await atAFrozenClock(async () => {
      const s = snapshot({ signed_at: Number(now() + 3601n) });
      const { app, stub } = harness();
      const res = await push(app, await body(s));

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ param: "snapshot.signed_at" });
      expect(stub.broadcasts).toEqual([]);
    });
  });

  it("accepts a signed_at of exactly now + 3600, the skew edge itself (R78)", async () => {
    // The other half of the bound, and the half a `>` → `>=` slip would break
    // in silence: the chain accepts exactly `now + 3600`, so refusing it here
    // locks out every provider whose clock is one hour fast and tells it, with
    // `400 invalid_request_error`, that its request is malformed. 3600 is
    // written out rather than imported from `push.ts` for the reason the domain
    // is (R32, R64): a bound that agrees with itself proves nothing.
    // Frozen for the same reason as the test above, in the other direction: a
    // clock that stepped backwards mid-request would put this fixture past the
    // bound and fail the accepted edge.
    await atAFrozenClock(async () => {
      const s = snapshot({ signed_at: Number(now() + 3600n) });
      const { app } = harness(
        {},
        { receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)] },
      );

      expect((await push(app, await body(s))).statusCode).toBe(200);
    });
  });

  it("409s a snapshot at or below the stored floor (R11)", async () => {
    const at = now();
    const stored = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: "{}",
          signature: Buffer.alloc(65),
          signed_at: at,
          published_signed_at: at,
        },
      ],
    ]);
    const { app, stub } = harness({ quotes: stored });

    const res = await push(app, await body(snapshot({ signed_at: Number(at) })));
    expect(res.statusCode).toBe(409);
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("accepts a signed_at of exactly floor + 1, the monotonic edge itself (R78)", async () => {
    // The first legal successor of the stored snapshot. A `<= floor + 1n`
    // operator refuses it as `409 stale`, which is indistinguishable from a
    // bricked floor to the provider — and every push after it is one second
    // later still, so the provider never gets back in.
    const at = now();
    const stored = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: "{}",
          signature: Buffer.alloc(65),
          signed_at: at,
          published_signed_at: at,
        },
      ],
    ]);
    const s = snapshot({ signed_at: Number(at + 1n) });
    const { app } = harness(
      { quotes: stored },
      {
        lastSignedAt: () => at,
        receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)],
      },
    );

    expect((await push(app, await body(s))).statusCode).toBe(200);
  });

  it("409s a snapshot at or below the CHAIN's floor with an empty store (R11)", async () => {
    // The wipe case, and the whole reason the floor is `max(stored, chain)`:
    // `quotes_live` is disposable in every deployment story that drops it, while
    // `AskRegistry.lastSignedAt` still stands. Checking the stored row alone
    // would accept a replay of an old signed snapshot after a wipe.
    const at = now();
    const { app, stub } = harness({}, { lastSignedAt: () => at });

    const res = await push(app, await body(snapshot({ signed_at: Number(at) })));
    expect(res.statusCode).toBe(409);
    expect(stub.broadcasts).toEqual([]);
  });

  it("re-publishes an identical snapshot the node accepted but never proved published", async () => {
    // A push that stored the row and then failed to relay answered `503`,
    // retryable — so the identical request must be able to succeed later (R57).
    // A bare `signed_at > stored.signed_at` rule would answer it `409` forever.
    const s = snapshot();
    const stored = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: "{}",
          signature: Buffer.alloc(65),
          signed_at: BigInt(s.signed_at),
          published_signed_at: 0n,
        },
      ],
    ]);
    const { app, stub } = harness(
      { quotes: stored },
      { receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)] },
    );

    expect((await push(app, await body(s))).statusCode).toBe(200);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("refuses that re-push once the CHAIN already carries it, at the edge (R78, A-E)", async () => {
    // **The fail-open edge of the one admitted equality.** The re-push above is
    // allowed only while `push.signedAt > chainFloor` — the node stored the row,
    // never proved it published, and the chain is still behind it. The moment the
    // chain carries that exact `signedAt`, the snapshot **is** published and
    // re-relaying it pays gas for a `setAsks` the contract skips (R29).
    //
    // Flipped to `>=` the suite stayed green, because the only fixture with an
    // unpublished stored row had `lastSignedAt` at 0 — the equality case was
    // never built. Here the chain sits exactly on the stored `signed_at` while
    // `published_signed_at` is still 0, which is precisely the state a lost
    // confirmation leaves behind.
    const s = snapshot();
    const at = BigInt(s.signed_at);
    const stored = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: "{}",
          signature: Buffer.alloc(65),
          signed_at: at,
          published_signed_at: 0n,
        },
      ],
    ]);
    const { app, stub } = harness({ quotes: stored }, { lastSignedAt: () => at });

    const res = await push(app, await body(s));

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "stale_snapshot" });
    expect(stub.broadcasts).toEqual([]);
  });

  it("401s without a session, before it reads the chain or the store", async () => {
    const { app, stub } = harness();
    const res = await push(app, await body(snapshot()), null);

    expect(res.statusCode).toBe(401);
    expect(stub.requests).toEqual([]);
  });

  it("400s a signature that is not 65 bytes", async () => {
    const { app, stub } = harness();
    const res = await push(app, { snapshot: snapshot(), signature: `0x${"11".repeat(64)}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "signature" });
    expect(stub.requests).toEqual([]);
  });

  it("names the exact quote member that is wrong, as a path", async () => {
    const { app, stub } = harness();
    const quotes = [quote(), quote(), quote(), quote({ rate_in: "1e3" })];
    const res = await push(app, { snapshot: snapshot({ quotes }), signature: `0x${"11".repeat(65)}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      type: "invalid_request_error",
      param: "snapshot.quotes[3].rate_in",
    });
    expect(stub.requests).toEqual([]);
  });

  it.each([
    ["a JSON number", 30000],
    ["more fraction digits than the token has", "0.0000001"],
    ["past the uint128 the chain holds", formatUsd(UINT128_MAX + 1n, 6)],
  ])("400s a rate sent as %s", async (_, rate) => {
    const { app, stub } = harness();
    const quotes = [quote({ rate_out: rate as string })];
    const res = await push(app, { snapshot: snapshot({ quotes }), signature: `0x${"11".repeat(65)}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "snapshot.quotes[0].rate_out" });
    expect(stub.requests).toEqual([]);
  });

  it("401s a malformed push with no session: the gate answers before the shape", async () => {
    const { app } = harness();
    const res = await app.inject({ method: "PUT", url: "/evm/asks", payload: { snapshot: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it("413s a body past this door's own limit", async () => {
    const { app } = harness();
    const res = await push(app, {
      snapshot: snapshot(),
      signature: `0x${"11".repeat(65)}`,
      padding: "x".repeat(MAX_PUSH_BYTES),
    });
    expect(res.statusCode).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// R29 — a successful setAsks tx proves nothing
// ---------------------------------------------------------------------------

describe("PUT /evm/asks — publication proof (R29)", () => {
  it("accepts lastSignedAt == signed_at as proof when the receipt carries no log", async () => {
    const s = snapshot();
    const { app, store } = harness(
      {},
      { lastSignedAt: (() => {
          let sent = false;
          return () => {
            const value = sent ? BigInt(s.signed_at) : 0n;
            sent = true;
            return value;
          };
        })() },
    );

    const res = await push(app, await body(s));
    expect(res.statusCode).toBe(200);
    expect(res.json().published).toBe(true);
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(BigInt(s.signed_at));
  });

  it("503s retryably when the tx mined and proved nothing, leaving the row unpublished", async () => {
    // The ruling itself: `setAsks` skips rather than reverts, so a successful
    // receipt is not evidence. Recording this as published would raise the
    // node's monotonic floor above the chain's forever and brick the provider's
    // book. The only skip a validated push can still meet is the chain's own
    // clock skew, which resolves as time passes — so the answer is retryable.
    const s = snapshot();
    const { app, store, stub } = harness({}, { lastSignedAt: () => 0n });

    const res = await push(app, await body(s));

    expect(res.statusCode).toBe(503);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toHaveLength(1);
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });

  // The three below are the fail-OPEN direction of the same rule (R81). Each
  // hands the publisher a receipt carrying a log that is *shaped* like a proof
  // and is not one; the chain's floor stays at 0, so the only honest answer is
  // "nothing was proved". A `landed()` that skipped any one of its three
  // comparisons would answer 200 here and mark the row published — which raises
  // this node's floor above the chain's permanently and refuses every later
  // honest push from that provider as stale. Fail-closed costs a retry;
  // fail-open costs the provider's book.
  it("does not accept a log for a different provider as proof (R29)", async () => {
    const s = snapshot();
    const { app, store } = harness(
      {},
      {
        lastSignedAt: () => 0n,
        receiptLogs: () => [asksPublishedLog(9n, BigInt(s.signed_at), s.quotes)],
      },
    );

    const res = await push(app, await body(s));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "publication_skipped" });
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });

  it("does not accept a log at a lower signed_at as proof (R29)", async () => {
    // A stale log — the previous snapshot's publication, still in the same
    // receipt because the transaction touched the registry twice. It proves the
    // provider published *something*, and nothing about this snapshot.
    const s = snapshot();
    const { app, store } = harness(
      {},
      {
        lastSignedAt: () => 0n,
        receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at) - 1n, s.quotes)],
      },
    );

    const res = await push(app, await body(s));
    expect(res.statusCode).toBe(503);
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });

  it("does not accept a correctly-shaped log from another contract as proof (R29)", async () => {
    // Right provider, right `signedAt`, right topic — wrong address. A receipt
    // carries every log the transaction produced, so trusting a log by its
    // topic alone lets any contract the transaction happened to touch claim a
    // publication.
    const s = snapshot();
    const { app, store } = harness(
      {},
      {
        lastSignedAt: () => 0n,
        receiptLogs: () => [
          asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes, config.addresses.jobRegistry),
        ],
      },
    );

    const res = await push(app, await body(s));
    expect(res.statusCode).toBe(503);
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });

  it("never walks published_signed_at back when a late confirmation lands", async () => {
    // The race the brief names, driven directly because no request can reach it:
    // push #1 at `earlier` is still waiting on its receipt when push #2 at
    // `later` stores, relays and confirms. Then #1's proof arrives. Its
    // `markPublished(earlier)` must be a no-op — the floor only ever rises, and
    // the `AND published_signed_at < $2` guard is the whole of why.
    const s = snapshot();
    const later = BigInt(s.signed_at);
    const earlier = later - 5n;
    const quotes = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: JSON.stringify(stored(s)),
          signature: Buffer.alloc(65),
          signed_at: later,
          published_signed_at: later,
        },
      ],
    ]);
    const cfg = testConfig();
    const stub = stubChain(cfg, {
      views: { lastSignedAt: later },
      receiptLogs: () => [asksPublishedLog(PROVIDER_ID, earlier, s.quotes)],
    });
    const store = stubDb({ quotes });

    const outcome = await publishSnapshot(stub.chain, store.db, cfg, {
      providerId: PROVIDER_ID,
      signedAt: earlier,
      snapshot: { provider_id: PROVIDER_ID.toString(), signed_at: earlier.toString(), quotes: [] },
      signature: Buffer.alloc(65),
    });

    expect(outcome.kind).toBe("published");
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(later);
  });

  it("409s when a newer snapshot won the race, and does not leave the row for a boot loop", async () => {
    const s = snapshot();
    const ahead = BigInt(s.signed_at) + 5n;
    let sent = false;
    const { app, store } = harness(
      {},
      {
        lastSignedAt: () => {
          const value = sent ? ahead : 0n;
          sent = true;
          return value;
        },
      },
    );

    const res = await push(app, await body(s));
    expect(res.statusCode).toBe(409);
    // Marked, so `startPublisher` does not re-submit a snapshot the chain can
    // never accept on every boot for the rest of the node's life.
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(BigInt(s.signed_at));
  });
});

// ---------------------------------------------------------------------------
// Relay failures — R70/R72's classification, reused not reinvented
// ---------------------------------------------------------------------------

describe("PUT /evm/asks — relay failures", () => {
  it("503s a refused broadcast through sendFailure's relayer envelope", async () => {
    const { app, store } = harness({}, { sendError: () => refusedBroadcast("nonce too low") });
    const res = await push(app, await body(snapshot()));

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      type: "relay_unavailable",
      code: "nonce_conflict",
    });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    // Stored, unpublished — the boot sweep is what carries it (the brief's
    // crash window, reached here without a crash).
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });

  it("503s a dead endpoint on the floor read rather than calling it a verdict (R72)", async () => {
    const { app, stub } = harness({}, { callError: () => unreachableEndpoint() });
    const res = await push(app, await body(snapshot()));

    expect(res.statusCode).toBe(503);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    // Never a 409: the chain pronounced nothing, so there is no verdict to
    // report and re-sending the identical push can succeed the moment the RPC
    // answers again.
    expect(res.statusCode).not.toBe(409);
    expect(stub.broadcasts).toEqual([]);
  });

  it("504s a broadcast whose receipt never arrives, and does not call it retryable", async () => {
    // The one failure on this door that happens **after** the bytes are on the
    // wire. Classified generically it reads `503 chain_unreachable`, retryable,
    // and points the operator at an RPC endpoint that is perfectly healthy — and
    // a provider daemon obeying `x-vorq-retryable: true` re-pushes, is admitted
    // by `retryOfUnpublished`, and makes this node broadcast and pay for a
    // second transaction for the same snapshot. `504` is not retryable and says
    // the true thing: poll, do not re-push.
    const s = snapshot();
    const payload = await body(s);
    const { app, stub, store } = harness({}, { receiptMissing: true });
    // Booted on the real clock: plugin loading is timed by avvio, and 70 s of
    // fake time would expire its plugin timeout before the app ever answered.
    await app.ready();

    vi.useFakeTimers();
    let res;
    try {
      const pending = push(app, payload);
      // viem's own receipt timeout is 60 s here; advanced rather than waited on.
      await vi.advanceTimersByTimeAsync(70_000);
      res = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode).toBe(504);
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(res.json().error).toMatchObject({ type: "receipt_timeout" });
    // Broadcast once, and exactly once: nothing here re-sends.
    expect(stub.broadcasts).toHaveLength(1);
    // Stored and unpublished, which is what makes "poll rather than re-push"
    // honest — the boot sweep is what finishes this row.
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// The publisher's boot sweep
// ---------------------------------------------------------------------------

describe("startPublisher", () => {
  it("re-submits a row the node accepted but never published, and marks it", async () => {
    const s = snapshot();
    const signature = Buffer.from((await sign(s)).slice(2), "hex");
    const quotes = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: JSON.stringify(stored(s)),
          signature,
          signed_at: BigInt(s.signed_at),
          published_signed_at: 0n,
        },
      ],
    ]);
    const cfg = testConfig();
    const stub = stubChain(cfg, {
      views: { lastSignedAt: 0n },
      receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)],
    });
    const store = stubDb({ quotes });

    const outcome = await startPublisher(stub.chain, store.db, cfg);

    expect(outcome.resubmitted).toBe(1);
    expect(store.quotes.get(PROVIDER_ID)?.published_signed_at).toBe(BigInt(s.signed_at));
    const [batch] = (() => {
      const decoded = decodeFunctionData({ abi: askRegistryAbi, data: stub.relayed[0] as Hex });
      return decoded.args as readonly [readonly unknown[], readonly Hex[]];
    })();
    expect(batch).toHaveLength(1);
  });

  it("leaves a fully published row alone", async () => {
    const s = snapshot();
    const at = BigInt(s.signed_at);
    const quotes = new Map([
      [
        PROVIDER_ID,
        {
          provider_id: PROVIDER_ID,
          snapshot: JSON.stringify(stored(s)),
          signature: Buffer.alloc(65),
          signed_at: at,
          published_signed_at: at,
        },
      ],
    ]);
    const cfg = testConfig();
    const stub = stubChain(cfg, { views: { lastSignedAt: at } });

    const outcome = await startPublisher(stub.chain, stubDb({ quotes }).db, cfg);

    expect(outcome.resubmitted).toBe(0);
    expect(stub.broadcasts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /evm/asks — the book
// ---------------------------------------------------------------------------

describe("GET /evm/asks", () => {
  const asks: AskRow[] = [
    { provider_id: 7n, model_id: 1n, sla: 3600n, rate_in: 30000n, rate_out: 90000n },
    { provider_id: 8n, model_id: 2n, sla: 3600n, rate_in: 10000n, rate_out: 20000n },
    {
      provider_id: 9n,
      model_id: 1n,
      sla: 3600n,
      rate_in: 1n,
      rate_out: 2n,
      listed: false,
    },
  ];

  it("serves the asks_chain projection in R18's exact shape", async () => {
    const { app } = harness({ asks });
    const res = await app.inject({ method: "GET", url: "/evm/asks" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      asks: [
        {
          provider_id: 7,
          model_id: 1,
          sla: 3600,
          rate_in: "0.03",
          rate_out: "0.09",
        },
        {
          provider_id: 8,
          model_id: 2,
          sla: 3600,
          rate_in: "0.01",
          rate_out: "0.02",
        },
      ],
      as_of_block: 9,
    });
  });

  it("filters by model", async () => {
    const { app } = harness({ asks });
    const res = await app.inject({ method: "GET", url: "/evm/asks?model=2" });
    expect(res.json().asks.map((a: { provider_id: number }) => a.provider_id)).toEqual([8]);
  });

  it("bounds the page and signals the stop conditions (R56, R58, R61)", async () => {
    const many: AskRow[] = Array.from({ length: 5 }, (_, i) => ({
      provider_id: BigInt(i),
      model_id: 1n,
      sla: 3600n,
      rate_in: 1n,
      rate_out: 2n,
    }));
    const { app } = harness({ asks: many });

    const res = await app.inject({ method: "GET", url: "/evm/asks?limit=2&offset=1" });
    expect(res.json().asks.map((a: { provider_id: number }) => a.provider_id)).toEqual([1, 2]);
    expect(res.headers["x-vorq-page-truncated"]).toBe("false");

    const bad = await app.inject({ method: "GET", url: "/evm/asks?limit=100000" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ param: "limit" });
  });
});

// ---------------------------------------------------------------------------
// R76 — the relay queue's bound
// ---------------------------------------------------------------------------

describe("Chain.relay admission control (R76)", () => {
  const target = testConfig().addresses.askRegistry;

  it("refuses past RELAY_MAX_DEPTH rather than queueing without limit", async () => {
    const cfg = testConfig({ relayMaxDepth: 4, relayQueueTimeoutMs: 10_000 });
    const stub = stubChain(cfg, { sendDelayMs: 5 });

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => stub.chain.relay({ to: target, data: "0xdead" })),
    );
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly the depth is admitted and the rest refused — not "some of them",
    // which a queue with no bound at all could also satisfy on a slow day.
    expect(refused).toHaveLength(8);
    expect(refused[0]?.reason).toBeInstanceOf(RelayUnavailableError);
    expect((refused[0]?.reason as RelayUnavailableError).code).toBe("relay_queue_full");
    // Only the admitted ones ever reached the wire.
    expect(stub.broadcasts).toHaveLength(4);
  });

  it("lets an entry leave after RELAY_QUEUE_TIMEOUT_MS without sending it", async () => {
    const cfg = testConfig({ relayMaxDepth: 32, relayQueueTimeoutMs: 25 });
    const stub = stubChain(cfg, { sendDelayMs: 40 });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => stub.chain.relay({ to: target, data: "0xbeef" })),
    );
    const timedOut = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" &&
        r.reason instanceof RelayUnavailableError &&
        r.reason.code === "relay_queue_timeout",
    );

    expect(timedOut.length).toBeGreaterThan(0);

    // **Drain first.** A send that is still in flight when the last race settles
    // is a broadcast this assertion would not see, and "no broadcast" would then
    // be true of the clock rather than of the code — the same shape as R65's
    // harness-did-the-serialising defect. 120 ms is three send RTTs.
    await new Promise((resolve) => setTimeout(resolve, 120));

    // The deadline bounds the WAIT, never the send: an abandoned entry takes its
    // turn and broadcasts nothing, so no nonce is spent — and, the half that
    // matters, an entry whose send has already begun is never abandoned, because
    // answering "retryable" for a transaction that may mine is the one answer
    // that must never be given.
    expect(stub.broadcasts.length).toBe(6 - timedOut.length);
  });

  it("answers a full queue as 503 relay_unavailable through the door, never 400", async () => {
    const s = snapshot();
    const { app, stub } = harness(
      {},
      { relayMaxDepth: 1, sendDelayMs: 20, receiptLogs: () => [] },
    );
    // Fill the one slot with a relay that is still in flight.
    const held = stub.chain.relay({ to: target, data: "0xfeed" });
    const res = await push(app, await body(s));
    await held.catch(() => undefined);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      type: "relay_unavailable",
      code: "relay_queue_full",
    });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// The Postgres boundary — R54a, and the only place it can be seen
// ---------------------------------------------------------------------------

/**
 * Gated on `TEST_DATABASE_URL` and deliberately part of the **unit** suite (R25): the
 * "no network" rule for `npm test` is about chain access, not a local database.
 *
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 *
 * Everything above this line runs against `stubDb`, which stores and returns a
 * string whatever the SQL says — so the four statements this door actually
 * depends on (`INSERT … $2::jsonb`, the floor `SELECT`, `markPublished`'s
 * `UPDATE`, and the sweep's `SELECT … snapshot::text`) were held up by nothing.
 * Measured: drop the `::text` and the driver hands back an **object**,
 * `JSON.parse` throws `"[object Object]" is not valid JSON`, and
 * `startPublisher`'s per-row `catch` swallows it and counts the row unresolved —
 * so the boot sweep would silently abandon **every** unpublished row on **every**
 * boot, which is the one promise the sweep exists to keep.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_asks_test";

/**
 * Points the connection at a schema of this suite's own instead of `public`.
 *
 * The suite drops and recreates that schema, and `TEST_DATABASE_URL` will sometimes
 * be set to a database with real data in it.
 */
function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("the ask door against a real Postgres (R54a)", () => {
  let db: Db;

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
    await db.query("DELETE FROM quotes_live");
  });

  /**
   * The route's own write — the shipped function, not a copy of its SQL.
   *
   * It used to be the statement written out again here "character for
   * character", which is the shape R67 warns about: the copy cannot go stale
   * loudly, it goes stale silently, and a guard added to one of the two is a
   * guard the test cannot see. `storeSnapshot` is now the only spelling.
   */
  const insert = (
    providerId: bigint,
    snapshotText: string,
    signature: Buffer,
    signedAt: bigint,
  ): Promise<void> => storeSnapshot(db, providerId, snapshotText, signature, signedAt);

  it("never lets an older push walk signed_at back (B-8)", async () => {
    // The interleave: the door reads the stored `signed_at`, refuses a stale
    // push, and then writes — two statements with no queue between them, so two
    // pushes from one provider can cross and the older one's write can land
    // last. Against a real Postgres, because the guard is in the `ON CONFLICT`
    // and a Map cannot have one.
    const newer = snapshot({ signed_at: 2000 });
    const older = snapshot({ signed_at: 1000 });
    const sig = Buffer.alloc(65, 0x11);

    await insert(PROVIDER_ID, JSON.stringify(stored(newer)), sig, 2000n);
    await insert(PROVIDER_ID, JSON.stringify(stored(older)), sig, 1000n);

    const { rows } = await db.query<{ signed_at: bigint; snapshot: string }>(
      "SELECT signed_at, snapshot::text AS snapshot FROM quotes_live WHERE provider_id = $1",
      [PROVIDER_ID],
    );
    // The older write was admitted before; now it is a no-op, and the snapshot
    // beside `signed_at` is still the newer one's — the pair cannot split.
    expect(rows[0]?.signed_at).toBe(2000n);
    expect(JSON.parse(rows[0]?.snapshot ?? "{}").signed_at).toBe("2000");

    // And the equal case still writes: an identical re-push of a snapshot stored
    // but never proved published is legitimate and must refresh the row.
    await insert(PROVIDER_ID, JSON.stringify(stored(newer)), Buffer.alloc(65, 0x22), 2000n);
    const { rows: again } = await db.query<{ signature: Buffer }>(
      "SELECT signature FROM quotes_live WHERE provider_id = $1",
      [PROVIDER_ID],
    );
    expect(again[0]?.signature?.[0]).toBe(0x22);
  });

  it("carries a uint128 rate from the INSERT through the sweep's SELECT into the calldata", async () => {
    // 2**128 - 1 is 39 digits: `jsonb` is the one hop in this path that could round it.
    const rate = UINT128_MAX;
    const usd = formatUsd(rate, 6);
    const s = snapshot({ quotes: [quote({ rate_in: usd, rate_out: usd })] });
    const signature = Buffer.from((await sign(s)).slice(2), "hex");
    await insert(PROVIDER_ID, JSON.stringify(stored(s)), signature, BigInt(s.signed_at));

    // A second provider, fully published. It is the sweep predicate's own test:
    // `signed_at > published_signed_at` must not select it, and only a real
    // `SELECT` can say so — the stub routes on the predicate's *text*, so
    // changing `>` to `>=` there moves which branch answers rather than what
    // the statement selects.
    const other = snapshot({ provider_id: 8, signed_at: Number(now() - 100n) });
    await insert(8n, JSON.stringify(stored(other)), Buffer.alloc(65), BigInt(other.signed_at));
    await db.query("UPDATE quotes_live SET published_signed_at = signed_at WHERE provider_id = 8");

    const cfg = testConfig();
    const stub = stubChain(cfg, {
      views: { lastSignedAt: 0n },
      receiptLogs: () => [asksPublishedLog(PROVIDER_ID, BigInt(s.signed_at), s.quotes)],
    });

    // The logger **throws** rather than counting: a sweep that swallows the one
    // failure this test exists to provoke would report `unresolved` and pass.
    const outcome = await startPublisher(stub.chain, db, cfg, (error) => {
      throw error;
    });

    expect(outcome).toEqual({ resubmitted: 1, unresolved: 0 });
    expect(stub.broadcasts).toHaveLength(1);

    const decoded = decodeFunctionData({ abi: askRegistryAbi, data: stub.relayed[0] as Hex });
    const [batch, sigs] = decoded.args as readonly [readonly unknown[], readonly Hex[]];
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      providerId: Number(PROVIDER_ID),
      signedAt: BigInt(s.signed_at),
      quotes: [{ modelId: 1, sla: 3600, rateIn: rate, rateOut: rate }],
    });
    // The signature is the provider's own bytes, back out of `BYTEA` unchanged.
    expect(sigs[0]).toBe(`0x${signature.toString("hex")}`);

    // `markPublished`'s real `UPDATE`, and the floor `SELECT` the route makes:
    // `BIGINT` columns arrive as `bigint`, never as a string or a rounded double
    // (R45).
    const { rows } = await db.query<{ signed_at: bigint; published_signed_at: bigint }>(
      "SELECT signed_at, published_signed_at FROM quotes_live WHERE provider_id = $1",
      [PROVIDER_ID],
    );
    expect(rows[0]).toEqual({
      signed_at: BigInt(s.signed_at),
      published_signed_at: BigInt(s.signed_at),
    });
    expect(typeof rows[0]?.published_signed_at).toBe("bigint");
  });

  it("never walks published_signed_at back, in the statement rather than in a stub", async () => {
    // The same race as above, against the real `UPDATE`: the guard is
    // `AND published_signed_at < $2` and nothing else enforces it here.
    const s = snapshot();
    const later = BigInt(s.signed_at);
    await insert(PROVIDER_ID, JSON.stringify(stored(s)), Buffer.alloc(65), later);
    await db.query("UPDATE quotes_live SET published_signed_at = $2 WHERE provider_id = $1", [
      PROVIDER_ID,
      later,
    ]);

    const cfg = testConfig();
    const stub = stubChain(cfg, {
      views: { lastSignedAt: later },
      receiptLogs: () => [asksPublishedLog(PROVIDER_ID, later - 5n, s.quotes)],
    });

    const outcome = await publishSnapshot(stub.chain, db, cfg, {
      providerId: PROVIDER_ID,
      signedAt: later - 5n,
      snapshot: { provider_id: PROVIDER_ID.toString(), signed_at: (later - 5n).toString(), quotes: [] },
      signature: Buffer.alloc(65),
    });

    expect(outcome.kind).toBe("published");
    const { rows } = await db.query<{ published_signed_at: bigint }>(
      "SELECT published_signed_at FROM quotes_live WHERE provider_id = $1",
      [PROVIDER_ID],
    );
    expect(rows[0]?.published_signed_at).toBe(later);
  });
});
