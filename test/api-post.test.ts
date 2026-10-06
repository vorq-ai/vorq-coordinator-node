import type { FastifyInstance } from "fastify";
import { formatUsd } from "../src/money.js";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  hashDomain,
  keccak256,
  parseTransaction,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { buildApp } from "../src/api/app.js";
import { MAX_POST_QUEUE_DEPTH } from "../src/api/routes/post.js";
import { ENVELOPE_RESERVE_BYTES, INLINE_MAX_BYTES, MAX_BODY_BYTES } from "../src/api/limits.js";
import type { Db } from "../src/db/db.js";
import type { Candidate } from "../src/match/rank.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { assertDomains, MAX_SLA_SECONDS } from "../src/orders.js";
import {
  commitmentOf,
  CONTAINER_TAG,
  MIN_CONTAINER_BYTES,
  SEED_WRAP_BYTES,
} from "../src/container.js";
import { cidForBytes } from "../src/pin/cid.js";
import { MAX_CID_CHARS } from "../src/pin/pinner.js";
import { externallyMintedCid, startStubStore, type StubStore } from "./support/stub-store.js";
import { EIP712_NAMES } from "../src/orders.js";
import {
  refusedBroadcast,
  refusedCall,
  stubChain,
  stubTxHash,
  testConfig,
  unreachableEndpoint,
  type Simulate,
  type StubChain,
} from "./support/stub-chain.js";

/**
 * `POST /v1/jobs` and `POST /v1/jobs/{id}/cancel` — the client's write doors.
 *
 * Driven against a canned endpoint and a canned store, so every assertion is
 * about **what the node would have sent**. "Nothing was relayed" is the property
 * most of these tests exist to prove, and it is proved by the absence of an
 * `eth_sendRawTransaction` in the recorded request log rather than by a status
 * code that could be right for the wrong reason.
 *
 * The EIP-712 domains and type strings below are written out **literally**, from
 * `JobRegistry.sol`, rather than imported from `src/orders.ts`. Importing them
 * would make a wrong member order agree with itself and pass (R32, R64).
 *
 * No database and no chain: this file runs in every `npm test`.
 */

const config = testConfig();
const { chainId, jobRegistry, usdc } = config.addresses;

/** Throwaway scalars. Neither has ever held value on any chain. */
const owner = privateKeyToAccount(`0x${"66".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"77".repeat(32)}`);

/**
 * A container v1, assembled here from its three parts rather than imported as a
 * fixture: `version ‖ seed_wrap ‖ ciphertext`, at the offsets `src/container.ts`
 * splits on.
 *
 * **`c` is derived from the bytes and never chosen.** That is the change this
 * file is mostly about: the client used to pick a `c` and pin its payload
 * separately, and the two were joined by nothing this node could check. Now `c`
 * *is* the commitment, so an order and its container either agree or the post is
 * refused.
 */
const containerOf = (wrapByte: number, ciphertext: string): Buffer =>
  Buffer.concat([
    CONTAINER_TAG,
    Buffer.alloc(SEED_WRAP_BYTES, wrapByte),
    Buffer.from(ciphertext, "utf8"),
  ]);

const CONTAINER = containerOf(0xd1, "a sealed prompt envelope");
const C = commitmentOf(CONTAINER);
const b64 = (bytes: Buffer): string => bytes.toString("base64");

/** The name the stub store mints for these bytes — deliberately not a spec CID. */
const MINTED_CID = externallyMintedCid(CONTAINER);

/**
 * The cid of an upload a body references instead of inlining its container.
 *
 * Deliberately not `MINTED_CID`: `container_cid` is a name the *files* door
 * already minted, and a fixture that reused the name this door would have minted
 * could not tell "relayed the upload's name" from "filed the bytes again".
 */
const UPLOAD_CID = "bafyuploadedcontainer";

/** An upload's `created_at`; its row starts at `+ 300`, the orphan window. */
const UPLOADED_AT = 1_700_000_000;

/** `expiresAt` well inside `(now, now+86400]`, recomputed per request. */
const soon = (): bigint => BigInt(Math.floor(Date.now() / 1000)) + 3600n;

interface Terms {
  c: Hex;
  modelId: bigint;
  slaSecs: bigint;
  rateIn: bigint;
  rateOut: bigint;
  unitsIn: bigint;
  unitsOut: bigint;
  designated: bigint;
  expiresAt: bigint;
}

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  c: C,
  modelId: 1n,
  slaSecs: 3600n,
  rateIn: 30_000n,
  rateOut: 90_000n,
  unitsIn: 1000n,
  unitsOut: 2000n,
  designated: 0n,
  expiresAt: soon(),
  ...overrides,
});

/**
 * What a submission over the default `terms()` must echo, at the harness's own
 * fee — written out rather than computed, like everything else here.
 *
 * `cap = ceil((30000*1000 + 90000*2000)/1e6) = 210`, and the protocol fee is
 * charged **on top** of it: at the harness's 100 bps (the protocol's real fee)
 * `210 * 100 / 10000 = 2`, floored, so the pull is `210 + 2 + gasFee`. The
 * harness quotes a gas fee of `0` unless a test asks for one, which is why the
 * bare call is the common one.
 */
const CAP = 210n;
const FEE = 2n;
const amountFor = (gasFee = 0n): bigint => CAP + FEE + gasFee;

// ---------------------------------------------------------------------------
// Signing, to the contracts' own typehash strings
// ---------------------------------------------------------------------------

const orderDomain = {
  name: EIP712_NAMES.job,
  version: "2",
  chainId,
  verifyingContract: jobRegistry,
} as const;

/**
 * `Order(bytes32 c,uint32 modelId,uint32 slaSecs,uint128 rateIn,uint128 rateOut,`
 * `uint32 unitsIn,uint32 unitsOut,uint32 designated,uint64 expiresAt)`
 *
 * `JobRegistry.ORDER_TYPEHASH`, member for member, **and `taskCid` is not one of
 * them**. Written out here from the contract source rather than imported from
 * `src/orders.ts`, so a wrong member list cannot agree with itself (R32, R64) —
 * and the ABI cannot tell you either, because `post` still takes the same struct
 * and its selector never moved. The type string is the whole difference, and the
 * two tests below sign over each version to prove it.
 */
const orderTypes = {
  Order: [
    { name: "c", type: "bytes32" },
    { name: "modelId", type: "uint32" },
    { name: "slaSecs", type: "uint32" },
    { name: "rateIn", type: "uint128" },
    { name: "rateOut", type: "uint128" },
    { name: "unitsIn", type: "uint32" },
    { name: "unitsOut", type: "uint32" },
    { name: "designated", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** The string as it stood before the CID left it. Used only to prove it fails now. */
const legacyOrderTypes = {
  Order: [...orderTypes.Order, { name: "taskCid", type: "bytes" }],
} as const;

const cidHex = (cid: string): Hex => `0x${Buffer.from(cid, "utf8").toString("hex")}`;

const orderMessage = (t: Terms) => ({
  c: t.c,
  modelId: Number(t.modelId),
  slaSecs: Number(t.slaSecs),
  rateIn: t.rateIn,
  rateOut: t.rateOut,
  unitsIn: Number(t.unitsIn),
  unitsOut: Number(t.unitsOut),
  designated: Number(t.designated),
  expiresAt: t.expiresAt,
});

const signOrder = (t: Terms, signer = owner): Promise<Hex> =>
  signer.signTypedData({
    domain: orderDomain,
    types: orderTypes,
    primaryType: "Order",
    message: orderMessage(t),
  });

/** The same terms, signed over the **old** type string — with a `taskCid` member. */
const signLegacyOrder = (t: Terms, taskCid: string, signer = owner): Promise<Hex> =>
  signer.signTypedData({
    domain: orderDomain,
    types: legacyOrderTypes,
    primaryType: "Order",
    message: { ...orderMessage(t), taskCid: cidHex(taskCid) },
  });

/** `keccak256(abi.encodePacked(owner, c))` — 20 bytes then 32. */
const jobIdFor = (address: Hex, c: Hex): Hex =>
  keccak256(`0x${address.slice(2)}${c.slice(2)}` as Hex);

/**
 * The payment token's own domain — four members, the token as
 * `verifyingContract` — and EIP-3009's `ReceiveWithAuthorization`, written out
 * from the token rather than imported from `src/orders.ts` (R32, R64).
 */
const authDomain = { name: "USDC", version: "2", chainId, verifyingContract: usdc } as const;

const authTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * `validBefore` is `expiresAt + 1`: the token requires `now < validBefore`, and
 * a claim may land on `expiresAt` itself.
 */
const signAuthorization = (
  jobId: Hex,
  value: bigint,
  expiresAt: bigint,
  signer = owner,
): Promise<Hex> =>
  signer.signTypedData({
    domain: authDomain,
    types: authTypes,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: owner.address,
      to: jobRegistry,
      value,
      validAfter: 0n,
      validBefore: expiresAt + 1n,
      nonce: jobId,
    },
  });

const cancelTypes = {
  Cancel: [
    { name: "jobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const signCancel = (jobId: Hex, issuedAt: bigint, signer = owner): Promise<Hex> =>
  signer.signTypedData({
    domain: orderDomain,
    types: cancelTypes,
    primaryType: "Cancel",
    message: { jobId, issuedAt },
  });

// ---------------------------------------------------------------------------
// The store this door reads
// ---------------------------------------------------------------------------

/** One `files` row, as the door's two `files` statements see it. */
interface Upload {
  owner: Buffer;
  purpose: string;
  commitment: Buffer | null;
  /** The row's own `created_at`, which the attach computes the new expiry from. */
  createdAt: number;
  /** Mutable, like the column: `created_at + FILE_ORPHAN_SECONDS` until an attach moves it. */
  expiresAt: number;
}

interface StoreOptions {
  /** Model ids the catalog knows, mapped to their `enabled` flag. */
  models?: Map<bigint, boolean>;
  /** Job ids the index already holds, confirmed by the indexer. */
  jobs?: Set<string>;
  /**
   * Job ids the index holds only as write-through rows, ahead of the cursor and
   * still reorg-able — the rows the duplicate pre-check must not refuse on.
   */
  unconfirmedJobs?: Set<string>;
  /** What the candidate ranking answers on the challenge. */
  candidates?: Candidate[];
  /** Every round-robin cursor bump the challenge issued: `[provider_id, model_id]`. */
  bumps?: unknown[][];
  /** Uploads a `container_cid` may name, by cid. */
  uploads?: Map<string, Upload>;
  /** Every `attachFile` the door ran: `[cid, owner, purpose, retentionSeconds]`. */
  attached?: unknown[][];
  /** Cids the sweep deletes between the lookup and the attach — `attachFile` then answers false. */
  swept?: Set<string>;
  /**
   * Every `jobs` row the write-through committed: `[job_id, posted_block]`.
   * Pushed only once the transaction resolves, so a row recorded here is a row
   * the door waited for.
   */
  written?: unknown[][];
  /** Makes the write-through transaction fail. */
  writeError?: Error;
}

/**
 * The reads the post door makes — the catalog row, the duplicate pre-check, and
 * the `files` row behind a `container_cid` — plus the write the pin makes into
 * the `pins` name book and the `expires_at` bump that attaches an upload.
 *
 * **There is no blob read on any path, and its absence is the change.** The door
 * used to resolve a `task_cid` the caller had already pinned; it now checks the
 * container against the commitment the caller signed — its own hash of the
 * inline bytes, or the one `POST /v1/files` wrote down — and never reads an
 * object back. A stub rather than a schema, so a read this door is not supposed
 * to make is a hard failure instead of an empty result set.
 */
function stubDb(options: StoreOptions = {}): Db {
  const models = options.models ?? new Map([[1n, true]]);
  const jobs = options.jobs ?? new Set<string>();
  const unconfirmed = options.unconfirmedJobs ?? new Set<string>();
  const uploads = options.uploads ?? new Map<string, Upload>();

  const query = (async (text: string, params?: readonly unknown[]) => {
    // The challenge's one store read (the candidate ranking) and its one bounded
    // write (the round-robin cursor). Checked first: the ranking's LATERAL
    // subquery reads `jobs` too, and must not be mistaken for the duplicate
    // pre-check below.
    if (text.includes("FROM providers p")) return { rows: options.candidates ?? [] };
    if (text.includes("UPDATE provider_presence")) {
      options.bumps?.push([...(params ?? [])]);
      return { rows: [] };
    }
    if (text.includes("FROM models")) {
      const enabled = models.get(BigInt(params?.[0] as bigint | number));
      return { rows: enabled === undefined ? [] : [{ enabled }] };
    }
    if (text.includes("FROM jobs")) {
      const jobId = params?.[0] as Buffer;
      const id = `0x${jobId.toString("hex")}`;
      // The stub applies the pre-check's own guard rather than trusting it: the
      // query excludes rows the indexer has not reached, so a query that lost
      // that clause finds the unconfirmed row here and the test goes red.
      const confirmedOnly = text.includes("NOT (posted_block >");
      const hit = jobs.has(id) || (unconfirmed.has(id) && !confirmedOnly);
      return { rows: hit ? [{ job_id: jobId }] : [] };
    }
    // `findUpload`: the whole predicate, owner and purpose included, so a test
    // that expects a miss gets one for the reason it named.
    if (text.includes("FROM files")) {
      const [cid, ownerBytes, purpose] = params as [string, Buffer, string];
      const found = uploads.get(cid);
      if (found === undefined || found.purpose !== purpose || !found.owner.equals(ownerBytes)) {
        return { rows: [] };
      }
      return { rows: [{ cid, commitment: found.commitment }] };
    }
    // `attachFile`, which answers by `rowCount`: zero means the sweep got there
    // first and the door must refuse rather than relay.
    if (text.includes("UPDATE files")) {
      const [cid, , , retention] = params as [string, Buffer, string, number];
      options.attached?.push([...(params ?? [])]);
      if (options.swept?.has(cid) === true) return { rows: [], rowCount: 0 };
      // The column moves, so a test can tell an attach that happened from one
      // that did not by reading the row rather than only the recorder.
      const row = uploads.get(cid);
      if (row !== undefined) row.expiresAt = row.createdAt + retention;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO pins")) return { rows: [{ s3_key: params?.[1] }] };
    throw new Error(`stubDb: unexpected query ${text}`);
  }) as unknown as Db["query"];

  // The write-through's one transaction: the reducer's `Posted` upsert, and
  // nothing else. Rows are recorded on commit, not on the statement.
  const tx: Db["tx"] = async (fn) => {
    if (options.writeError !== undefined) throw options.writeError;
    const staged: unknown[][] = [];
    const result = await fn({
      query: (async (text: string, params?: readonly unknown[]) => {
        if (!text.includes("INSERT INTO jobs")) throw new Error(`stubDb: unexpected tx query ${text}`);
        const [jobId, , , , , , , , , , , , postedBlock] = params as unknown[];
        staged.push([`0x${(jobId as Buffer).toString("hex")}`, postedBlock]);
        return { rows: [] };
      }) as unknown as Db["query"],
    });
    options.written?.push(...staged);
    return result;
  };

  return {
    query,
    tx,
    migrate: () => Promise.reject(new Error("stubDb: no migration expected")),
    close: async () => undefined,
  };
}

/**
 * The object store both write doors pin through, started once for this file.
 *
 * A real loopback HTTP server rather than a fake pinner: the pin is now on the
 * request path of every `201` this file asserts, so a door driven without one
 * would be driven without the step that mints the name it puts on chain.
 */
let store: StubStore;

beforeAll(async () => {
  store = await startStubStore();
});

afterAll(async () => {
  await store.close();
});

afterEach(() => {
  store.objects.clear();
  store.uploads.clear();
  store.requests.length = 0;
});

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

interface Harness {
  app: FastifyInstance;
  stub: StubChain;
  /** Mutable: the value `gasFee()` answers with, so drift is expressible. */
  setGasFee(value: bigint): void;
}

let open: FastifyInstance[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.map((app) => app.close()));
  open = [];
});

/**
 * Runs `request` with the node's clock frozen at exactly `second`.
 *
 * The boundary tests (R78) probe `expires_at` and `issued_at` **at** their edges,
 * not one past them, and at that precision a second ticking between the value
 * the test computed and the `Date.now()` the handler reads is the difference
 * between admitted and refused. Freezing removes the race from the assertion and
 * — more to the point — from the *mutation*: with a live clock, flipping the
 * operator to the exclusive form would go red only when the two reads landed in
 * the same second, which is a defence that passes by luck.
 *
 * Only `Date` is faked, the same choice `logs.test.ts` makes for the TTL tests:
 * viem's transports and Fastify's own timers stay on real ones, and faking those
 * risks deadlocking a request rather than timing it.
 */
async function atSecond<T>(second: bigint, request: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(second) * 1000);
  try {
    return await request();
  } finally {
    vi.useRealTimers();
  }
}

function harness(
  storeOptions: StoreOptions = {},
  chainOptions: {
    gasFee?: bigint;
    feeBps?: number;
    slaAllowed?: boolean;
    simulate?: () => Simulate;
    sendError?: () => unknown;
    callError?: () => unknown;
    receiptLogs?: () => unknown[];
    receiptMissing?: boolean;
    code?: Record<string, Hex>;
  } = {},
  nodeOptions: { partBytes?: number; maxBlobBytes?: number; jobRateLimit?: number } = {},
): Harness {
  let gasFee = chainOptions.gasFee ?? 0n;
  // The same addresses as the module-level `config`, with the pinning service
  // pointed at this file's stub store. A part size and a blob ceiling small
  // enough to cross in a test, when a case asks for them.
  const appConfig = testConfig({
    pinS3: store.config(nodeOptions.partBytes === undefined ? {} : { partBytes: nodeOptions.partBytes }),
    ...(nodeOptions.maxBlobBytes === undefined ? {} : { maxBlobBytes: nodeOptions.maxBlobBytes }),
    ...(nodeOptions.jobRateLimit === undefined ? {} : { jobRateLimit: nodeOptions.jobRateLimit }),
  });
  const stub = stubChain(appConfig, {
    // A getter, so the value can change between the quote and the relay — which
    // is the whole of the drift case, and a static record cannot express it.
    views: {
      get gasFee() {
        return gasFee;
      },
      feeBps: chainOptions.feeBps ?? 100,
      allowedSla: chainOptions.slaAllowed ?? true,
    },
    simulate: chainOptions.simulate,
    sendError: chainOptions.sendError,
    callError: chainOptions.callError,
    receiptLogs: chainOptions.receiptLogs,
    receiptMissing: chainOptions.receiptMissing,
    code: chainOptions.code,
  });
  const app = buildApp({
    db: stubDb(storeOptions),
    indexer: stubIndexer(),
    config: appConfig,
    chain: stub.chain,
  });
  open.push(app);
  return {
    app,
    stub,
    setGasFee: (value: bigint) => {
      gasFee = value;
    },
  };
}

const wire = (t: Terms, signature: Hex, jobId?: Hex, ownerAddress = owner.address) => ({
  job_id: jobId ?? jobIdFor(ownerAddress, t.c),
  c: t.c,
  model_id: Number(t.modelId),
  sla_secs: Number(t.slaSecs),
  rate_in: formatUsd(t.rateIn, 6),
  rate_out: formatUsd(t.rateOut, 6),
  units_in: Number(t.unitsIn),
  units_out: Number(t.unitsOut),
  designated: Number(t.designated),
  expires_at: Number(t.expiresAt),
  owner: ownerAddress,
  signature,
});

/**
 * A paid submission, as the wire carries it: one flat JSON body — the order
 * fields, the payment fields, and the container as base64. `null` for a payment
 * that forgot its bytes.
 */
const submission = (
  order: Record<string, unknown>,
  container: Buffer | null,
  payment: Record<string, unknown>,
): Record<string, unknown> => ({
  ...order,
  ...payment,
  ...(container === null ? {} : { container: b64(container) }),
});

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: "POST", url: "/v1/jobs", payload: payload as Record<string, unknown> });

const broadcastCall = (raw: string) => {
  const tx = parseTransaction(raw as Hex);
  return { to: tx.to, ...decodeFunctionData({ abi: jobRegistryAbi, data: tx.data as Hex }) };
};

// ---------------------------------------------------------------------------
// The 402 challenge
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — the 402 quote", () => {
  it("quotes cap, fee, gas_fee and amount, and the exact payment authorization", async () => {
    const { app, stub } = harness({}, { gasFee: 7n });
    const t = terms();
    const signature = await signOrder(t);
    const jobId = jobIdFor(owner.address, t.c);

    const response = await post(app, wire(t, signature));

    expect(response.statusCode).toBe(402);
    // cap = ceil((30000*1000 + 90000*2000)/1e6) = ceil(210) = 210
    // fee = 210 * 100 / 10000 = 2, on top of the cap; amount = 210 + 2 + 7
    expect(response.json()).toEqual({
      quote: {
        cap: "0.00021",
        fee_bps: 100,
        fee: "0.000002",
        gas_fee: "0.000007",
        amount: "0.000219",
        authorization: {
          domain: { name: "USDC", version: "2", chainId, verifyingContract: usdc },
          to: jobRegistry,
          value: 219,
          valid_after: 0,
          valid_before: Number(t.expiresAt + 1n),
          nonce: jobId,
        },
      },
      candidates: [],
      accepts: [{ scheme: "eip3009", network: `eip155:${chainId}` }],
    });
    expect(stub.broadcasts).toEqual([]);
  });

  it("floors the cap at one atomic unit for a zero-priced order", async () => {
    // `max(1, …)`, and it takes a genuinely zero-priced order to exercise it: a
    // sub-atomic order already ceilings to 1, so a dust fixture would pass with
    // the floor deleted (R67).
    const { app } = harness();
    const t = terms({ rateIn: 0n, rateOut: 0n, unitsIn: 0n, unitsOut: 0n });
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(402);
    expect(response.json().quote.cap).toBe("0.000001");
    expect(response.json().quote.amount).toBe("0.000001");
  });

  it("ceilings a sub-atomic order to one", async () => {
    const { app } = harness();
    const t = terms({ rateIn: 1n, rateOut: 0n, unitsIn: 1n, unitsOut: 0n });
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote.cap).toBe("0.000001");
  });

  it("rounds the cap up, never down", async () => {
    const { app } = harness();
    // 1 * 1_000_001 = 1_000_001 → ceil(1.000001) = 2
    const t = terms({ rateIn: 1_000_001n, rateOut: 0n, unitsIn: 1n, unitsOut: 0n });
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote.cap).toBe("0.000002");
  });

  it("reads gas_fee from the chain, never from a literal", async () => {
    const { app } = harness({}, { gasFee: 500n });
    const t = terms();
    const response = await post(app, wire(t, await signOrder(t)));

    // amount = 210 + the 1% fee on it + 500
    expect(response.json().quote).toMatchObject({ cap: "0.00021", gas_fee: "0.0005", amount: "0.000712" });
  });

  it("quotes the protocol fee on top of the cap", async () => {
    const { app } = harness({}, { gasFee: 5n, feeBps: 250 });
    const t = terms();
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote).toMatchObject({
      cap: "0.00021",
      fee_bps: 250,
      fee: "0.000005", // 210 * 250 / 10000, floored
      gas_fee: "0.000005",
      amount: "0.00022",
    });
  });

  /**
   * **The guard: a body that carried a container is never answered with a quote.**
   *
   * `402` is the one status a client is expected to loop on — it means "sign this
   * and send the same request again" — so answering one to a body that already
   * carried the payload costs the client the whole upload a second time, and a
   * client obeying the protocol correctly is what makes it happen.
   *
   * The mechanism is the route's `onSend` hook, not a condition beside the quote
   * branch, because the branch that sends today's `402` is not the one that will
   * send tomorrow's. **The fail-open mutation is deleting `onSend:
   * neverChallengeAfterBytes` from the route options**: the handler's own `402`
   * then escapes on a body that carried bytes, and this goes red (R67, R81).
   */
  it("never answers 402 to a body carrying a container — it names the real reason", async () => {
    const { app, stub } = harness();
    const t = terms();

    // The container inline and no `auth_sig`: the shape of a client that
    // built the whole submission and forgot the payment.
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, {}));

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(402);
    expect(response.json()).toEqual({
      error: {
        message: expect.stringContaining("complete submission") as unknown as string,
        type: "invalid_request_error",
        param: "auth_sig",
        code: "container_without_payment",
      },
    });
    // And nothing of the upload reached the store.
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
    // Not retryable, and that is the load-bearing half: `true` here would mean
    // "send the megabytes again", which is the instruction this guard exists to
    // withhold (R57, R70).
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("still answers 402 when the body carried no container", async () => {
    // The other side of the guard: it must refuse a challenge only when there
    // were bytes to refuse it over. A hook that rewrote every `402` would break
    // the protocol outright, and this is what would catch it.
    const { app } = harness();
    const t = terms();

    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(402);
    expect(response.json().accepts).toEqual([
      { scheme: "eip3009", network: `eip155:${chainId}` },
    ]);
  });

  it("reads only the candidate ranking from the store, and never the SLA, on the quote path", async () => {
    // A store that answers the ranking and its cursor bump and throws on every
    // other query, and an `allowedSla` the stub has no answer for: the quote
    // path is arithmetic, two cached config reads — `gasFee` and `feeBps` — and
    // one bounded ranking read, and this is what pins that bound (see the
    // report's bounds analysis).
    const stub = stubChain(config, { views: { gasFee: 0n, feeBps: 100 } });
    const app = buildApp({
      db: {
        query: (text: string) => {
          if (text.includes("FROM providers p")) return Promise.resolve({ rows: [] });
          return Promise.reject(new Error(`the quote path must not read the store: ${text}`));
        },
        tx: () => Promise.reject(new Error("no")),
        migrate: () => Promise.reject(new Error("no")),
        close: async () => undefined,
      } as unknown as Db,
      indexer: stubIndexer(),
      config,
      chain: stub.chain,
    });
    open.push(app);

    const t = terms();
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(402);
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Local validation — every one of these must relay nothing
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — validation", () => {
  const payment = async (t: Terms, amount: bigint) => ({
    auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), amount, t.expiresAt),
    amount: formatUsd(amount, 6),
  });

  /**
   * **The type string, proved in both directions.**
   *
   * The ABI cannot tell you this changed: `post` still takes the same struct and
   * its selector never moved, so regenerating it carries nothing. The EIP-712
   * type string is the whole difference, and a signature made over the old one
   * recovers a different address — which on chain is a silent `400` a client
   * cannot diagnose. Both halves matter: the old string must fail, and the new
   * one must verify.
   */
  it("refuses an order signed over the old type string, which still carried taskCid", async () => {
    const { app, stub } = harness();
    const t = terms();
    const body = submission(wire(t, await signLegacyOrder(t, MINTED_CID)), CONTAINER, await payment(t, amountFor()));

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_order_signature");
    expect(stub.broadcasts).toEqual([]);
  });

  it("accepts an order signed over the new type string", async () => {
    // The same terms and the same signer, over the string with no `taskCid`
    // member — which is what a client that regenerated nothing but its typed data
    // would send.
    const { app, stub } = harness();
    const t = terms();

    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(201);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("refuses an order signed by somebody other than the owner", async () => {
    const { app, stub } = harness();
    const t = terms();
    const body = submission(wire(t, await signOrder(t, stranger)), CONTAINER, await payment(t, amountFor()));

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_order_signature");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses a payment signature that does not recover to the owner", async () => {
    const { app, stub } = harness();
    const t = terms();
    const body = submission(wire(t, await signOrder(t)), CONTAINER, {
        auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), 210n, t.expiresAt, stranger),
        amount: "0.00021",
      });

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_payment_signature");
    expect(stub.broadcasts).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  it("refuses a payment signature made over a different amount", async () => {
    const { app, stub } = harness();
    const t = terms();
    // Signed over 209, echoed as 210: the recover fails at the echoed amount,
    // which is what makes an honest drift and a forged authorization distinguishable
    // (R7).
    const body = submission(wire(t, await signOrder(t)), CONTAINER, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), 209n, t.expiresAt),
      amount: "0.00021",
    });

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_payment_signature");
    expect(stub.broadcasts).toEqual([]);
  });

  it("requires the echoed amount", async () => {
    const { app } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, { auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), 210n, t.expiresAt) }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("amount");
  });

  it("refuses a job_id that is not keccak256(owner ‖ c)", async () => {
    const { app, stub } = harness();
    const t = terms();
    const body = submission(wire(t, await signOrder(t), `0x${"ff".repeat(32)}` as Hex), CONTAINER, await payment(t, amountFor()));

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("job_id");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses an expiry that has already passed", async () => {
    const { app } = harness();
    const t = terms({ expiresAt: BigInt(Math.floor(Date.now() / 1000)) - 1n });
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("expires_at");
  });

  it("refuses an expiry beyond MAX_EXPIRY", async () => {
    const { app } = harness();
    // **A minute past the bound, not a second past it.** This one reads the live
    // clock — the door reads it again when the request arrives — so a one-second
    // margin is a race with the request itself: on a loaded machine the signing
    // and the round trip take longer than that, the door's `now` has moved on,
    // and `now + 86_401` is inside the window after all. Observed going red
    // exactly once, during a run competing with a docker build.
    //
    // Nothing is lost by the wider margin: the bound itself is pinned to the
    // second by the two `atSecond` tests below, which stop the clock. This one's
    // job is only "well past the bound is refused".
    const t = terms({ expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 86_460n });
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("expires_at");
  });

  /**
   * The two edges of `(now, now+86400]`, probed **at** the edge (R78).
   *
   * The two tests above probe `now - 1` and `now + 86_401` — one *past* each
   * bound, which leaves the bound itself free to move by a second with nothing
   * going red. This is one of only two places the node **restates a frozen
   * contract's comparison**: `JobRegistry.sol:179-180` is `expiresAt <= block
   * .timestamp` and `expiresAt > block.timestamp + MAX_EXPIRY`, and 86 400 is
   * written out here from that source rather than imported from `src/orders.ts`,
   * so a wrong constant cannot agree with itself (R32, R64). An off-by-one on
   * the upper edge refuses an order the chain would accept; on the lower it
   * relays one the chain refuses and the node pays the gas.
   */
  it("admits an expiry exactly at now+86400, the contract's own upper bound", async () => {
    const { app, stub } = harness();
    const at = BigInt(Math.floor(Date.now() / 1000));
    const t = terms({ expiresAt: at + 86_400n });
    const body = wire(t, await signOrder(t));

    const response = await atSecond(at, () => post(app, body));

    // Quoted, not refused: the bound is inclusive at the top.
    expect(response.statusCode).toBe(402);
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses an expiry exactly at now, the contract's own lower bound", async () => {
    const { app, stub } = harness();
    const at = BigInt(Math.floor(Date.now() / 1000));
    const t = terms({ expiresAt: at });
    const body = wire(t, await signOrder(t));

    const response = await atSecond(at, () => post(app, body));

    // Exclusive at the bottom: an order expiring this very second is expired.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("expires_at");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses an unknown model", async () => {
    const { app, stub } = harness({ models: new Map() });
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("model_id");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses a model the catalog has disabled (R5)", async () => {
    const { app } = harness({ models: new Map([[1n, false]]) });
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("model_id");
  });

  it("refuses an SLA the chain does not allow", async () => {
    const { app, stub } = harness({}, { slaAllowed: false });
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("sla_secs");
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * **The payer's code, read before a byte is pinned or a wei of gas is fronted.**
   *
   * The payment token validates `receiveWithAuthorization` through
   * `SignatureChecker`, which routes an authorizer **with code** — an
   * EIP-7702-delegated wallet, a smart account — to ERC-1271 and never to
   * `ecrecover`. `recovers()` is viem's pure `verifyTypedData`, so such an
   * authorization passes every check this node makes and then fails inside the
   * token at `claim`. Without this read the node pins the container, fronts the
   * gas, posts, and the job rests Open to expiry with nothing naming the cause.
   *
   * The fail-open mutation is deleting the check: this becomes a `201` with a
   * broadcast and a pinned object.
   */
  it("refuses a payer that carries contract code, before pinning or relaying", async () => {
    const { app, stub } = harness({}, { code: { [owner.address.toLowerCase()]: "0x6080604052" } });
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payer_has_code");
    expect(response.json().error.param).toBe("owner");
    // The remedy is in the message, not only in the code.
    expect(response.json().error.message).toMatch(/undelegated EOA/);
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
    expect(stub.simulated).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });

  it("reads the payer's code at latest and posts when it is empty", async () => {
    const { app, stub } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(201);
    const reads = stub.requests.filter((r) => r.method === "eth_getCode");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).toEqual([owner.address, "latest"]);
  });

  it("refuses an SLA past MAX_SLA_SECONDS without asking the chain", async () => {
    // The bound that keeps `chainParams`'s per-`secs` memo from being grown, one
    // entry and one `eth_call` per request, by an unauthenticated caller.
    const { app, stub } = harness();
    const t = terms({ slaSecs: MAX_SLA_SECONDS + 1n });
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("sla_secs");
    expect(stub.requests.filter((r) => r.method === "eth_call")).toEqual([]);
  });

  /**
   * **The commitment check, proved by the two failures it exists for.**
   *
   * Neither is hypothetical and neither is caught by anything else on this door:
   * a length check and a version check both pass, the order signature is perfectly
   * valid, and the chain cannot look at a container at all. What a miss produces
   * is a job **every provider refuses to claim** — each re-derives
   * `keccak256(owner ‖ c) == jobId` from the bytes it fetched and gets a
   * different id — with the escrow already committed and the relayer's gas
   * already spent. Nothing downstream repairs that.
   *
   * The fail-open mutation is deleting the `assertCommitment` call: both of these
   * become `201`s with a broadcast.
   */
  it("refuses a container whose seed_wrap came from another order", async () => {
    // Identical ciphertext, another order's 80-byte wrap. This is the case that
    // makes hashing the wrap into `c` — rather than only the ciphertext — the
    // difference between a check and a formality.
    const { app, stub } = harness();
    const swapped = containerOf(0xd2, "a sealed prompt envelope");
    expect(swapped.subarray(MIN_CONTAINER_BYTES)).toEqual(CONTAINER.subarray(MIN_CONTAINER_BYTES)); // same ciphertext
    expect(commitmentOf(swapped)).not.toBe(C);

    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), swapped, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("container");
    expect(response.json().error.code).toBe("commitment_mismatch");
    expect(stub.broadcasts).toEqual([]);
    // Two keccaks over a buffer this process already holds: no chain call, and
    // nothing in the store.
    expect(stub.simulated).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(store.uploads.size).toBe(0);
  });

  it("refuses a container whose ciphertext was altered in flight", async () => {
    const { app, stub } = harness();
    const altered = Buffer.from(CONTAINER);
    altered[altered.length - 1] ^= 0x01;
    expect(commitmentOf(altered)).not.toBe(C);

    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), altered, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("commitment_mismatch");
    expect(stub.broadcasts).toEqual([]);
  });

  it("names the fault for a buffer that is not a container at all", async () => {
    // The two refusals ahead of the split. `Buffer.subarray` clamps rather than
    // throwing, so without the length check an 80-byte buffer would produce a
    // plausible-looking commitment over a slice of garbage.
    const { app } = harness();
    const t = terms();
    const body = async (container: Buffer) => (submission(wire(t, await signOrder(t)), container, await payment(t, amountFor())));

    const short = await post(app, await body(CONTAINER.subarray(0, MIN_CONTAINER_BYTES - 1)));
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe("too_short");

    const mislabelled = Buffer.from(CONTAINER);
    mislabelled[0] = 0x02; // a version this node does not speak
    const tagged = await post(app, await body(mislabelled));
    expect(tagged.statusCode).toBe(400);
    expect(tagged.json().error.code).toBe("bad_version");
  });

  it("refuses a payment with no container, rather than relaying a name it cannot mint", async () => {
    const { app, stub } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), null, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("container");
    expect(response.json().error.code).toBe("container_required");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses a signature that is not 65 bytes", async () => {
    const { app } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, `0x${"ab".repeat(64)}` as Hex), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("signature");
  });

  it("refuses an auth_sig that is not 65 bytes", async () => {
    const { app } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, { auth_sig: `0x${"ab".repeat(10)}`, amount: "0.00021" }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("auth_sig");
  });

  it("refuses a body past this door's own limit, well above the app-wide one", async () => {
    // `MAX_BODY_BYTES` is the **only** bound on the container:
    // no decoded cap stands behind it, because a cap applied after `JSON.parse`
    // has already spent the allocation it existed to prevent. `bodyLimit` acts
    // before the body is buffered, which is the property that matters, and this
    // door is unauthenticated.
    //
    // Deleting the per-route `bodyLimit` does not widen this door — it narrows it
    // to the app-wide 1 MiB, and the at-the-threshold container the next test
    // posts is refused. So the two tests are the bound in both directions.
    const { app, stub } = harness();
    const t = terms();
    const response = await post(app, {
      ...wire(t, await signOrder(t)),
      padding: "x".repeat(MAX_BODY_BYTES),
    });

    expect(response.statusCode).toBe(413);
    expect(stub.requests).toEqual([]);
  });

  it("takes a container at the inline threshold, the largest any client will send", async () => {
    // The other half of the bound, at the size the SDKs actually decide to
    // inline rather than near it. `INLINE_MAX_BYTES` is derived so that a
    // container at the threshold encodes to exactly the room the envelope
    // reserve leaves it, so this body lands a hair inside the ceiling by
    // construction — and if anyone trims the ceiling without re-deriving the
    // threshold, this is the test that goes red instead of production.
    const { app, stub } = harness();
    const big = containerOf(0xd7, "z".repeat(INLINE_MAX_BYTES - MIN_CONTAINER_BYTES));
    expect(big.length).toBe(INLINE_MAX_BYTES);
    const t = terms({ c: commitmentOf(big) });
    const body = submission(wire(t, await signOrder(t)), big, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), amountFor(), t.expiresAt),
      amount: formatUsd(amountFor(), 6),
    });
    const onTheWire = JSON.stringify(body).length;
    expect(onTheWire).toBeLessThan(MAX_BODY_BYTES);
    expect(onTheWire).toBeGreaterThan(MAX_BODY_BYTES - ENVELOPE_RESERVE_BYTES);

    const response = await post(app, body);

    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(response.json().task_cid).toBe(externallyMintedCid(big));
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("refuses a cap past 2^53 − 1, the largest amount the wire carries", async () => {
    const { app } = harness();
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const t = terms({ rateIn: max, rateOut: 0n, unitsIn: 4_294_967_295n, unitsOut: 0n });
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "cap_overflow", param: "rate_in" });
  });

  it.each([
    ["a JSON number", 30000],
    ["more fraction digits than the token has", "0.0000001"],
    ["an exponent", "3e-2"],
  ])("refuses a rate sent as %s", async (_, rate) => {
    const { app } = harness();
    const t = terms();
    const response = await post(app, { ...wire(t, await signOrder(t)), rate_in: rate });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ param: "rate_in" });
  });
});

// ---------------------------------------------------------------------------
// Duplicates, drift, and the relay
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — relay", () => {
  const signed = async (t: Terms, amount: bigint) => (submission(wire(t, await signOrder(t)), CONTAINER, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), amount, t.expiresAt),
      amount: formatUsd(amount, 6),
    }));

  it("relays post with the exact struct field order and answers 201", async () => {
    const { app, stub } = harness({}, { gasFee: 5n });
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const signature = await signOrder(t);
    const authSig = await signAuthorization(jobId, amountFor(5n), t.expiresAt);
    const body = submission(wire(t, signature), CONTAINER, {
      auth_sig: authSig,
      amount: formatUsd(amountFor(5n), 6),
    });

    const response = await post(app, body);

    expect(response.statusCode).toBe(201);
    // `task_cid` is on the success body and nowhere else it could be: this node
    // minted it, so a caller that is not told cannot learn the name of its own
    // object — it cannot compute one, and until the post is indexed there is
    // nothing to read it from. Deleting it from the body is the fail-open
    // mutation, and this is the assertion that goes red.
    expect(response.json()).toEqual({
      job_id: jobId,
      task_cid: MINTED_CID,
      tx_hash: stubTxHash(1),
    });
    // And it is the store's name, not one this node computed for itself.
    expect(MINTED_CID).not.toBe(cidForBytes(CONTAINER));
    expect(response.json().as_of_block).toBeUndefined();

    expect(stub.broadcasts).toHaveLength(1);
    const call = broadcastCall(stub.broadcasts[0] as string);
    expect(call.to?.toLowerCase()).toBe(jobRegistry.toLowerCase());
    expect(call.functionName).toBe("post");
    expect(call.args?.[0]).toEqual({
      c: t.c,
      modelId: Number(t.modelId),
      slaSecs: Number(t.slaSecs),
      rateIn: t.rateIn,
      rateOut: t.rateOut,
      unitsIn: Number(t.unitsIn),
      unitsOut: Number(t.unitsOut),
      designated: Number(t.designated),
      expiresAt: t.expiresAt,
      // A `post` **parameter** and no longer a signed member: the name did not
      // exist when the client signed, because this node had not minted it yet.
      taskCid: cidHex(MINTED_CID),
    });
    expect(call.args?.[1]).toBe(owner.address);
    expect(call.args?.[2]).toBe(signature);
    expect(call.args?.[3]).toBe(authSig);
  });

  it("simulates the exact transaction before spending any gas", async () => {
    const { app, stub } = harness();
    const t = terms();
    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(201);
    // Twice for an inline container: the preflight, which runs before the bytes
    // are filed and so cannot carry the name the store has yet to mint, and the
    // relay's own, over exactly the bytes that were broadcast.
    expect(stub.simulated).toHaveLength(2);
    const broadcast = parseTransaction(stub.broadcasts[0] as Hex);
    expect(stub.simulated[1]).toBe(broadcast.data);

    // The two differ in the `taskCid` and in nothing else — that is what makes
    // the preflight a verdict on this transaction rather than on another one.
    const preflight = decodeFunctionData({ abi: jobRegistryAbi, data: stub.simulated[0] as Hex });
    const relayed = decodeFunctionData({ abi: jobRegistryAbi, data: broadcast.data as Hex });
    const [preflightOrder, ...preflightRest] = (preflight.args ?? []) as readonly unknown[];
    const [relayedOrder, ...relayedRest] = (relayed.args ?? []) as readonly unknown[];
    expect(preflightRest).toEqual(relayedRest);
    const relayedTaskCid = (relayedOrder as { taskCid: Hex }).taskCid;
    expect({ ...(preflightOrder as object), taskCid: relayedTaskCid }).toEqual(relayedOrder);
    // Non-empty, which is all the contract reads of it, and not a name a store
    // would mint.
    expect((preflightOrder as { taskCid: Hex }).taskCid).toBe(cidHex("-"));
  });

  it("refuses a job_id the index already holds, and relays nothing", async () => {
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const { app, stub } = harness({ jobs: new Set([jobId]) });

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DuplicateJob");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  it("refuses a wallet past JOB_RATE_LIMIT at the challenge, before it signs a payment", async () => {
    const { app, stub } = harness({}, {}, { jobRateLimit: 1 });
    const t = terms();

    expect((await post(app, await signed(t, amountFor()))).statusCode).toBe(201);
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(429);
    expect(response.json().error.type).toBe("rate_limit_exceeded");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("does not count a refused post against JOB_RATE_LIMIT", async () => {
    const t = terms();
    const { app } = harness({ jobs: new Set([jobIdFor(owner.address, t.c)]) }, {}, { jobRateLimit: 1 });

    expect((await post(app, await signed(t, amountFor()))).statusCode).toBe(409);
    expect((await post(app, wire(t, await signOrder(t)))).statusCode).toBe(402);
  });

  it("maps an on-chain DuplicateJob to the same 409 as the index check", async () => {
    const { app, stub } = harness({}, { simulate: () => ({ kind: "revert", errorName: "DuplicateJob" }) });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DuplicateJob");
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * The row a reorg can still take away is not evidence the job exists, and
   * refusing on it would cost the client a fresh `c` — a fresh DEK, a fresh
   * container and a full re-upload — for a post that never survived. The chain
   * still gets to refuse: the simulate inside the queue runs before a byte is
   * pinned and reverts `DuplicateJob` whenever the job is really there.
   */
  it("relays over a write-through row the indexer has not confirmed yet", async () => {
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const { app, stub } = harness({ unconfirmedJobs: new Set([jobId]) });

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("answers the byte-identical 409 whichever side noticed the duplicate", async () => {
    // "The same 409" is a claim about the **whole** response, not about the
    // status: a client that branches on `param` would see two different answers
    // to one cause, and which one it got would depend on how far the index had
    // caught up. Same body, same retryability header, both ways.
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const body = await signed(t, amountFor());

    const fromIndex = await post(harness({ jobs: new Set([jobId]) }).app, body);
    const fromChain = await post(
      harness({}, { simulate: () => ({ kind: "revert", errorName: "DuplicateJob" }) }).app,
      body,
    );

    expect(fromIndex.statusCode).toBe(fromChain.statusCode);
    expect(fromIndex.json()).toEqual(fromChain.json());
    expect(fromIndex.headers["x-vorq-retryable"]).toBe(fromChain.headers["x-vorq-retryable"]);
    // And the shared body is the one the contract's own error name produces.
    expect(fromIndex.json()).toEqual({
      error: {
        message: "the chain refused this transaction: DuplicateJob",
        type: "invalid_request_error",
        param: "job_id",
        code: "DuplicateJob",
      },
    });
  });

  it("names the clearing candidates on the challenge and on the drifted-quote refusal, advancing the cursor", async () => {
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n },
      { provider_id: 6n, box_key: Buffer.alloc(32, 2), rate_in: 3n, rate_out: 4n },
    ];
    const bumps: unknown[][] = [];
    const { app, setGasFee } = harness({ candidates, bumps }, { gasFee: 5n });
    const t = terms();
    const onTheWire = [
      { provider_id: 5, box_key: `0x${"01".repeat(32)}`, rate_in: "0.000001", rate_out: "0.000002" },
      { provider_id: 6, box_key: `0x${"02".repeat(32)}`, rate_in: "0.000003", rate_out: "0.000004" },
    ];

    const challenge = await post(app, wire(t, await signOrder(t)));

    expect(challenge.statusCode).toBe(402);
    expect(challenge.json().candidates).toEqual(onTheWire);
    // The first candidate was named, so the next challenge names somebody else.
    expect(bumps).toEqual([["5", t.modelId.toString()]]);

    const body = await signed(t, amountFor(5n));
    setGasFee(9n);
    const drifted = await post(app, body);

    expect(drifted.statusCode).toBe(409);
    expect(drifted.json().candidates).toEqual(onTheWire);
  });

  it("never advances the cursor for a pinned order: a designated challenge has no rotation", async () => {
    // Otherwise anyone could sign `designated = X` challenges in a loop and
    // push provider X to the back of every equal-price ranking.
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n },
    ];
    const bumps: unknown[][] = [];
    const { app } = harness({ candidates, bumps });
    const t = terms({ designated: 5n });

    const challenge = await post(app, wire(t, await signOrder(t)));

    expect(challenge.statusCode).toBe(402);
    expect(challenge.json().candidates).toHaveLength(1);
    expect(bumps).toEqual([]);
  });

  it("answers a body with no rates with the market: unsigned, candidates only, cursor advanced", async () => {
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n },
    ];
    const bumps: unknown[][] = [];
    const { app } = harness({ candidates, bumps });

    const probe = await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20 });

    expect(probe.statusCode).toBe(402);
    expect(probe.json()).toEqual({
      candidates: [{ provider_id: 5, box_key: `0x${"01".repeat(32)}`, rate_in: "0.000001", rate_out: "0.000002" }],
    });
    expect(bumps).toEqual([["5", "3"]]);
  });

  it("never advances the cursor for a pinned market probe", async () => {
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n },
    ];
    const bumps: unknown[][] = [];
    const { app } = harness({ candidates, bumps });

    const probe = await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20, designated: 5 });

    expect(probe.statusCode).toBe(402);
    expect(bumps).toEqual([]);
  });

  it("refuses a market probe with an out-of-range member", async () => {
    const { app } = harness();
    const probe = await post(app, { model_id: 3, sla_secs: 86400, units_in: -1, units_out: 20 });
    expect(probe.statusCode).toBe(400);
    expect(probe.json().error.param).toBe("units_in");
  });

  describe("on a node with no chain", () => {
    const chainless = (storeOptions: StoreOptions = {}) => {
      const app = buildApp({ db: stubDb(storeOptions), indexer: stubIndexer(), config: testConfig() });
      open.push(app);
      return app;
    };

    it("still answers a probe: it reads the ask book, never the chain", async () => {
      const candidates: Candidate[] = [
        { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n },
      ];
      const probe = await post(chainless({ candidates }), {
        model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20,
      });
      expect(probe.statusCode).toBe(402);
    });

    it("answers a malformed order 503 before its shape, as the chain gate always has", async () => {
      const response = await post(chainless(), { rate_in: "0.000001", rate_out: "0.000001", job_id: "0x01" });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.type).toBe("chain_unreachable");
    });
  });

  it("refuses an expires_at sent as a string: every integer is a JSON integer", async () => {
    const { app } = harness();
    const t = terms();
    const body = { ...wire(t, await signOrder(t)), expires_at: String(t.expiresAt) };

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("expires_at");
  });

  it("answers 409 with a fresh quote when gasFee drifts, and relays nothing", async () => {
    const { app, stub, setGasFee } = harness({}, { gasFee: 5n });
    const t = terms();
    const body = await signed(t, amountFor(5n));

    // The quote the client signed said 5; the chain now says 9.
    setGasFee(9n);
    const response = await post(app, body);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      quote: {
        cap: "0.00021",
        fee_bps: 100,
        fee: "0.000002",
        gas_fee: "0.000009",
        // 210 + 2 + 9, the fresh gas fee
        amount: "0.000221",
        authorization: {
          domain: { name: "USDC", version: "2", chainId, verifyingContract: usdc },
          to: jobRegistry,
          value: 221,
          valid_after: 0,
          valid_before: Number(t.expiresAt + 1n),
          nonce: jobIdFor(owner.address, t.c),
        },
      },
      candidates: [],
      accepts: [{ scheme: "eip3009", network: `eip155:${chainId}` }],
    });
    expect(stub.broadcasts).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  it("answers 409 when the signed amount leaves the protocol fee out", async () => {
    const { app, stub } = harness({}, { gasFee: 5n, feeBps: 250 });
    const t = terms();
    const response = await post(app, await signed(t, 215n)); // cap + gas fee, no fee

    expect(response.statusCode).toBe(409);
    expect(response.json().quote).toMatchObject({ fee: "0.000005", amount: "0.00022" });
    expect(stub.broadcasts).toEqual([]);
  });

  it("does not answer 409 when the amount covers cap, fee and gas fee", async () => {
    const { app } = harness({}, { gasFee: 5n, feeBps: 250 });
    const t = terms();
    const response = await post(app, await signed(t, 220n));

    expect(response.statusCode).not.toBe(409);
  });

  it("busts the cache before the drift check, rather than trusting the TTL", async () => {
    const { app, stub, setGasFee } = harness({}, { gasFee: 5n });
    const t = terms();

    // The quote populates the cell; the TTL is 60 s, so without a bust the relay
    // would read 5 from memory and never see the drift.
    const quote = await post(app, wire(t, await signOrder(t)));
    expect(quote.json().quote.gas_fee).toBe("0.000005");

    setGasFee(9n);
    const response = await post(app, await signed(t, amountFor(5n)));

    expect(response.statusCode).toBe(409);
    expect(response.json().quote.gas_fee).toBe("0.000009");
    expect(stub.broadcasts).toEqual([]);
  });

  it("relays when the echoed amount still matches the current gasFee", async () => {
    const { app, stub, setGasFee } = harness({}, { gasFee: 5n });
    const t = terms();
    const body = await signed(t, amountFor(5n));
    setGasFee(5n);

    const response = await post(app, body);

    expect(response.statusCode).toBe(201);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("reports a refused broadcast as a retryable relay failure, not a verdict (R70)", async () => {
    const { app, stub } = harness(
      {},
      { sendError: () => refusedBroadcast("insufficient funds for gas * price + value") },
    );
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("relay_unavailable");
    expect(response.json().error.code).toBe("relayer_funds");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  it("reports a dead endpoint on the config reads as retryable, never as a 500 (R72)", async () => {
    // The payment path's first chain call is `allowedSla`, so this is the test
    // of the config-read wrapper: unwrapped, it answers `500 internal_error,
    // retryable=false` — a third answer to a cause this door already answers
    // correctly twice.
    const { app } = harness({}, { callError: () => unreachableEndpoint() });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("chain_unreachable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
  });

  it("reports an endpoint that refuses a config read as retryable, not as a verdict (R72)", async () => {
    const { app } = harness({}, { callError: () => refusedCall("txpool is full") });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("relay_unavailable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
  });

  it("reports a config read the endpoint answered with a revert as 503, never as a verdict (R77)", async () => {
    // A verdict by `isVerdict`'s own definition — code 3, "execution reverted" —
    // and that predicate answers "did the endpoint pronounce on **this
    // transaction**". A view read is not the caller's transaction, so the answer
    // may not be `400 invalid_request`: `allowedSla` reverts when the node's
    // `job_registry` address points at some other contract, or when the endpoint
    // reports unavailable historical state as a revert, and in both cases every
    // caller of a perfectly well-formed post would be told, non-retryably and
    // with no field named, that its own request is malformed.
    const { app, stub } = harness({}, { callError: () => refusedCall("execution reverted", 3, "0x") });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("relay_unavailable");
    // Discriminating, so an operator sees *which* read failed rather than a
    // generic relay outage.
    expect(response.json().error.code).toBe("config_read");
    expect(response.json().error.param).toBeNull();
    expect(response.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  it("reports a verdict at the broadcast as the same 409 as a verdict at the simulate", async () => {
    // One door must not hold two mappings for one cause: a revert that reaches
    // the send stage is still the chain pronouncing, and answering it `400`
    // there while the simulate two lines above answers `409` tells a client two
    // different things about the same refusal.
    const { app } = harness({}, { sendError: () => refusedBroadcast("execution reverted", 3) });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("unknown");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
  });

  it("serialises concurrent posts of one job_id, so the loser is refused for free", async () => {
    // The discriminator is the **broadcast**, not the call count: a simulate
    // that flipped on its own second invocation would answer `[201, 409]` with
    // the queue deleted, because the two simulates are ordered by the stub
    // whatever the node does. Keyed on `broadcasts.length`, the chain the second
    // post meets is the one the first *landed* — so with no queue both simulate
    // before either broadcasts, both pass, and the tuple goes `[201, 201]` with
    // two broadcasts (R65, R67).
    let harnessRef: StubChain | undefined;
    const { app, stub } = harness(
      {},
      {
        simulate: () =>
          (harnessRef as StubChain).broadcasts.length === 0
            ? { kind: "ok" }
            : { kind: "revert", errorName: "DuplicateJob" },
      },
    );
    harnessRef = stub;
    const t = terms();
    const body = await signed(t, amountFor());

    const [first, second] = await Promise.all([post(app, body), post(app, body)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    // One broadcast, not two: the loser never reached the send stage.
    expect(stub.broadcasts).toHaveLength(1);
    // And the stub really did have both requests in flight at once — without
    // this the ordering above could be the harness's doing (R65).
    expect(stub.maxInFlight).toBeGreaterThan(1);
  });

  it("refuses past the queue depth rather than inventing a verdict", async () => {
    const { app } = harness();
    const t = terms();
    const body = await signed(t, amountFor());

    const responses = await Promise.all(
      Array.from({ length: MAX_POST_QUEUE_DEPTH + 4 }, () => post(app, body)),
    );
    const busy = responses.filter((r) => r.statusCode === 429);

    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]?.json().error.type).toBe("busy");
    expect(busy[0]?.headers["x-vorq-retryable"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Write-through
// ---------------------------------------------------------------------------

/**
 * The job's row, written from the post's own receipt before the `201`.
 *
 * This is what lets `GET /v1/jobs/{id}` answer a client's first poll without
 * asking the chain: the indexer reaches the receipt's block a poll later, and
 * this door answers off the receipt.
 */
describe("POST /v1/jobs — write-through", () => {
  const paid = async (t: Terms) =>
    submission(wire(t, await signOrder(t)), CONTAINER, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), amountFor(), t.expiresAt),
      amount: formatUsd(amountFor(), 6),
    });

  /** The registry's `Posted` for `t`, as the receipt carries it. */
  const postedLog = (t: Terms, address: Address = jobRegistry) => {
    const args: Record<string, unknown> = {
      jobId: jobIdFor(owner.address, t.c),
      modelId: Number(t.modelId),
      designated: Number(t.designated),
      owner: owner.address,
      c: t.c,
      expiresAt: t.expiresAt,
      slaSecs: Number(t.slaSecs),
      rateIn: t.rateIn,
      rateOut: t.rateOut,
      unitsIn: Number(t.unitsIn),
      unitsOut: Number(t.unitsOut),
      gasFee: 0n,
      taskCid: cidHex(MINTED_CID),
    };
    // Off the vendored ABI, so the log is the one the contract really emits.
    const event = (jobRegistryAbi as Abi).find(
      (item): item is AbiEvent => item.type === "event" && item.name === "Posted",
    ) as AbiEvent;
    const topics = encodeEventTopics({ abi: jobRegistryAbi, eventName: "Posted", args });
    const body = event.inputs.filter((input) => !input.indexed);
    const data = encodeAbiParameters(body, body.map((input) => args[input.name as string]));
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
  };

  it("commits the job's row from the receipt before it answers 201", async () => {
    const written: unknown[][] = [];
    const t = terms();
    const { app } = harness({ written }, { receiptLogs: () => [postedLog(t)] });
    // **The ordering is the whole point**, so it is what the assertion reads: the
    // client's first poll lands milliseconds after this body goes out, and a hook
    // that ran after `send` — or was left un-awaited — would leave the row
    // uncommitted at exactly that moment. Counted at `onSend`, a write that
    // happens afterwards reads as zero here.
    let rowsAtSend = -1;
    app.addHook("onSend", async () => {
      rowsAtSend = written.length;
    });

    const response = await post(app, await paid(t));

    expect(response.statusCode).toBe(201);
    expect(rowsAtSend).toBe(1);
    // At the receipt's own block (the stub mines everything at 1000), which is
    // what the indexed log will say too.
    expect(written).toEqual([[jobIdFor(owner.address, t.c), 1000n]]);
  });

  it("writes nothing from a Posted another contract emitted", async () => {
    const written: unknown[][] = [];
    const t = terms();
    const { app } = harness(
      { written },
      { receiptLogs: () => [postedLog(t, "0x9999999999999999999999999999999999999999")] },
    );

    const response = await post(app, await paid(t));

    expect(response.statusCode).toBe(201);
    expect(written).toEqual([]);
  });

  it("still answers 201 when the write fails: the transaction mined either way", async () => {
    const t = terms();
    const { app } = harness(
      { writeError: new Error("database gone") },
      { receiptLogs: () => [postedLog(t)] },
    );

    const response = await post(app, await paid(t));

    expect(response.statusCode).toBe(201);
    expect(response.json().job_id).toBe(jobIdFor(owner.address, t.c));
  });

  /**
   * The one post that writes no row. Nothing repairs it here on purpose: the
   * transaction is on the wire, the caller is told not to re-send it, and the
   * indexer writes the row when it reaches that block like it always has.
   */
  it("writes nothing when the receipt never arrives, and answers the non-retryable 504", async () => {
    const written: unknown[][] = [];
    const t = terms();
    const { app, stub } = harness({ written }, { receiptMissing: true });
    const body = await paid(t);

    // Only the timers are faked, and the clock is stepped with a real `setImmediate`
    // between steps: the pin ahead of the relay is loopback I/O, so the receipt
    // wait's 60 s timer does not exist yet when the request starts.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let response;
    try {
      let settled = false;
      const inFlight = post(app, body).finally(() => {
        settled = true;
      });
      for (let step = 0; step < 200 && !settled; step++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      response = await inFlight;
    } finally {
      vi.useRealTimers();
    }

    expect(response.statusCode).toBe(504);
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(response.json().error.type).toBe("receipt_timeout");
    expect(stub.broadcasts).toHaveLength(1);
    expect(written).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The container: inline, and by name
// ---------------------------------------------------------------------------

/**
 * The two ways a body carries its container, and the property both share:
 * nothing is filed for an order any refusal ahead of the pin would have taken.
 */
describe("POST /v1/jobs — the container", () => {
  const SMALL_PART = 4 * 1024;
  /** Three parts' worth, so a multipart put has seams to get wrong. */
  const BIG = containerOf(0xd3, "x".repeat(3 * SMALL_PART));

  const paid = async (
    t: Terms,
    container: Buffer | null,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => ({
    ...submission(wire(t, await signOrder(t)), container, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), amountFor(), t.expiresAt),
      amount: formatUsd(amountFor(), 6),
    }),
    ...extra,
  });

  it("files a container past one part and relays the name the store minted", async () => {
    const { app, stub } = harness({}, {}, { partBytes: SMALL_PART });
    const t = terms({ c: commitmentOf(BIG) });

    const response = await post(app, await paid(t, BIG));

    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(response.json().task_cid).toBe(externallyMintedCid(BIG));
    // It went past the seam rather than landing in one put.
    expect(store.requests.filter((r) => r.url.includes("partNumber=")).length).toBeGreaterThan(1);
    expect([...store.objects.values()].some((object) => object.equals(BIG))).toBe(true);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("answers a store that refuses a part as the retryable 503 a failed completion gets", async () => {
    // A refusal mid-put is a store failure like any other and must not surface
    // as a `500` the client reads as "never retry".
    const { app, stub } = harness({}, {}, { partBytes: SMALL_PART });
    const t = terms({ c: commitmentOf(BIG) });
    store.failPartNumber = 2;
    try {
      const response = await post(app, await paid(t, BIG));

      expect(response.statusCode).toBe(503);
      expect(response.json().error.type).toBe("pinner_unavailable");
      expect(response.headers["x-vorq-retryable"]).toBe("true");
      // The preflight is ahead of the pin, so it ran; the relay's own never did,
      // and nothing was broadcast.
      expect(stub.simulated).toHaveLength(1);
      expect(stub.broadcasts).toEqual([]);
      expect(store.uploads.size).toBe(0);
    } finally {
      store.failPartNumber = null;
    }
  });

  it("files nothing for an order the chain refuses, and answers as the relay would", async () => {
    // The whole point of the preflight. Without it, any keypair that can sign an
    // order and an authorization but holds no funds makes this node store the megabytes
    // its body carried and hold them for the file retention — the refusal only
    // arrives at the relay, one put too late.
    //
    // Driven by posting the same refused order both ways: inline, where the pin
    // must not happen, and by cid, where the **attach** must not happen. The
    // upload-first path is the one the 300 s orphan window does not save: an
    // attach grants the full retention, so a refused order that reached it has
    // bought 30 days of storage for free. The two answers must also be the same
    // response.
    const refusing = { simulate: () => ({ kind: "revert" as const, errorName: "TransferFailed" }) };
    const t = terms({ c: commitmentOf(BIG) });

    const { app, stub } = harness({}, refusing);
    const inline = await post(app, await paid(t, BIG));

    expect(inline.statusCode).toBe(409);
    expect(inline.json().error.code).toBe("TransferFailed");
    expect(inline.headers["x-vorq-retryable"]).toBe("false");
    // Not one request reached the store, so not one object is held: this is the
    // assertion the preflight exists for.
    expect(store.requests).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(stub.broadcasts).toEqual([]);

    const attached: unknown[][] = [];
    const uploads = new Map([
      [
        UPLOAD_CID,
        {
          owner: Buffer.from(owner.address.slice(2), "hex"),
          purpose: "input",
          commitment: Buffer.from(t.c.slice(2), "hex"),
          createdAt: UPLOADED_AT,
          expiresAt: UPLOADED_AT + 300,
        },
      ],
    ]);
    const byCid = await post(
      harness({ uploads, attached }, refusing).app,
      await paid(t, null, { container_cid: UPLOAD_CID }),
    );

    expect(byCid.statusCode).toBe(inline.statusCode);
    expect(byCid.json()).toEqual(inline.json());
    expect(byCid.headers["x-vorq-retryable"]).toBe(inline.headers["x-vorq-retryable"]);
    // No attach ran, and the row is still on its orphan window: the refused
    // caller was granted no retention at all.
    expect(attached).toEqual([]);
    expect(uploads.get(UPLOAD_CID)?.expiresAt).toBe(UPLOADED_AT + 300);
  });

  it("refuses a bad authorization before a byte of the container is filed", async () => {
    const { app, stub } = harness();
    const t = terms();
    const body = submission(wire(t, await signOrder(t)), BIG, {
      auth_sig: await signAuthorization(jobIdFor(owner.address, t.c), 210n, t.expiresAt, stranger),
      amount: "0.00021",
    });

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_payment_signature");
    // Not one request reached the store: the bytes were never filed.
    expect(store.requests).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  it("refuses a body that names both a container and a container_cid", async () => {
    // Two containers do not say which one `c` commits to, and picking either
    // would be this node deciding which bytes the client meant to pay for.
    const { app, stub } = harness();
    const t = terms();

    const response = await post(app, await paid(t, CONTAINER, { container_cid: UPLOAD_CID }));

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("container_ambiguous");
    expect(store.requests).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  /**
   * `container_cid` — the door for a payload too large to inline.
   *
   * The cid **is** the `task_cid`: the bytes are already in the store, so this
   * path files nothing and reads no object back. What stands in for hashing them
   * is `files.commitment`, which `POST /v1/files` computed while they streamed
   * past it, and the upload is moved off its 300 s orphan window in the same
   * breath as the relay.
   */
  describe("by cid", () => {
    const uploaded = (upload: Partial<Upload> = {}): Map<string, Upload> =>
      new Map([
        [
          UPLOAD_CID,
          {
            owner: Buffer.from(owner.address.slice(2), "hex"),
            purpose: "input",
            commitment: Buffer.from(C.slice(2), "hex"),
            createdAt: UPLOADED_AT,
            expiresAt: UPLOADED_AT + 300,
            ...upload,
          },
        ],
      ]);

    const byCid = async (cid = UPLOAD_CID): Promise<Record<string, unknown>> => {
      const t = terms();
      return paid(t, null, { container_cid: cid });
    };

    it("relays the uploaded cid as task_cid, attaches the file, and files nothing", async () => {
      const attached: unknown[][] = [];
      const uploads = uploaded();
      const { app, stub } = harness({ uploads, attached });

      const response = await post(app, await byCid());

      expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
      expect(response.json().task_cid).toBe(UPLOAD_CID);
      // The name on chain is the upload's, not one minted for a second copy.
      const call = broadcastCall(stub.broadcasts[0] as string);
      expect((call.args?.[0] as { taskCid: Hex }).taskCid).toBe(cidHex(UPLOAD_CID));
      // Nothing was written to the store: no second copy of bytes the client
      // already paid to upload.
      expect(store.requests).toEqual([]);
      expect(store.objects.size).toBe(0);
      // And the file's expiry was moved off the 300 s orphan window, scoped to
      // the order's own owner, at the configured retention.
      expect(attached).toEqual([
        [
          UPLOAD_CID,
          Buffer.from(owner.address.slice(2), "hex"),
          "input",
          config.fileRetentionSeconds,
        ],
      ]);
      expect(uploads.get(UPLOAD_CID)?.expiresAt).toBe(UPLOADED_AT + config.fileRetentionSeconds);
    });

    it("refuses a cid nobody uploaded, a stranger's upload and the wrong purpose alike", async () => {
      // One answer for all three: a distinguishable "that file is someone
      // else's" would turn this door into an oracle for which cids exist.
      const cases: [string, Map<string, Upload>][] = [
        ["no such cid", new Map()],
        ["a stranger's upload", uploaded({ owner: Buffer.from(stranger.address.slice(2), "hex") })],
        ["the wrong purpose", uploaded({ purpose: "result" })],
      ];
      for (const [, uploads] of cases) {
        const { app, stub } = harness({ uploads });
        const response = await post(app, await byCid());

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          param: "container_cid",
          code: "unknown_container",
        });
        expect(stub.broadcasts).toEqual([]);
        expect(stub.simulated).toEqual([]);
      }
    });

    it("refuses an upload whose commitment is not the one this order signed", async () => {
      const other = commitmentOf(containerOf(0xd4, "somebody else's prompt"));
      const { app, stub } = harness({
        uploads: uploaded({ commitment: Buffer.from(other.slice(2), "hex") }),
      });

      const response = await post(app, await byCid());

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        param: "container",
        code: "commitment_mismatch",
      });
      expect(stub.broadcasts).toEqual([]);
    });

    it("relays nothing when the sweep deletes the upload between the lookup and the attach", async () => {
      // `attachFile` answers `false` when it updated no row, which is the 300 s
      // window closing on a file the door is in the middle of referencing. The
      // fail-open mutation is ignoring that answer: the node then relays a job
      // whose `task_cid` names an object it has just deleted.
      const { app, stub } = harness({ uploads: uploaded(), swept: new Set([UPLOAD_CID]) });

      const response = await post(app, await byCid());

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("unknown_container");
      expect(stub.broadcasts).toEqual([]);
      // The preflight is ahead of the attach on this path too, so it ran; the
      // relay's own simulate never did.
      expect(stub.simulated).toHaveLength(1);
    });

    it("refuses a container_cid longer than a name this node could have minted", async () => {
      const { app } = harness({ uploads: uploaded() });
      const response = await post(app, await byCid("b".repeat(MAX_CID_CHARS + 1)));

      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe("container_cid");
    });

    it("never answers 402 to a body naming a container_cid", async () => {
      // The guard is about content, not about bytes on the wire: a cid is a
      // complete submission just as inline bytes are, and re-quoting it would
      // send the client back to upload again.
      const { app } = harness({ uploads: uploaded() });
      const t = terms();

      const response = await post(app, {
        ...wire(t, await signOrder(t)),
        container_cid: UPLOAD_CID,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("container_without_payment");
    });
  });
});

describe("POST /v1/jobs/{id}/cancel", () => {
  const cancel = (app: FastifyInstance, jobId: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      payload: payload as Record<string, unknown>,
    });

  const now = () => BigInt(Math.floor(Date.now() / 1000));

  it("relays cancel and answers 200 with the same shape as post (R16)", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job_id: jobId, tx_hash: stubTxHash(1) });

    const call = broadcastCall(stub.broadcasts[0] as string);
    expect(call.functionName).toBe("cancel");
    expect(call.args?.[0]).toBe(jobId);
    expect(call.args?.[1]).toBe(issuedAt);
  });

  it("refuses an issued_at outside the ±600 s job-op window (R24, R33)", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now() - 601n;

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("StaleOp");
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * The ±600 s window, probed **at** both edges (R78).
   *
   * The test above probes `now - 601`, one past the edge. The window is
   * inclusive on both sides — `JobRegistry.sol:553` refuses only
   * `issuedAt + 600 < now` and `issuedAt > now + 600` — and this is the second
   * place the node restates the contract's own comparison, so an off-by-one here
   * refuses a cancel the chain would have accepted. 600 is written out from that
   * source rather than imported.
   */
  it("admits an issued_at exactly at the lower ±600 s edge", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);
    const at = now();
    const issuedAt = at - 600n;
    const body = { issued_at: Number(issuedAt), signature: await signCancel(jobId, issuedAt) };

    const response = await atSecond(at, () => cancel(app, jobId, body));

    expect(response.statusCode).toBe(200);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("admits an issued_at exactly at the upper ±600 s edge", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);
    const at = now();
    const issuedAt = at + 600n;
    const body = { issued_at: Number(issuedAt), signature: await signCancel(jobId, issuedAt) };

    const response = await atSecond(at, () => cancel(app, jobId, body));

    expect(response.statusCode).toBe(200);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("refuses a malformed signature without spending an eth_call", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);

    const response = await cancel(app, jobId, {
      issued_at: Number(now()),
      signature: `0x${"ab".repeat(10)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("signature");
    expect(stub.requests.filter((r) => r.method === "eth_call")).toEqual([]);
  });

  it("hands the chain's own refusal back as a 409", async () => {
    const { app, stub } = harness({}, { simulate: () => ({ kind: "revert", errorName: "NotOpen" }) });
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NotOpen");
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * The cancel door makes **no view call at all** — parse, staleness, simulate,
   * relay — so `callError` here refuses precisely the simulate. That is what
   * makes these two the tests of the *classification* (R72) rather than of the
   * config reads: with `isVerdict` deleted from `chainFailure` both answer
   * `409 {code:"unknown"}`, telling a client the chain refused its cancel when
   * nothing on the chain ever saw it.
   */
  it("reports a dead endpoint at the simulate as retryable, never as a verdict (R72)", async () => {
    const { app, stub } = harness({}, { callError: () => unreachableEndpoint() });
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("chain_unreachable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  it("reports an endpoint that refuses the simulate as retryable, not as a verdict (R72)", async () => {
    const { app } = harness({}, { callError: () => refusedCall("txpool is full") });
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("relay_unavailable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
  });

  it("keeps a bare revert on the 409 path — a verdict is the endpoint answering, not raw bytes", async () => {
    // `revert()` with no reason: code 3, data `0x`. Classifying on the absence
    // of decodable data would turn every bare `require(false)` into a retryable
    // 503 a client would retry forever (R72).
    const { app, stub } = harness({}, { simulate: () => ({ kind: "opaque", data: "0x" }) });
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("unknown");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses a malformed job_id in the path", async () => {
    const { app } = harness();
    const response = await cancel(app, "0xnothex", {
      issued_at: Number(now()),
      signature: `0x${"ab".repeat(65)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("id");
  });

  /**
   * The per-route `bodyLimit`, asserted rather than assumed — the sibling of the
   * bound `POST /v1/jobs` carries, on the door that shares its constant.
   *
   * `MAX_ORDER_ENVELOPE_BYTES` is 8 KiB: a JSON body on these doors is flat
   * fields and never carries bytes, so the bound is generous for what this door
   * legitimately takes; what it is actually doing is keeping the door from
   * inheriting the app-wide 1 MiB. Deleting `{ bodyLimit: MAX_ORDER_ENVELOPE_BYTES }`
   * at `src/api/routes/post.ts` widens it to that 1 MiB and the padded body
   * below is **accepted** — the unknown field is ignored and the cancel relays
   * 200. The `toBeLessThan` states that fail-open direction as an assertion:
   * this payload is one the app-wide limit would take, so a green 413 can only
   * be the per-route option still being there.
   */
  it("refuses a body past this door's own limit, not the app-wide one", async () => {
    const { app, stub } = harness();
    const jobId = jobIdFor(owner.address, C);
    const issuedAt = now();
    const body = {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    };

    // 64 kB of padding over the 8 kB envelope allowance, so this clears
    // `MAX_ORDER_ENVELOPE_BYTES` without the test needing the private constant.
    const padded = JSON.stringify({
      ...body,
      padding: "x".repeat(64 * 1024),
    });
    // Well inside the app-wide 1 MiB: only the per-route limit can refuse this.
    expect(padded.length).toBeLessThan(1024 * 1024);

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      headers: { "content-type": "application/json" },
      payload: padded,
    });

    expect(response.statusCode).toBe(413);
    // The frozen envelope, not a bare Fastify 413 and not a 500: a caller told
    // "internal error" for its own oversized body would retry it.
    expect(response.json().error.type).toBe("invalid_request_error");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    // Refused before the body was read, so nothing was simulated or relayed.
    expect(stub.broadcasts).toEqual([]);

    // The control, on the same node: the identical body without the padding is
    // relayed. The refusal above is the size and nothing else.
    const unpadded = await cancel(app, jobId, body);
    expect(unpadded.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// R6 — the payment token's domain is asserted, never quoted
// ---------------------------------------------------------------------------

describe("assertDomains", () => {
  const EIP712_DOMAIN_4 = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ] as const;

  const separatorOf = (name: string, version: string, verifyingContract: Address): Hex =>
    hashDomain({
      domain: { name, version, chainId: BigInt(chainId), verifyingContract },
      types: { EIP712Domain: EIP712_DOMAIN_4 },
    });

  const registrySeparator = (name: string, verifyingContract: Address): Hex =>
    separatorOf(name, "2", verifyingContract);

  /** The separators an honest deployment of each configured address would report. */
  const honest = (): Record<string, Hex> => ({
    [usdc.toLowerCase()]: separatorOf("USDC", "2", usdc),
    [config.addresses.jobRegistry.toLowerCase()]: registrySeparator(
      EIP712_NAMES.job,
      config.addresses.jobRegistry,
    ),
    [config.addresses.providerRegistry.toLowerCase()]: registrySeparator(
      EIP712_NAMES.provider,
      config.addresses.providerRegistry,
    ),
    [config.addresses.askRegistry.toLowerCase()]: registrySeparator(
      EIP712_NAMES.ask,
      config.addresses.askRegistry,
    ),
  });

  /** A chain that answers `DOMAIN_SEPARATOR()` per address, as a real one would. */
  const chainAnswering = (byAddress: Record<string, Hex>): PublicClient =>
    createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }: { method: string; params?: any }) => {
            if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
            if (method === "eth_call") {
              const to = String(params[0].to).toLowerCase();
              const separator = byAddress[to];
              if (!separator) throw new Error(`no contract stubbed at ${to}`);
              return encodeAbiParameters([{ type: "bytes32" }], [separator]);
            }
            throw new Error(`unexpected ${method}`);
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;

  it("accepts a deployment whose four separators match the locally computed domains", async () => {
    await expect(
      assertDomains(chainAnswering(honest()), config.addresses),
    ).resolves.toBeUndefined();
  });

  it("refuses to start when the deployed payment token disagrees", async () => {
    await expect(
      assertDomains(
        chainAnswering({ ...honest(), [usdc.toLowerCase()]: separatorOf("NotUSDC", "2", usdc) }),
        config.addresses,
      ),
    ).rejects.toThrow(/payment token/);
  });

  it.each([
    ["job registry", "jobRegistry"],
    ["provider registry", "providerRegistry"],
    ["ask registry", "askRegistry"],
  ] as const)("refuses to start when the deployed %s disagrees", async (label, field) => {
    const address = config.addresses[field] as Address;
    await expect(
      assertDomains(
        chainAnswering({ ...honest(), [address.toLowerCase()]: registrySeparator("Wrong", address) }),
        config.addresses,
      ),
    ).rejects.toThrow(new RegExp(label));
  });

  it("catches two address slots resolving to the same contract", async () => {
    // The failure distinct domain names exist to close. Point the ask-registry
    // slot at the job registry: the contract there answers with the JOB domain,
    // which is no longer what an ask signature is verified under. Under the old
    // shared `"VORQ"` name this configuration was indistinguishable from a
    // correct one, and every ask push would have been silently refused.
    const collapsed = { ...config.addresses, askRegistry: config.addresses.jobRegistry };
    await expect(assertDomains(chainAnswering(honest()), collapsed)).rejects.toThrow(
      /ask registry/,
    );
  });
});
