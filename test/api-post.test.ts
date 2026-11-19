import type { FastifyInstance } from "fastify";
import { formatUsd } from "../src/money.js";
import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  hashDomain,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { MAX_CID_CHARS } from "../src/pin/pinner.js";
import { externallyMintedCid, startStubStore, type StubStore } from "./support/stub-store.js";
import { EIP712_NAMES } from "../src/orders.js";
import {
  refusedCall,
  stubChain,
  testConfig,
  unreachableEndpoint,
  type StubChain,
} from "./support/stub-chain.js";

/**
 * `POST /v1/jobs` and `POST /v1/jobs/{id}/cancel` — the client's write doors.
 *
 * Driven against a canned endpoint and a canned store, so every assertion is
 * about **what the node would have done**. Neither door relays anything: a
 * complete submission is held as a `jobs` row until a provider's claim puts it
 * on chain, and a cancel ends that row. "Nothing was relayed" is proved by the
 * absence of an `eth_sendRawTransaction` in the recorded request log, and
 * "nothing was held" by the store's own record of inserts.
 *
 * The EIP-712 domains and type strings below are written out **literally**, from
 * `JobRegistry.sol`, rather than imported from `src/orders.ts`. Importing them
 * would make a wrong member order agree with itself and pass (R32, R64).
 *
 * No database and no chain: this file runs in every `npm test`.
 */

const config = testConfig();
const { chainId, jobRegistry, usdc } = config.addresses;

/** A session of the owner's, for the balance doors. */
const SESSION = "vorq_sess_0123456789abcdef0123456789abcdef";

/** The harness's deposit fee, 0.002 USD — what a short balance's deposit adds on top. */
const DEPOSIT_FEE = 2_000n;

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
 * `210 * 100 / 10000 = 2`, floored, so the lock is `210 + 2 + gasFee`. The
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
 * and the ABI cannot tell you either, because the `Order` struct `claim` takes
 * still carries the member. The type string is the whole difference, and the
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
  /**
   * Job ids this node already holds a row for. A held insert adds its own id, so
   * a second post of the same order finds the first one's row.
   */
  jobs?: Set<string>;
  /** What the candidate ranking answers on the challenge. */
  candidates?: Candidate[];
  /** The parameters of every candidate ranking the door ran. */
  ranked?: unknown[][];
  /** Every round-robin cursor bump the challenge issued: `[provider_id, model_id]`. */
  bumps?: unknown[][];
  /** Uploads a `container_cid` may name, by cid. */
  uploads?: Map<string, Upload>;
  /** Every `attachFile` the door ran: `[cid, owner, purpose, retentionSeconds]`. */
  attached?: unknown[][];
  /** Cids the sweep deletes between the lookup and the attach — `attachFile` then answers false. */
  swept?: Set<string>;
  /** Every held row the door wrote: the `INSERT INTO jobs` parameters. */
  held?: unknown[][];
  /** The text of every held insert, so the `posted_block` source can be read off it. */
  heldText?: string[];
  /** Makes the held insert find a row already there. */
  heldConflict?: boolean;
  /** How long the held insert takes, so two concurrent holds overlap. */
  heldDelayMs?: number;
  /** The row the cancel door locks for its `job_id`; absent is no row at all. */
  cancelRow?: { owner: Buffer; state?: number; held?: boolean };
  /** The row has a live lease: a provider may be claiming it. */
  heldLeased?: boolean;
  /** Every row the cancel door ended: `[job_id]`. */
  heldCancelled?: unknown[][];
  /** Every lease the cancel door gave back: `[job_id]`. */
  leasesDropped?: unknown[][];
  /** The owner's open, unexpired orders the funds check sums: `jobs` rows' price columns. */
  openJobs?: { rate_in: string; rate_out: string; units_in: string; units_out: string; gas_fee: string }[];
}

/**
 * The reads the post door makes — the catalog row, the duplicate check, the
 * owner's open orders and the `files` row behind a `container_cid` — plus the
 * held insert, the write the pin makes into the `pins` name book and the
 * `expires_at` bump that attaches an upload. A stub rather than a schema, so a
 * read this door is not supposed to make is a hard failure instead of an empty
 * result set.
 */
function stubDb(options: StoreOptions = {}): Db {
  const models = options.models ?? new Map([[1n, true]]);
  const jobs = options.jobs ?? new Set<string>();
  const uploads = options.uploads ?? new Map<string, Upload>();

  // The open orders every held insert adds, as the funds check's sum reads them.
  const heldOpen: { rate_in: string; rate_out: string; units_in: string; units_out: string; gas_fee: string }[] = [];

  const query = (async (text: string, params?: readonly unknown[]) => {
    // The challenge's one store read (the candidate ranking) and its one bounded
    // write (the round-robin cursor). Checked first: the ranking's LATERAL
    // subquery reads `jobs` too, and must not be mistaken for the duplicate
    // check below.
    if (text.includes("FROM providers p")) {
      options.ranked?.push([...(params ?? [])]);
      return { rows: options.candidates ?? [] };
    }
    if (text.includes("INSERT INTO jobs")) {
      if (options.heldDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.heldDelayMs));
      }
      const id = `0x${(params?.[0] as Buffer).toString("hex")}`;
      if (options.heldConflict === true || jobs.has(id)) return { rows: [], rowCount: 0 };
      jobs.add(id);
      heldOpen.push({
        rate_in: params?.[6] as string,
        rate_out: params?.[7] as string,
        units_in: params?.[8] as string,
        units_out: params?.[9] as string,
        gas_fee: params?.[12] as string,
      });
      options.held?.push([...(params ?? [])]);
      options.heldText?.push(text);
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("UPDATE provider_presence")) {
      options.bumps?.push([...(params ?? [])]);
      return { rows: [] };
    }
    if (text.includes("FROM models")) {
      const enabled = models.get(BigInt(params?.[0] as bigint | number));
      return { rows: enabled === undefined ? [] : [{ enabled }] };
    }
    // The funds check's sum over the owner's open orders, ahead of the duplicate
    // check, which reads `jobs` by id.
    if (text.includes("FROM jobs") && text.includes("state = 0")) {
      return { rows: [...(options.openJobs ?? []), ...heldOpen] };
    }
    // The bearer the balance doors' session gate reads, for the owner.
    if (text.includes("FROM sessions")) {
      return {
        rows:
          params?.[0] === SESSION
            ? [
                {
                  token: SESSION,
                  address: Buffer.from(owner.address.slice(2), "hex"),
                  role: "client",
                  provider_id: null,
                  expires_at: 4_102_444_800n,
                },
              ]
            : [],
      };
    }
    if (text.includes("FROM jobs")) {
      const id = `0x${(params?.[0] as Buffer).toString("hex")}`;
      return { rows: jobs.has(id) ? [{ "?column?": 1 }] : [] };
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
    // first and the door must refuse rather than hold.
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

  // The cancel door's one transaction: the locked row, its lease, and the write.
  const tx: Db["tx"] = async (fn) =>
    fn({
      query: (async (text: string, params?: readonly unknown[]) => {
        if (text.includes("FROM jobs") && text.includes("FOR UPDATE")) {
          const row = options.cancelRow;
          return {
            rows:
              row === undefined
                ? []
                : [{ owner: row.owner, state: row.state ?? 0, held: row.held ?? true }],
          };
        }
        if (text.includes("SELECT 1 FROM job_leases")) {
          return { rows: options.heldLeased === true ? [{}] : [] };
        }
        if (text.includes("UPDATE jobs SET state = 3")) {
          options.heldCancelled?.push([...(params ?? [])]);
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("DELETE FROM job_leases")) {
          options.leasesDropped?.push([...(params ?? [])]);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`stubDb: unexpected tx query ${text}`);
      }) as unknown as Db["query"],
    });

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
 * A real loopback HTTP server rather than a fake pinner: the pin is on the
 * request path of every `202` this file asserts, so a door driven without one
 * would be driven without the step that mints the name `claim` puts on chain.
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
    depositFee?: bigint;
    slaAllowed?: boolean;
    callError?: () => unknown;
    /** Called per broadcast, as the stub chain's own `sendError`. */
    sendError?: () => unknown;
    tokenBalance?: Record<string, bigint>;
    /** Job ids the chain has a row for: `getJob` answers `found` for these. */
    onChain?: Set<string>;
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
  const onChain = chainOptions.onChain ?? new Set<string>();
  const stub = stubChain(appConfig, {
    // A getter, so the value can change between the quote and the submission —
    // which is the whole of the drift case, and a static record cannot express it.
    views: {
      get gasFee() {
        return gasFee;
      },
      feeBps: chainOptions.feeBps ?? 100,
      depositFee: chainOptions.depositFee ?? DEPOSIT_FEE,
      allowedSla: chainOptions.slaAllowed ?? true,
      getJob: ([jobId]: readonly unknown[]) => ({
        found: onChain.has(String(jobId).toLowerCase()),
        jobId: jobId as Hex,
        state: onChain.has(String(jobId).toLowerCase()) ? 1 : 0,
        endedBecause: 0,
        providerId: 0,
        claimedAt: 0n,
      }),
    },
    callError: chainOptions.callError,
    sendError: chainOptions.sendError,
    tokenBalance: chainOptions.tokenBalance,
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
 * A complete submission, as the wire carries it: one flat JSON body — the order
 * fields, the echoed `amount`, and the container as base64. `null` for a
 * submission that forgot its bytes.
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

/** `{amount}` for a complete submission, in USD. */
const amountField = (amount: bigint) => ({ amount: formatUsd(amount, 6) });

const post = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: "POST", url: "/v1/jobs", payload: payload as Record<string, unknown> });

/** The `eth_call`s a request made. */
const ethCalls = (stub: StubChain) => stub.requests.filter((r) => r.method === "eth_call");

// ---------------------------------------------------------------------------
// The 402 challenge
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — the 402 quote", () => {
  it("quotes cap, fee, gas_fee, amount, the available balance and the deposit to make", async () => {
    const { app, stub } = harness({}, { gasFee: 7n });
    const t = terms();
    const signature = await signOrder(t);

    const response = await post(app, wire(t, signature));

    expect(response.statusCode).toBe(402);
    // cap = ceil((30000*1000 + 90000*2000)/1e6) = ceil(210) = 210
    // fee = 210 * 100 / 10000 = 2, on top of the cap; amount = 210 + 2 + 7
    // The stub's owner holds $1000, so the balance covers it and nothing is to
    // be deposited.
    expect(response.json()).toEqual({
      quote: {
        cap: "0.00021",
        fee_bps: 100,
        fee: "0.000002",
        gas_fee: "0.000007",
        amount: "0.000219",
        balance: "1000",
        deposit: "0",
        deposit_fee: "0.002",
      },
      candidates: [],
      accepts: [{ scheme: "eip3009", network: `eip155:${chainId}` }],
    });
    expect(response.json().quote.authorization).toBeUndefined();
    expect(stub.broadcasts).toEqual([]);
  });

  it("quotes the shortfall plus the deposit fee when the balance does not cover the order", async () => {
    // 100 held, an open order locking 50 of it: 50 available against a lock of
    // 212, so 162 short — and the deposit names 162 + the 2000 fee the registry
    // takes from the deposit itself, so it credits exactly the shortfall.
    const openJobs = [{ rate_in: "0", rate_out: "1000000", units_in: "0", units_out: "50", gas_fee: "0" }];
    const { app } = harness({ openJobs }, { tokenBalance: { [owner.address.toLowerCase()]: 100n } });
    const t = terms();

    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(402);
    expect(response.json().quote).toMatchObject({
      amount: "0.000212",
      balance: "0.00005",
      deposit: "0.002162",
      deposit_fee: "0.002",
    });
  });

  it("quotes a zero balance, never a negative one, for an owner whose open orders exceed it", async () => {
    const openJobs = [{ rate_in: "0", rate_out: "1000000", units_in: "0", units_out: "500", gas_fee: "0" }];
    const { app } = harness({ openJobs }, { tokenBalance: { [owner.address.toLowerCase()]: 100n } });
    const t = terms();

    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote).toMatchObject({ balance: "0", deposit: "0.002212" });
  });

  it("quotes no deposit when the balance covers the order exactly", async () => {
    const { app } = harness({}, { tokenBalance: { [owner.address.toLowerCase()]: 212n } });
    const t = terms();

    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote).toMatchObject({ amount: "0.000212", balance: "0.000212", deposit: "0" });
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

  it("reads deposit_fee from the chain, never from a literal", async () => {
    const { app } = harness({}, { depositFee: 7_000n, tokenBalance: { [owner.address.toLowerCase()]: 0n } });
    const t = terms();
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.json().quote).toMatchObject({ deposit_fee: "0.007", deposit: "0.007212" });
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
   * `402` is the one status a client is expected to loop on — it means "cover
   * this and send the same request again" — so answering one to a body that
   * already carried the payload costs the client the whole upload a second time,
   * and a client obeying the protocol correctly is what makes it happen.
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

    // The container inline and no `amount`: the shape of a client that built
    // the whole submission and forgot the amount it accepted.
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, {}));

    expect(response.statusCode).toBe(400);
    expect(response.statusCode).not.toBe(402);
    expect(response.json()).toEqual({
      error: {
        message: expect.stringContaining("complete submission") as unknown as string,
        type: "invalid_request_error",
        param: "amount",
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

  it("reads only the ranking and the owner's open orders from the store, and never the SLA, on the quote path", async () => {
    // A store that answers the ranking, its cursor bump and the open-orders sum
    // and throws on every other query, and an `allowedSla` the stub has no answer
    // for: the quote path is arithmetic, three cached config reads — `gasFee`,
    // `feeBps` and `depositFee` — the owner's balance, and two bounded store
    // reads, and this is what pins that bound.
    const stub = stubChain(config, { views: { gasFee: 0n, feeBps: 100, depositFee: DEPOSIT_FEE } });
    const app = buildApp({
      db: {
        query: (text: string) => {
          if (text.includes("FROM providers p")) return Promise.resolve({ rows: [] });
          if (text.includes("FROM jobs") && text.includes("state = 0")) return Promise.resolve({ rows: [] });
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
    expect(ethCalls(stub)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — validation", () => {
  const payment = async (_t: Terms, amount: bigint) => amountField(amount);

  /**
   * **The type string, proved in both directions.**
   *
   * The ABI cannot tell you this changed: the `Order` struct `claim` takes still
   * carries `taskCid`, so regenerating it carries nothing. The EIP-712
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

    expect(response.statusCode).toBe(202);
    expect(stub.broadcasts).toEqual([]);
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
   * contract's comparison**: `JobRegistry` refuses `block.timestamp > expiresAt`
   * and `expiresAt > block.timestamp + MAX_EXPIRY`, and 86 400 is
   * written out here from that source rather than imported from `src/orders.ts`,
   * so a wrong constant cannot agree with itself (R32, R64). An off-by-one on
   * the upper edge refuses an order the chain would accept; on the lower it
   * holds one no claim can land.
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
   * **A balance that cannot cover the order is a re-quote, and nothing is filed.**
   * The claim locks the order's amount out of the prepaid balance, so without this
   * an empty balance would have its order held, and resting until it expired with
   * no claim able to land.
   */
  it("answers a short balance with the 409 re-quote, holding and filing nothing", async () => {
    const holder = owner.address.toLowerCase();
    const held: unknown[][] = [];
    // One open order locking 110 + 1 + 0, so 322 leaves 211 for an order of 212.
    const openJobs = [{ rate_in: "0", rate_out: "1000000", units_in: "0", units_out: "110", gas_fee: "0" }];
    const { app, stub } = harness({ openJobs, held }, { tokenBalance: { [holder]: 322n } });
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(409);
    expect(response.json().quote).toMatchObject({
      amount: "0.000212",
      balance: "0.000211",
      // 1 short, plus the deposit fee the registry takes from the deposit.
      deposit: "0.002001",
      deposit_fee: "0.002",
    });
    expect(response.json().error).toBeUndefined();
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(held).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
    expect(store.objects.size).toBe(0);

    // Exactly enough is held.
    const funded = harness({ openJobs }, { tokenBalance: { [holder]: 323n } });
    const ok = await post(funded.app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));
    expect(ok.statusCode).toBe(202);
  });

  it("never reads the payer's code: an order moves no tokens, the deposit door does", async () => {
    const { app, stub } = harness();
    const t = terms();
    const response = await post(app, submission(wire(t, await signOrder(t)), CONTAINER, await payment(t, amountFor())));

    expect(response.statusCode).toBe(202);
    expect(stub.requests.filter((r) => r.method === "eth_getCode")).toEqual([]);
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
   * is an order **every provider refuses to claim** — each re-derives
   * `keccak256(owner ‖ c) == jobId` from the bytes it fetched and gets a
   * different id. Nothing downstream repairs that.
   *
   * The fail-open mutation is deleting the `assertCommitment` call: both of these
   * become `202`s with a held row.
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
    // Two keccaks over a buffer this process already holds: nothing in the store.
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

  it("refuses an amount with no container, rather than holding an order with no name", async () => {
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
    const body = submission(wire(t, await signOrder(t)), big, amountField(amountFor()));
    const onTheWire = JSON.stringify(body).length;
    expect(onTheWire).toBeLessThan(MAX_BODY_BYTES);
    expect(onTheWire).toBeGreaterThan(MAX_BODY_BYTES - ENVELOPE_RESERVE_BYTES);

    const response = await post(app, body);

    expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
    expect(response.json().task_cid).toBe(externallyMintedCid(big));
    expect(stub.broadcasts).toEqual([]);
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
// Duplicates, drift, and the hold
// ---------------------------------------------------------------------------

describe("POST /v1/jobs — the hold", () => {
  const signed = async (t: Terms, amount: bigint) =>
    submission(wire(t, await signOrder(t)), CONTAINER, amountField(amount));

  it("holds the order: 202, a row carrying its signature and quoted gas fee, nothing relayed", async () => {
    const held: unknown[][] = [];
    const heldText: string[] = [];
    const { app, stub } = harness({ held, heldText }, { gasFee: 5n });
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const body = await signed(t, amountFor(5n));

    const response = await post(app, body);

    expect(response.statusCode).toBe(202);
    // `task_cid` is on the success body and nowhere else it could be: this node
    // minted it, so a caller that is not told cannot learn the name of its own
    // object. Deleting it from the body is the fail-open mutation, and this is
    // the assertion that goes red.
    expect(response.json()).toEqual({ job_id: jobId, task_cid: MINTED_CID });
    expect(response.json().as_of_block).toBeUndefined();
    // No transaction of any kind: the order goes on chain inside the claim.
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);

    expect(held).toHaveLength(1);
    const row = held[0] as unknown[];
    const hexOf = (value: unknown) => `0x${(value as Buffer).toString("hex")}`;
    expect(hexOf(row[0])).toBe(jobId);
    expect(hexOf(row[1])).toBe(owner.address.toLowerCase());
    expect(hexOf(row[2])).toBe(t.c);
    expect(row.slice(3, 11)).toEqual(
      [t.modelId, t.slaSecs, t.designated, t.rateIn, t.rateOut, t.unitsIn, t.unitsOut, t.expiresAt].map(String),
    );
    expect((row[11] as Buffer).toString("utf8")).toBe(MINTED_CID);
    // The gas fee the order was quoted at, which the claim is checked against.
    expect(row[12]).toBe("5");
    // The order signature `claim` will carry — and nothing else signed.
    expect(hexOf(row[13])).toBe(body.signature);
    expect(row).toHaveLength(14);
    // `posted_block` and `as_of_block` are the index cursor at acceptance.
    expect(heldText[0]).toMatch(/at\.block, at\.block/);
    expect(heldText[0]).toMatch(/SELECT block_number FROM cursor WHERE id = 1/);
  });

  it("refuses a job_id this node already holds, and files nothing", async () => {
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const { app, stub } = harness({ jobs: new Set([jobId]) });

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DuplicateJob");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
    // Refused before a byte was filed.
    expect(store.requests).toEqual([]);
  });

  it("refuses a second post of a held job_id as the duplicate it is", async () => {
    const { app, stub } = harness({ heldConflict: true });
    const t = terms();

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DuplicateJob");
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * **One owner's funds decisions run one at a time** (`underOwnerFunds`). Two
   * orders a balance covers only one of, submitted together, would otherwise
   * both read the same `available` and both be held — and one of them could
   * never be claimed.
   */
  it("holds one of two orders submitted together when the balance covers one", async () => {
    const held: unknown[][] = [];
    const { app } = harness(
      { held, heldDelayMs: 100 },
      { tokenBalance: { [owner.address.toLowerCase()]: amountFor() } },
    );
    const other = containerOf(0xd2, "another sealed prompt envelope");
    const first = terms();
    const second = terms({ c: commitmentOf(other) });

    const answers = await Promise.all([
      post(app, await signed(first, amountFor())),
      post(app, submission(wire(second, await signOrder(second)), other, amountField(amountFor()))),
    ]);

    expect(answers.map((res) => res.statusCode).sort()).toEqual([202, 409]);
    expect(answers.find((res) => res.statusCode === 409)?.json().quote).toMatchObject({ balance: "0" });
    expect(held).toHaveLength(1);
  });

  it("lets a withdrawal racing a post leave the balance covering every held order", async () => {
    // The balance covers the order or the withdrawal, not both. The relayed
    // withdrawal moves the balance on its broadcast, as the chain would.
    const holder = owner.address.toLowerCase();
    const balances = { [holder]: amountFor() };
    const held: unknown[][] = [];
    const { app } = harness(
      { held },
      {
        tokenBalance: balances,
        sendError: () => {
          balances[holder] -= amountFor();
          return undefined;
        },
      },
    );
    const t = terms();

    const [posted, withdrawn] = await Promise.all([
      post(app, await signed(t, amountFor())),
      app.inject({
        method: "POST",
        url: "/v1/withdrawals",
        headers: { authorization: `Bearer ${SESSION}` },
        payload: {
          owner: owner.address,
          amount: formatUsd(amountFor(), 6),
          issued_at: Math.floor(Date.now() / 1000),
          signature: `0x${"ab".repeat(65)}`,
        },
      }),
    ]);

    // Exactly one of the two drew on the balance, and the other was refused.
    expect([posted.statusCode === 202, withdrawn.statusCode === 200].filter(Boolean)).toHaveLength(1);
    if (posted.statusCode === 202) {
      expect(withdrawn.json().error.code).toBe("insufficient_balance");
    } else {
      expect(posted.json().quote).toMatchObject({ balance: "0" });
      expect(held).toEqual([]);
    }
  });

  it("refuses a wallet past JOB_RATE_LIMIT at the challenge, before it deposits", async () => {
    const { app } = harness({}, {}, { jobRateLimit: 1 });
    const t = terms();

    expect((await post(app, await signed(t, amountFor()))).statusCode).toBe(202);
    const response = await post(app, wire(t, await signOrder(t)));

    expect(response.statusCode).toBe(429);
    expect(response.json().error.type).toBe("rate_limit_exceeded");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
  });

  it("does not count a refused post against JOB_RATE_LIMIT", async () => {
    const t = terms();
    const { app } = harness({ jobs: new Set([jobIdFor(owner.address, t.c)]) }, {}, { jobRateLimit: 1 });

    expect((await post(app, await signed(t, amountFor()))).statusCode).toBe(409);
    expect((await post(app, wire(t, await signOrder(t)))).statusCode).toBe(402);
  });

  /**
   * An id the chain has a row for is spent even when this node holds none — an
   * owner's own on-chain `cancel`, or a claim relayed by another coordinator.
   * `getJob` is the second half of the duplicate check, after the row.
   */
  it("refuses a job_id the chain already has, though this node holds no row for it", async () => {
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const held: unknown[][] = [];
    const { app, stub } = harness({ held }, { onChain: new Set([jobId]) });

    const response = await post(app, await signed(t, amountFor()));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DuplicateJob");
    expect(held).toEqual([]);
    expect(store.requests).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("asks the chain only once the row has said nothing", async () => {
    // The row is free and it is where every order this node accepted lives; a
    // hit there must not spend a `getJob`, whose calldata is the only chain call
    // that carries the job id.
    const t = terms();
    const jobId = jobIdFor(owner.address, t.c);
    const { app, stub } = harness({ jobs: new Set([jobId]) });

    expect((await post(app, await signed(t, amountFor()))).statusCode).toBe(409);
    expect(stub.requests.some((r) => JSON.stringify(r.params).includes(jobId.slice(2)))).toBe(false);
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
    const fromChain = await post(harness({}, { onChain: new Set([jobId]) }).app, body);

    expect(fromIndex.statusCode).toBe(fromChain.statusCode);
    expect(fromIndex.json()).toEqual(fromChain.json());
    expect(fromIndex.headers["x-vorq-retryable"]).toBe(fromChain.headers["x-vorq-retryable"]);
    expect(fromIndex.json()).toEqual({
      error: {
        message: "this job_id is already taken: sign a new order with a fresh c",
        type: "invalid_request_error",
        param: "job_id",
        code: "DuplicateJob",
      },
    });
  });

  it("names the clearing candidates on the challenge and on the drifted-quote refusal, advancing the cursor", async () => {
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n, rate_in_cached: 1n },
      { provider_id: 6n, box_key: Buffer.alloc(32, 2), rate_in: 3n, rate_out: 4n, rate_in_cached: 2n },
    ];
    const bumps: unknown[][] = [];
    const { app, setGasFee } = harness({ candidates, bumps }, { gasFee: 5n });
    const t = terms();
    const onTheWire = [
      {
        provider_id: 5,
        box_key: `0x${"01".repeat(32)}`,
        rate_in: "0.000001",
        rate_out: "0.000002",
        rate_in_cached: "0.000001",
      },
      {
        provider_id: 6,
        box_key: `0x${"02".repeat(32)}`,
        rate_in: "0.000003",
        rate_out: "0.000004",
        rate_in_cached: "0.000002",
      },
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
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n, rate_in_cached: 1n },
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
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n, rate_in_cached: 1n },
    ];
    const bumps: unknown[][] = [];
    const { app } = harness({ candidates, bumps });

    const probe = await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20 });

    expect(probe.statusCode).toBe(402);
    expect(probe.json()).toEqual({
      candidates: [
        {
          provider_id: 5,
          box_key: `0x${"01".repeat(32)}`,
          rate_in: "0.000001",
          rate_out: "0.000002",
          rate_in_cached: "0.000001",
        },
      ],
    });
    expect(bumps).toEqual([["5", "3"]]);
  });

  it("never advances the cursor for a pinned market probe", async () => {
    const candidates: Candidate[] = [
      { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n, rate_in_cached: 1n },
    ];
    const bumps: unknown[][] = [];
    const { app } = harness({ candidates, bumps });

    const probe = await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20, designated: 5 });

    expect(probe.statusCode).toBe(402);
    expect(bumps).toEqual([]);
  });

  it("ranks a probe within the ceilings it names, and none where it names none", async () => {
    const ranked: unknown[][] = [];
    const { app } = harness({ ranked });

    await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20, max_rate_in: "0.05" });
    await post(app, { model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20 });

    // $8 is the output ceiling, $9 the input one.
    expect(ranked.map((params) => [params[7], params[8]])).toEqual([
      [null, "50000"],
      [null, null],
    ]);
  });

  it("refuses a probe ceiling finer than the token's decimals", async () => {
    const { app } = harness();
    const probe = await post(app, {
      model_id: 3, sla_secs: 86400, units_in: 10, units_out: 20, max_rate_out: "0.0000001",
    });
    expect(probe.statusCode).toBe(400);
    expect(probe.json().error.param).toBe("max_rate_out");
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
        { provider_id: 5n, box_key: Buffer.alloc(32, 1), rate_in: 1n, rate_out: 2n, rate_in_cached: 1n },
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

  it("answers 409 with a fresh quote when gasFee drifts, and holds nothing", async () => {
    const { app, stub, setGasFee } = harness({}, { gasFee: 5n });
    const t = terms();
    const body = await signed(t, amountFor(5n));

    // The quote the client accepted said 5; the chain now says 9.
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
        balance: "1000",
        deposit: "0",
        deposit_fee: "0.002",
      },
      candidates: [],
      accepts: [{ scheme: "eip3009", network: `eip155:${chainId}` }],
    });
    expect(stub.broadcasts).toEqual([]);
    expect(store.requests).toEqual([]);
  });

  it("answers 409 when the amount leaves the protocol fee out", async () => {
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

    // The quote populates the cell; the TTL is 60 s, so without a bust the submission
    // would read 5 from memory and never see the drift.
    const quote = await post(app, wire(t, await signOrder(t)));
    expect(quote.json().quote.gas_fee).toBe("0.000005");

    setGasFee(9n);
    const response = await post(app, await signed(t, amountFor(5n)));

    expect(response.statusCode).toBe(409);
    expect(response.json().quote.gas_fee).toBe("0.000009");
    expect(stub.broadcasts).toEqual([]);
  });

  it("holds when the echoed amount still matches the current gasFee", async () => {
    const { app, stub, setGasFee } = harness({}, { gasFee: 5n });
    const t = terms();
    const body = await signed(t, amountFor(5n));
    setGasFee(5n);

    const response = await post(app, body);

    expect(response.statusCode).toBe(202);
    expect(stub.broadcasts).toEqual([]);
  });

  it("reports a dead endpoint on the config reads as retryable, never as a 500 (R72)", async () => {
    // The submission's first chain call is `allowedSla`, so this is the test
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
    // caller of a perfectly well-formed submission would be told, non-retryably and
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

  it("serialises concurrent posts of one job_id, so the loser files nothing", async () => {
    // The discriminator is the **store**, not the status pair: without the queue
    // both posts pass the duplicate check before either is held, both file the
    // container, and the held insert's own conflict refuses the second only after
    // its bytes were stored. Behind the queue the second finds the first's row
    // and is refused before it files anything — so the pair costs exactly the
    // store requests one post costs (R65, R67).
    const t = terms();
    const body = await signed(t, amountFor());

    const alone = harness();
    expect((await post(alone.app, body)).statusCode).toBe(202);
    const onePost = store.requests.length;
    store.requests.length = 0;
    store.objects.clear();

    const held: unknown[][] = [];
    const { app, stub } = harness({ held });
    const [first, second] = await Promise.all([post(app, body), post(app, body)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    expect([first, second].find((r) => r.statusCode === 409)?.json().error.code).toBe("DuplicateJob");
    expect(held).toHaveLength(1);
    expect(store.requests).toHaveLength(onePost);
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
    ...submission(wire(t, await signOrder(t)), container, amountField(amountFor())),
    ...extra,
  });

  it("files a container past one part and holds the name the store minted", async () => {
    const held: unknown[][] = [];
    const { app, stub } = harness({ held }, {}, { partBytes: SMALL_PART });
    const t = terms({ c: commitmentOf(BIG) });

    const response = await post(app, await paid(t, BIG));

    expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
    expect(response.json().task_cid).toBe(externallyMintedCid(BIG));
    // It went past the seam rather than landing in one put.
    expect(store.requests.filter((r) => r.url.includes("partNumber=")).length).toBeGreaterThan(1);
    expect([...store.objects.values()].some((object) => object.equals(BIG))).toBe(true);
    expect(((held[0] as unknown[])[11] as Buffer).toString("utf8")).toBe(externallyMintedCid(BIG));
    expect(stub.broadcasts).toEqual([]);
  });

  it("answers a store that refuses a part as the retryable 503 a failed completion gets", async () => {
    // A refusal mid-put is a store failure like any other and must not surface
    // as a `500` the client reads as "never retry".
    const held: unknown[][] = [];
    const { app } = harness({ held }, {}, { partBytes: SMALL_PART });
    const t = terms({ c: commitmentOf(BIG) });
    store.failPartNumber = 2;
    try {
      const response = await post(app, await paid(t, BIG));

      expect(response.statusCode).toBe(503);
      expect(response.json().error.type).toBe("pinner_unavailable");
      expect(response.headers["x-vorq-retryable"]).toBe("true");
      // A failed pin holds nothing.
      expect(held).toEqual([]);
      expect(store.uploads.size).toBe(0);
    } finally {
      store.failPartNumber = null;
    }
  });

  it("files nothing for an order the balance cannot cover, inline or by cid", async () => {
    // Without the balance check ahead of the bytes, any keypair that can sign an
    // order but holds no balance makes this node store the megabytes its body
    // carried and hold them for the file retention.
    //
    // Driven by posting the same short order both ways: inline, where the pin
    // must not happen, and by cid, where the **attach** must not happen. The
    // upload-first path is the one the 300 s orphan window does not save: an
    // attach grants the full retention, so a refused order that reached it has
    // bought 30 days of storage for free. The two answers must also be the same
    // response.
    const short = { tokenBalance: { [owner.address.toLowerCase()]: 0n } };
    const t = terms({ c: commitmentOf(BIG) });

    const { app, stub } = harness({}, short);
    const inline = await post(app, await paid(t, BIG));

    expect(inline.statusCode).toBe(409);
    expect(inline.json().quote.deposit).toBe("0.002212");
    expect(inline.headers["x-vorq-retryable"]).toBe("false");
    // Not one request reached the store, so not one object is held.
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
      harness({ uploads, attached }, short).app,
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

  it("refuses a bad order signature before a byte of the container is filed", async () => {
    const { app } = harness();
    const t = terms({ c: commitmentOf(BIG) });
    const body = submission(wire(t, await signOrder(t, stranger)), BIG, amountField(amountFor()));

    const response = await post(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_order_signature");
    // Not one request reached the store: the bytes were never filed.
    expect(store.requests).toEqual([]);
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
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * `container_cid` — the door for a payload too large to inline.
   *
   * The cid **is** the `task_cid`: the bytes are already in the store, so this
   * path files nothing and reads no object back. What stands in for hashing them
   * is `files.commitment`, which `POST /v1/files` computed while they streamed
   * past it, and the upload is moved off its 300 s orphan window in the same
   * breath as the hold.
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

    it("holds the uploaded cid as task_cid, attaches the file, and files nothing", async () => {
      const attached: unknown[][] = [];
      const held: unknown[][] = [];
      const uploads = uploaded();
      const { app, stub } = harness({ uploads, attached, held });

      const response = await post(app, await byCid());

      expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
      expect(response.json().task_cid).toBe(UPLOAD_CID);
      // The name `claim` will put on chain is the upload's, not one minted for a
      // second copy.
      expect(((held[0] as unknown[])[11] as Buffer).toString("utf8")).toBe(UPLOAD_CID);
      expect(stub.broadcasts).toEqual([]);
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

    it("holds nothing when the sweep deletes the upload between the lookup and the attach", async () => {
      // `attachFile` answers `false` when it updated no row, which is the 300 s
      // window closing on a file the door is in the middle of referencing. The
      // fail-open mutation is ignoring that answer: the node then holds an order
      // whose `task_cid` names an object it has just deleted.
      const held: unknown[][] = [];
      const { app } = harness({ uploads: uploaded(), swept: new Set([UPLOAD_CID]), held });

      const response = await post(app, await byCid());

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("unknown_container");
      expect(held).toEqual([]);
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
  const jobId = jobIdFor(owner.address, C);
  const mine = { owner: Buffer.from(owner.address.slice(2), "hex") };
  const signedNow = async () => {
    const issuedAt = now();
    return { issued_at: Number(issuedAt), signature: await signCancel(jobId, issuedAt) };
  };

  it("ends an open order in its row and answers 200 with the post's job_id (R16), relaying nothing", async () => {
    const heldCancelled: unknown[][] = [];
    const leasesDropped: unknown[][] = [];
    const { app, stub } = harness({ cancelRow: mine, heldCancelled, leasesDropped });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job_id: jobId });
    expect(heldCancelled).toHaveLength(1);
    expect(`0x${((heldCancelled[0] as unknown[])[0] as Buffer).toString("hex")}`).toBe(jobId);
    expect(leasesDropped).toHaveLength(1);
    // One view read — `getJob`, under the row's lock — and no transaction.
    expect(ethCalls(stub)).toHaveLength(1);
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("answers 404 for an id this node holds no order under", async () => {
    const { app, stub } = harness();

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(404);
    expect(response.json().error.type).toBe("not_found");
    expect(stub.broadcasts).toEqual([]);
  });

  it("refuses to cancel an order for anyone but its owner", async () => {
    const heldCancelled: unknown[][] = [];
    const { app, stub } = harness({
      cancelRow: { owner: Buffer.from(stranger.address.slice(2), "hex") },
      heldCancelled,
    });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NotTheOwner");
    expect(response.json().error.param).toBe("signature");
    expect(heldCancelled).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it.each([
    ["claimed", { state: 1, held: true }],
    ["already cancelled", { state: 3, held: true }],
    ["indexed from the chain", { state: 1, held: false }],
  ])("refuses an order that is %s as NotOpen", async (_, row) => {
    const heldCancelled: unknown[][] = [];
    const { app } = harness({ cancelRow: { ...mine, ...row }, heldCancelled });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NotOpen");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
    expect(heldCancelled).toEqual([]);
  });

  it("refuses a leased order: its claim may be in flight, and the row is not ended under it", async () => {
    const heldCancelled: unknown[][] = [];
    const { app, stub } = harness({ cancelRow: mine, heldLeased: true, heldCancelled });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("order_leased");
    expect(heldCancelled).toEqual([]);
    // Decided on the lease alone: the chain was not asked.
    expect(ethCalls(stub)).toEqual([]);
  });

  it("refuses an order the chain already has: a claim landed past its lease", async () => {
    // The row still reads open — the indexer has not reached the claim — and no
    // lease is live, but `getJob` has the row. Ending ours under it would tell
    // the client a claimed job was cancelled.
    const heldCancelled: unknown[][] = [];
    const { app } = harness({ cancelRow: mine, heldCancelled }, { onChain: new Set([jobId]) });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NotOpen");
    expect(heldCancelled).toEqual([]);
  });

  it("refuses an issued_at outside the ±600 s job-op window (R24, R33)", async () => {
    const heldCancelled: unknown[][] = [];
    const { app, stub } = harness({ cancelRow: mine, heldCancelled });
    const issuedAt = now() - 601n;

    const response = await cancel(app, jobId, {
      issued_at: Number(issuedAt),
      signature: await signCancel(jobId, issuedAt),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("StaleOp");
    expect(heldCancelled).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  /**
   * The ±600 s window, probed **at** both edges (R78).
   *
   * The test above probes `now - 601`, one past the edge. The window is
   * inclusive on both sides — the contract's `_freshJobOp` refuses only
   * `issuedAt + 600 < now` and `issuedAt > now + 600` — and the node restates
   * that comparison, so an off-by-one here refuses a cancel the owner signed
   * inside it. 600 is written out from that source rather than imported.
   */
  it("admits an issued_at exactly at the lower ±600 s edge", async () => {
    const { app } = harness({ cancelRow: mine });
    const at = now();
    const issuedAt = at - 600n;
    const body = { issued_at: Number(issuedAt), signature: await signCancel(jobId, issuedAt) };

    const response = await atSecond(at, () => cancel(app, jobId, body));

    expect(response.statusCode).toBe(200);
  });

  it("admits an issued_at exactly at the upper ±600 s edge", async () => {
    const { app } = harness({ cancelRow: mine });
    const at = now();
    const issuedAt = at + 600n;
    const body = { issued_at: Number(issuedAt), signature: await signCancel(jobId, issuedAt) };

    const response = await atSecond(at, () => cancel(app, jobId, body));

    expect(response.statusCode).toBe(200);
  });

  it("refuses a malformed signature without spending an eth_call", async () => {
    const { app, stub } = harness({ cancelRow: mine });

    const response = await cancel(app, jobId, {
      issued_at: Number(now()),
      signature: `0x${"ab".repeat(10)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("signature");
    expect(ethCalls(stub)).toEqual([]);
  });

  /**
   * `getJob` is a view read (R77): whatever the endpoint does with it, the
   * answer is the node's failure and retryable, never a verdict on the cancel —
   * and the row is not ended on a read that did not complete.
   */
  it("reports a dead endpoint at the getJob read as retryable, and ends nothing (R72)", async () => {
    const heldCancelled: unknown[][] = [];
    const { app } = harness({ cancelRow: mine, heldCancelled }, { callError: () => unreachableEndpoint() });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("chain_unreachable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
    expect(heldCancelled).toEqual([]);
  });

  it("reports an endpoint that refuses the getJob read as retryable, not as a verdict (R72)", async () => {
    const { app } = harness({ cancelRow: mine }, { callError: () => refusedCall("txpool is full") });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(503);
    expect(response.json().error.type).toBe("relay_unavailable");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
  });

  it("reports a getJob the endpoint answered with a revert as 503, never as a verdict (R77)", async () => {
    const { app } = harness({ cancelRow: mine }, { callError: () => refusedCall("execution reverted", 3, "0x") });

    const response = await cancel(app, jobId, await signedNow());

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("job_read");
    expect(response.headers["x-vorq-retryable"]).toBe("true");
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
   * `MAX_ORDER_ENVELOPE_BYTES` is 8 KiB: a JSON body on this door is flat fields
   * and never carries bytes. Deleting `{ bodyLimit: MAX_ORDER_ENVELOPE_BYTES }`
   * at `src/api/routes/post.ts` widens it to the app-wide 1 MiB and the padded
   * body below is **accepted** — the unknown field is ignored and the cancel
   * answers 200. The `toBeLessThan` states that fail-open direction as an
   * assertion: this payload is one the app-wide limit would take, so a green 413
   * can only be the per-route option still being there.
   */
  it("refuses a body past this door's own limit, not the app-wide one", async () => {
    const { app } = harness({ cancelRow: mine });
    const body = await signedNow();

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

    // The control, on the same node: the identical body without the padding is
    // accepted. The refusal above is the size and nothing else.
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
