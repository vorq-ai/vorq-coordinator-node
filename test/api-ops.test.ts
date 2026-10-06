import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { decodeFunctionData, encodeErrorResult, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../src/abi/providerRegistry.js";
import { buildApp } from "../src/api/app.js";
import { MAX_OP_QUEUE_DEPTH } from "../src/api/routes/ops.js";
import { MAX_BODY_BYTES } from "../src/api/limits.js";
import type { Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { cidForBytes } from "../src/pin/cid.js";
import { MAX_CID_CHARS } from "../src/pin/pinner.js";
import {
  bareRevert,
  refusedBroadcast,
  RELAYER_KEY,
  refusedCall,
  stubChain,
  stubTxHash,
  testConfig,
  unreachableEndpoint,
  type Simulate,
  type StubChain,
} from "./support/stub-chain.js";
import { externallyMintedCid, startStubStore, type StubStore } from "./support/stub-store.js";
import { EIP712_NAMES } from "../src/orders.js";

/**
 * `POST /evm/ops` — the one op door.
 *
 * The whole surface is driven against a canned endpoint and a canned store, so
 * every assertion is about **what the node would have sent**: the calldata it
 * built, and whether it broadcast anything at all. "Nothing was relayed" is the
 * property most of these tests exist to prove, and it is proved by the absence
 * of an `eth_sendRawTransaction` in the recorded request log rather than by a
 * status code that could be right for the wrong reason.
 *
 * No database and no chain: this file runs in every `npm test`.
 */

const JOB_ID = `0x${"01".repeat(32)}` as const;
const OTHER_JOB = `0x${"02".repeat(32)}` as const;
const BOX_KEY = `0x${"0b".repeat(32)}` as const;

/** Throwaway scalars. Neither has ever held value on any chain. */
const provider = privateKeyToAccount(`0x${"44".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"55".repeat(32)}`);

const PROVIDER_ID = 5n;
const SESSION = "vorq_sess_0123456789abcdef0123456789abcdef";

/** The address behind {@link SESSION}, and the owner of every upload it made. */
const SESSION_ADDRESS = Buffer.alloc(20, 0x77);

/**
 * The cid of a `result` upload a settle references instead of inlining.
 *
 * Deliberately not a name this file's store would mint: the assertion is that
 * the door relays the *upload's* name, and a fixture that reused the minted one
 * could not tell that from a second put of the same bytes.
 */
const UPLOAD_CID = "bafyuploadedresult";

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

/** One `files` row, as the door's two `files` statements see it. */
interface Upload {
  owner: Buffer;
  purpose: string;
}

interface DbOptions {
  operators?: Map<string, bigint>;
  /** Uploads a `result_cid` may name, by cid. */
  uploads?: Map<string, Upload>;
  /** Every `attachFile` the door ran: `[cid, owner, purpose, retentionSeconds]`. */
  attached?: unknown[][];
  /** Cids the sweep deletes between the lookup and the attach. */
  swept?: Set<string>;
}

/**
 * The reads the op door makes of the store: the session behind the bearer, the
 * registry id behind the recovered signer, and — for a settle that references an
 * upload — the `files` row behind its cid.
 *
 * Deliberately a stub rather than a real schema. What is under test is the
 * pipeline's *order* — who is refused before what is spent — and a stub makes an
 * unexpected read a hard failure instead of an empty result set.
 */
function stubDb(options: DbOptions = {}): Db {
  const operators = options.operators ?? registeredOperators();
  const uploads = options.uploads ?? new Map<string, Upload>();

  const query = (async (text: string, params?: readonly unknown[]) => {
    if (text.includes("FROM sessions")) {
      const token = params?.[0];
      return {
        rows:
          token === SESSION
            ? [
                {
                  token: SESSION,
                  address: SESSION_ADDRESS,
                  role: "provider",
                  provider_id: PROVIDER_ID,
                  expires_at: 4_102_444_800n,
                },
              ]
            : [],
      };
    }
    if (text.includes("FROM providers")) {
      const operator = params?.[0] as Buffer;
      const found = operators.get(`0x${operator.toString("hex")}`.toLowerCase());
      return { rows: found === undefined ? [] : [{ provider_id: found }] };
    }
    // `findUpload`: the whole predicate, owner and purpose included, so a test
    // that expects a miss gets one for the reason it named.
    if (text.includes("FROM files")) {
      const [cid, ownerBytes, purpose] = params as [string, Buffer, string];
      const found = uploads.get(cid);
      if (found === undefined || found.purpose !== purpose || !found.owner.equals(ownerBytes)) {
        return { rows: [] };
      }
      return { rows: [{ cid, commitment: null }] };
    }
    // `attachFile`, which answers by `rowCount`: zero means the sweep got there
    // first and the door must refuse rather than relay.
    if (text.includes("UPDATE files")) {
      const [cid] = params as [string];
      options.attached?.push([...(params ?? [])]);
      return { rows: [], rowCount: options.swept?.has(cid) === true ? 0 : 1 };
    }
    // The `cid → s3_key` row `S3Pinner` writes for a result this door files. The
    // pin is on the request path, so a stub that refused this would fail every
    // inline settle before the simulate.
    if (text.includes("INSERT INTO pins")) return { rows: [{ s3_key: params?.[1] }] };
    throw new Error(`stubDb: unexpected query ${text}`);
  }) as unknown as Db["query"];

  return {
    query,
    tx: () => Promise.reject(new Error("stubDb: no transaction expected")),
    migrate: () => Promise.reject(new Error("stubDb: no migration expected")),
    close: async () => undefined,
  };
}

const registeredOperators = () =>
  new Map<string, bigint>([[provider.address.toLowerCase(), PROVIDER_ID]]);

// ---------------------------------------------------------------------------
// Signing, to the contracts' own typehash strings
// ---------------------------------------------------------------------------

const config = testConfig();

/**
 * The object store the `settle` branch pins through, started once for this file.
 *
 * A real loopback HTTP server rather than a fake pinner: the result rides with
 * the op now, so every settle below goes through a genuine put and takes the name
 * the service answers with.
 */
let store: StubStore;

beforeAll(async () => {
  store = await startStubStore();
});

afterAll(async () => {
  await store.close();
});

const jobDomain = {
  name: EIP712_NAMES.job,
  version: "2",
  chainId: config.addresses.chainId,
  verifyingContract: config.addresses.jobRegistry,
} as const;

const providerDomain = {
  name: EIP712_NAMES.provider,
  version: "2",
  chainId: config.addresses.chainId,
  verifyingContract: config.addresses.providerRegistry,
} as const;

const CLAIM_TYPES = {
  Claim: [
    { name: "jobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/**
 * `Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)`.
 *
 * `resultCid` is **not** a member. The claimant hands the result bytes to this
 * node, which pins them and learns the name from the store — a name that does not
 * exist when the op is signed. `submitAndSettle` still takes the CID and its
 * selector is unchanged, so regenerating the ABI carries none of this and the
 * type string is the whole difference. Written out here from the contract source
 * rather than imported, so a wrong member list cannot agree with itself (R32).
 */
const SETTLE_TYPES = {
  Settle: [
    { name: "jobId", type: "bytes32" },
    { name: "completionTok", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const REQUEST_CAPACITY_TYPES = {
  RequestCapacity: [
    { name: "n", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const SET_IDENTITY_TYPES = {
  SetIdentity: [
    { name: "boxKey", type: "bytes32" },
    { name: "evidence", type: "bytes" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const now = () => BigInt(Math.floor(Date.now() / 1000));

const signClaim = (account: PrivateKeyAccount, jobId: Hex, issuedAt: bigint) =>
  account.signTypedData({
    domain: jobDomain,
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: { jobId, issuedAt },
  });

const signSettle = (
  account: PrivateKeyAccount,
  jobId: Hex,
  completionTok: number,
  issuedAt: bigint,
) =>
  account.signTypedData({
    domain: jobDomain,
    types: SETTLE_TYPES,
    primaryType: "Settle",
    message: { jobId, completionTok, issuedAt },
  });

/** The result bytes a settle carries, base64 in its body. */
const RESULT = Buffer.from("the model's output, sealed to the owner's key", "utf8");

/**
 * A settle as the wire carries it: one flat JSON body, the result base64. `null`
 * for a settle that carries neither `result` nor `result_cid`.
 */
const settleBody = (
  fields: Record<string, unknown>,
  result: Buffer | null = RESULT,
): Record<string, unknown> => ({
  ...fields,
  ...(result === null ? {} : { result: result.toString("base64") }),
});

const signSetIdentity = (
  account: PrivateKeyAccount,
  boxKey: Hex,
  evidence: Hex,
  issuedAt: bigint,
) =>
  account.signTypedData({
    domain: providerDomain,
    types: SET_IDENTITY_TYPES,
    primaryType: "SetIdentity",
    message: { boxKey, evidence, issuedAt },
  });

// ---------------------------------------------------------------------------

describe("POST /evm/ops", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    store.objects.clear();
    store.uploads.clear();
    store.requests.length = 0;
  });

  interface Harness {
    server: FastifyInstance;
    stub: StubChain;
  }

  function build(options: {
    simulate?: (stub: () => StubChain) => Simulate;
    views?: Record<string, unknown>;
    operators?: Map<string, bigint>;
    uploads?: Map<string, Upload>;
    attached?: unknown[][];
    swept?: Set<string>;
    sendError?: () => unknown;
    callError?: () => unknown;
    partBytes?: number;
    logger?: Parameters<typeof buildApp>[0]["logger"];
  } = {}): Harness {
    // The addresses every signature above is made against, with the pinning
    // service pointed at this file's stub store: a `settle` files its result
    // before anything is simulated, so a door built without a store could not
    // reach the relay path at all.
    const appConfig = testConfig({
      pinS3: store.config(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
    });
    let stub: StubChain;
    stub = stubChain(appConfig, {
      views: options.views ?? {},
      simulate: options.simulate === undefined ? undefined : () => options.simulate!(() => stub),
      sendError: options.sendError,
      callError: options.callError,
    });
    app = buildApp({
      db: stubDb({
        operators: options.operators,
        uploads: options.uploads,
        attached: options.attached,
        swept: options.swept,
      }),
      indexer: stubIndexer(),
      config: appConfig,
      chain: stub.chain,
      logger: options.logger,
    });
    return { server: app, stub };
  }

  const push = (server: FastifyInstance, payload: unknown, token: string | null = SESSION) =>
    server.inject({
      method: "POST",
      url: "/evm/ops",
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  // -- happy path -----------------------------------------------------------

  it("encodes claim(jobId, issuedAt, sig) with the contract's field order and relays it", async () => {
    const { server, stub } = build();
    const issuedAt = now();
    const signature = await signClaim(provider, JOB_ID, issuedAt);

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      tx_hash: stubTxHash(1),
      status: "success",
      block_number: 1000,
    });
    // No `as_of_block` (R28) — nothing here was read from the index.
    expect(res.json()).not.toHaveProperty("as_of_block");

    // The calldata is asserted by decoding it, not by matching a hex string: a
    // reordered argument list is the failure this guards, and a string
    // comparison would only say "different".
    expect(stub.simulated).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: jobRegistryAbi, data: stub.simulated[0] as Hex });
    expect(decoded.functionName).toBe("claim");
    expect(decoded.args).toEqual([JOB_ID, issuedAt, signature]);

    // Simulated once, then relayed once — in that order.
    const order = stub.requests.map((r) => r.method).filter((m) => m !== "eth_chainId");
    expect(order.indexOf("eth_call")).toBeLessThan(order.indexOf("eth_sendRawTransaction"));
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("relays an op signed by a provider other than the session holder", async () => {
    // The session is a transport gate and nothing more: authority is the op
    // signature, which the contracts verify. Refusing this would imply the
    // session carried an authority it does not have — and, worse, would suggest
    // that holding one *is* authority, which is the property that must never be
    // true.
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(201);
    expect(stub.broadcasts).toHaveLength(1);
  });

  // -- refusals, none of which spend gas ------------------------------------

  it("403s a push whose signature recovers to no registered provider, and relays nothing", async () => {
    const { server, stub } = build({ views: { idOf: 0 } });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(stranger, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ type: "invalid_op_signature" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    // Refused before the simulate, so not even an `eth_call` was spent on it.
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * **The settle's whole atomic-pin story, in one test.**
   *
   * The result bytes ride with the op, the node files them, and the name the
   * *store* minted becomes both the `resultCid` argument of `submitAndSettle` and
   * the `result_cid` on the `201`. The name is deliberately one no CID scheme in
   * this repository computes, so a node that quietly derived its own could not
   * pass — and the `201` is the only place a claimant can learn it, because
   * nothing it holds predicts it.
   */
  it("pins the result, puts the minted name on chain, and answers with it", async () => {
    const { server, stub } = build();
    const issuedAt = now();
    const minted = externallyMintedCid(RESULT);

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
        completion_tok: 100,
        issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    }));

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    expect(res.json().result_cid).toBe(minted);
    expect(minted).not.toBe(cidForBytes(RESULT));
    // The bytes really reached the store, whole.
    expect([...store.objects.values()].some((object) => object.equals(RESULT))).toBe(true);

    // And the calldata names exactly that: `submitAndSettle(jobId, completionTok,
    // resultCid, issuedAt, sig)`, with the CID as its UTF-8 bytes.
    expect(stub.broadcasts).toHaveLength(1);
    const call = decodeFunctionData({
      abi: jobRegistryAbi,
      data: parseTransaction(stub.broadcasts[0] as Hex).data as Hex,
    });
    expect(call.functionName).toBe("submitAndSettle");
    expect(call.args?.[2]).toBe(`0x${Buffer.from(minted, "utf8").toString("hex")}`);
  });

  it("relays nothing when the result cannot be filed", async () => {
    // The ordering the whole design rests on: the bytes are stored before the
    // transaction that names them is broadcast, so a pin that fails relays
    // nothing at all. The reverse is the one direction that cannot be repaired.
    const broken = build();
    store.omitCid = true;
    try {
      const issuedAt = now();
      const res = await push(broken.server, settleBody({
        op: "settle",
        job_id: JOB_ID,
          completion_tok: 100,
          issued_at: Number(issuedAt),
        signature: await signSettle(provider, JOB_ID, 100, issuedAt),
      }));

      expect(res.statusCode).toBe(503);
      expect(res.json().error.type).toBe("pinner_unavailable");
      expect(res.headers["x-vorq-retryable"]).toBe("true");
      // No name went on chain, and no name came back on the failure envelope.
      expect(res.json().result_cid).toBeUndefined();
      expect(broken.stub.simulated).toEqual([]);
      expect(broken.stub.broadcasts).toEqual([]);
    } finally {
      store.omitCid = false;
    }
  });

  it("refuses a settle carrying no result at all", async () => {
    // `EmptyResultCid` guards the chain against a missing name and nothing guards
    // it against a name for nothing — the CID of zero bytes is a perfectly valid
    // CID, so a settle with an empty result would mint one and land it on the row.
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
        completion_tok: 100,
        issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    }, Buffer.alloc(0)));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe("result");
    expect(stub.broadcasts).toEqual([]);
  });

  it("403s a settle whose payload disagrees with its signature", async () => {
    // The signature is over completion_tok 100; the payload claims 200. The
    // recovered address is then somebody else entirely — which is exactly what
    // makes tampering indistinguishable from a forgery, and both are refused by
    // the same gate.
    const { server, stub } = build({ views: { idOf: 0 } });
    const issuedAt = now();
    const signature = await signSettle(provider, JOB_ID, 100, issuedAt);

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
        completion_tok: 200,
        issued_at: Number(issuedAt),
      signature,
    }));

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ type: "invalid_op_signature" });
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("409s when the pre-relay simulate reverts, and relays nothing", async () => {
    const { server, stub } = build({ simulate: () => ({ kind: "revert", errorName: "NotOpen" }) });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "NotOpen" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.simulated).toHaveLength(1);
    // The whole point: the revert was discovered for free.
    expect(stub.broadcasts).toEqual([]);
  });

  it("reports a revert it cannot decode as unknown, with the bytes attached", async () => {
    // The escrow pull inside `claim` goes through the payment token, whose
    // errors are in neither registry's ABI. Mapping them onto the
    // nearest familiar name would tell a provider its claim failed for a reason
    // that is not why it failed.
    const opaque = `0x${"de".repeat(4)}` as const;
    const { server, stub } = build({ simulate: () => ({ kind: "opaque", data: opaque }) });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "unknown", raw: opaque });
    expect(stub.broadcasts).toEqual([]);
  });

  it("401s a request with no session, before it looks at the chain at all", async () => {
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(
      server,
      {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      },
      null,
    );

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({
      type: "authentication_error",
      code: "invalid_session",
    });
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  // -- the two staleness regimes (R24, R33) ---------------------------------

  it("409s a job op outside the ±600 s window, without spending an RPC call", async () => {
    // Job ops: ±600 s inclusive against the node's clock, no nonce — the one-shot
    // state machine is the replay guard. The node's clock is a pre-check and the
    // chain is authoritative, so no margin is added on either side (R24).
    const { server, stub } = build();
    const issuedAt = now() - 601n;

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "StaleOp" });
    expect(stub.requests).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("accepts a job op exactly on the ±600 s boundary, which is inclusive", async () => {
    const { server, stub } = build();
    // 599, not 600: the request takes a measurable moment, and a test written to
    // the exact boundary would be flaky in the direction that hides a bug.
    const issuedAt = now() - 599n;

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(201);
    expect(stub.broadcasts).toHaveLength(1);
  });

  /**
   * **R78 at the edge, on the door where it was missing (A-C).**
   *
   * The ±600 s window and the registry regime were both fixed in `post.ts` and
   * both left undefended here: all four operator flips left the suite green,
   * because the fixtures above probe 599 and 601 — one *past* each edge, never
   * *at* it. The 599 test even says so in a comment: written to the exact
   * boundary it would be flaky, so it was written away from the boundary and the
   * boundary went untested.
   *
   * The flakiness is real and is dealt with rather than avoided: the node reads
   * its own clock inside the handler, so a request that straddles a second
   * boundary is measuring the clock and not the operator. {@link onOneSecond}
   * runs the probe again when that happens, which makes an exact-edge assertion
   * deterministic.
   */
  const onOneSecond = async <T>(probe: (now: bigint) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const before = now();
      const result = await probe(before);
      if (now() === before) return result;
      expect(attempt).toBeLessThan(9); // a tick every attempt is not a clock
    }
  };

  it("accepts a job op at exactly −600 s and refuses it at −601 (R78)", async () => {
    const accepted = await onOneSecond(async (at) => {
      const { server, stub } = build();
      const issuedAt = at - 600n;
      const res = await push(server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      });
      return { res, stub };
    });

    // `issuedAt + 600 < now` — flipping it to `<=` refuses this op, and the node
    // would then refuse an op the chain accepts.
    expect(accepted.res.statusCode).toBe(201);
    expect(accepted.stub.broadcasts).toHaveLength(1);
  });

  it("accepts a job op at exactly +600 s and refuses it at +601 (R78)", async () => {
    const { accepted, refused } = await onOneSecond(async (at) => {
      const edge = build();
      const acceptedRes = await push(edge.server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(at + 600n),
        signature: await signClaim(provider, JOB_ID, at + 600n),
      });
      const past = build();
      const refusedRes = await push(past.server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(at + 601n),
        signature: await signClaim(provider, JOB_ID, at + 601n),
      });
      return { accepted: acceptedRes, refused: refusedRes };
    });

    // `issuedAt > now + 600` — flipping it to `>=` refuses the first of these.
    expect(accepted.statusCode).toBe(201);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ ok: false, reason: "StaleOp" });
  });

  it("refuses a registry op AT its floor and accepts it one second above (R78)", async () => {
    // **The fail-open edge.** `op.issuedAt <= floor` is R11/R33's monotonic
    // per-op floor, restating `ProviderRegistry`'s own `lastIdentityAt`
    // comparison. Flipped to `<`, an op whose `issuedAt` is exactly the stored
    // floor is re-admitted and relayed — the node pays gas for a replay the
    // chain refuses. Nothing was red, because no fixture ever sat on the floor.
    const floor = now() - 5n;

    const at = build({ views: { lastIdentityAt: floor } });
    const atFloor = await push(at.server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(floor),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", floor),
    });

    const above = build({ views: { lastIdentityAt: floor } });
    const oneAbove = await push(above.server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(floor + 1n),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", floor + 1n),
    });

    expect(atFloor.statusCode).toBe(409);
    expect(atFloor.json()).toEqual({ ok: false, reason: "StaleOp" });
    expect(at.stub.broadcasts).toEqual([]);

    expect(oneAbove.statusCode).toBe(201);
    expect(above.stub.broadcasts).toHaveLength(1);
  });

  it("accepts a registry op at exactly +3600 s of skew and refuses it at +3601 (R78)", async () => {
    const { accepted, refused } = await onOneSecond(async (at) => {
      const edge = build({ views: { lastIdentityAt: 1n } });
      const acceptedRes = await push(edge.server, {
        op: "set_identity",
        box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(at + 3600n),
        signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", at + 3600n),
      });
      const past = build({ views: { lastIdentityAt: 1n } });
      const refusedRes = await push(past.server, {
        op: "set_identity",
        box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(at + 3601n),
        signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", at + 3601n),
      });
      return { accepted: acceptedRes, refused: refusedRes };
    });

    expect(accepted.statusCode).toBe(201);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ ok: false, reason: "StaleOp" });
  });

  it("409s a registry op at or below its monotonic floor, and relays nothing", async () => {
    // Registry ops are a *different* regime: a strictly monotonic per-op floor
    // read from the chain (R11 — the maximum of any stored floor and the
    // chain's, and nothing here mirrors `lastIdentityAt`, so the chain's value
    // is the maximum), plus a skew ceiling. Conflating this with the job ops'
    // ±600 s window is the failure mode R33 exists to name: an `issued_at` of
    // "now" is perfectly fresh by the job rule and still stale by this one.
    const { server, stub } = build({ views: { lastIdentityAt: now() + 10n } });
    const issuedAt = now();

    const res = await push(server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(issuedAt),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "StaleOp" });
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("503s a dead endpoint on the provider-id read, not 500 (R77, the fifth door)", async () => {
    // `resolveProviderId` confirms a projection **miss** against `idOf`, so it is
    // on the request path of this door, `PUT /evm/asks` and the provider
    // handshake — and its `eth_call` was bare. A dead endpoint answered
    // `500 internal_error, x-vorq-retryable: false` on all three: an unreachable
    // RPC reported as a permanent property of the caller's request. No reviewer
    // named this door; the guard lives inside `resolveProviderId` now, so a
    // fourth caller cannot be written without it.
    const { server, stub } = build({
      operators: new Map(), // the projection knows nobody, so the chain is asked
      callError: () => unreachableEndpoint(),
    });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type: "chain_unreachable", param: null });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  it("simulates FROM the relayer account, not from the op's signer (R64/R65, S-4)", async () => {
    // The claim `simulateThenRelay` rests on: *"the simulate runs from the
    // relayer's address, not from the signer's — a simulate from any other
    // sender is a simulate of a different transaction."* It was unobservable:
    // the stub destructured `{ to, data }` and dropped `from`, so deleting the
    // `account` field left every test green. The stub records the sender now,
    // and this is the assertion that spends it.
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(201);
    expect(stub.simulatedFrom).toHaveLength(1);
    // The relayer, and demonstrably **not** the signer — which is the half that
    // would still pass if the field were merely set to something.
    const relayer = privateKeyToAccount(RELAYER_KEY);
    expect(stub.simulatedFrom[0]?.toLowerCase()).toBe(relayer.address.toLowerCase());
    expect(stub.simulatedFrom[0]?.toLowerCase()).not.toBe(provider.address.toLowerCase());
  });

  it("relays a registry op that clears its floor", async () => {
    const { server, stub } = build({ views: { lastIdentityAt: 1n } });
    const issuedAt = now();

    const res = await push(server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(issuedAt),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", issuedAt),
    });

    expect(res.statusCode).toBe(201);
    const decoded = decodeFunctionData({
      abi: providerRegistryAbi,
      data: stub.simulated[0] as Hex,
    });
    expect(decoded.functionName).toBe("setIdentity");
    expect(decoded.args?.[0]).toBe(BOX_KEY);
    expect(decoded.args?.[1]).toBe("0xdeadbeef");
    expect(decoded.args?.[2]).toBe(issuedAt);
  });

  // -- serialization per job_id ---------------------------------------------

  it("serialises claims for one job_id: one relay, one 409, no wasted gas", async () => {
    // Without the queue both simulates pass — they see the same pre-claim state
    // — and the node broadcasts twice, paying for a revert it could have seen.
    // With it, the second push re-simulates against the state the first
    // produced, which is what `NotOpen` means here.
    const { server, stub } = build({
      simulate: (current) =>
        current().broadcasts.length === 0
          ? { kind: "ok" }
          : { kind: "revert", errorName: "NotOpen" },
    });
    const issuedAt = now();
    const signature = await signClaim(provider, JOB_ID, issuedAt);
    const body = { op: "claim", job_id: JOB_ID, issued_at: Number(issuedAt), signature };

    const [first, second] = await Promise.all([push(server, body), push(server, body)]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    expect(stub.broadcasts).toHaveLength(1);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json()).toEqual({ ok: false, reason: "NotOpen" });
    // Both were simulated; only one was paid for.
    expect(stub.simulated).toHaveLength(2);
  });

  /** Two claims for two different jobs, pushed together. */
  const twoJobs = async (server: FastifyInstance) => {
    const issuedAt = now();
    return Promise.all([
      push(server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      }),
      push(server, {
        op: "claim",
        job_id: OTHER_JOB, issued_at: Number(issuedAt),
        signature: await signClaim(provider, OTHER_JOB, issuedAt),
      }),
    ]);
  };

  it("does not serialise claims for different job_ids against each other", async () => {
    // The queue is keyed by `(op, job_id)`, so two providers claiming two jobs
    // must not queue behind one another — that would turn a correctness device
    // into a throughput ceiling.
    //
    // **This asserts overlap, not outcome** (R65(b), R67). `[201,201]` with two
    // broadcasts is exactly what a queue keyed on a *constant* also produces: it
    // serialises the two requests and both still succeed, so the test's own
    // subject — that the key is the job — went untested. What only genuine
    // concurrency produces is an interleaved RPC log: both pipelines reach their
    // pre-relay simulate before either reaches its broadcast. Serialised, the
    // first runs simulate → broadcast → receipt to completion before the second
    // issues its first `eth_call`.
    const { server, stub } = build();

    const [a, b] = await twoJobs(server);

    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(stub.broadcasts).toHaveLength(2);

    const order = stub.requests.map((r) => r.method);
    const simulates = order.flatMap((m, i) => (m === "eth_call" ? [i] : []));
    const sends = order.flatMap((m, i) => (m === "eth_sendRawTransaction" ? [i] : []));
    expect(simulates).toHaveLength(2);
    expect(sends).toHaveLength(2);
    expect(Math.max(...simulates)).toBeLessThan(Math.min(...sends));
  });

  it("drives two op pipelines through the endpoint at the same time, and only two", async () => {
    // The property every concurrency test in this file rests on, asserted
    // directly instead of assumed (R67). The stub crosses the event loop once
    // per request precisely so two in-flight requests interleave, as they do
    // through a real socket; replacing that hop with a microtask drains each
    // pipeline inside one macrotask turn, the harness does the serialising, and
    // the queue tests above pass with the queue deleted. `maxInFlight` is the
    // only thing that can see the difference — every status code and broadcast
    // count is identical either way.
    //
    // **`toBe(2)` and the solo request below, not `toBeGreaterThan(1)`.** The
    // counter was itself unguarded: deleting the stub's `finally { inFlight -= 1 }`
    // makes it monotonic, so it only ever rises, `toBeGreaterThan(1)` passes
    // unconditionally and this whole test is disarmed with **no test red** — the
    // exact pattern R67 exists to name, one level up. Two concurrent requests put
    // exactly two RPCs in flight, because each pipeline is internally sequential;
    // a single request, whose calls are strictly one after another, must report
    // 1. A counter that cannot fall reads the number of RPCs the request made
    // instead, which is six, so both halves go red the moment the decrement goes.
    const both = build();

    await twoJobs(both.server);

    expect(both.stub.maxInFlight).toBe(2);
    await both.server.close();

    const solo = build();
    const issuedAt = now();
    const res = await push(solo.server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(201);
    expect(solo.stub.maxInFlight).toBe(1);
  });

  it("signs a distinct relayer nonce for each concurrent relay (R66)", async () => {
    // The relayer account is one account with one transaction nonce.
    // `sendTransaction` reads `eth_getTransactionCount` at `pending` and signs
    // straight after, so two overlapping sends read the same count and sign the
    // same nonce: only one can ever mine, and if the fees differ the second
    // *replaces* the first — relaying a different provider's op than the caller
    // asked for. Measured before `chain.relay` serialised sends: two claims for
    // two different jobs, both signed with nonce 7.
    //
    // Decoded from the broadcast bytes, not from the node's intent.
    const { server, stub } = build();

    const [a, b] = await twoJobs(server);

    // Distinct hashes as well as distinct nonces. A stub minting a constant one
    // cannot express two relays at all, and it deadlocks any concurrency test
    // above two in flight: viem's `waitForTransactionReceipt` dedupes observers
    // by hash, so N broadcasts produce one receipt poll and N−1 requests that
    // never resolve — a hang rather than a failure, which is the worst thing a
    // CI job can do.
    expect(a.json().tx_hash).not.toBe(b.json().tx_hash);

    expect(stub.broadcasts).toHaveLength(2);
    const nonces = stub.broadcasts.map((raw) => parseTransaction(raw as Hex).nonce);
    expect(new Set(nonces).size).toBe(2);
    // The stub's count starts at 7 and advances per broadcast, exactly as a
    // `pending` count does, so the second relay must have read the first one's.
    expect([...nonces].sort()).toEqual([7, 8]);
  });

  it("serialises two identical settles, so the node does not pay for its own duplicate", async () => {
    // R66(a). `settle`, `fail` and both registry ops were unqueued on the
    // grounds that the *contract* makes them one-shot — which is precisely what
    // makes the loser revert **after** paying for its own execution. Two
    // identical submissions both simulated against the same pre-op state and
    // both broadcast; twenty of them broadcast twenty times, with no cap. It
    // needs no forgery: an SDK retrying a slow response does it by accident.
    const { server, stub } = build({
      simulate: (current) =>
        current().broadcasts.length === 0
          ? { kind: "ok" }
          : { kind: "revert", errorName: "NotClaimed" },
    });
    const issuedAt = now();
    const body = settleBody({
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    });

    const [first, second] = await Promise.all([push(server, body), push(server, body)]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(stub.broadcasts).toHaveLength(1);
    expect(stub.simulated).toHaveLength(2);
  });

  it("429s past the queue depth, retryably, rather than guessing a verdict", async () => {
    // `busy` is the only retryable refusal this door has, so it is exactly what
    // a client branches on — and the depth bound that produces it was unpinned:
    // deleting the check turned no test red (R67). The refusal is honest by
    // construction: a queued request has not been simulated, so answering
    // `NotOpen` would be reporting a gate that was never evaluated.
    const { server, stub } = build();
    const issuedAt = now();
    const body = {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    };

    const responses = await Promise.all(
      Array.from({ length: MAX_OP_QUEUE_DEPTH + 2 }, () => push(server, body)),
    );

    const busy = responses.filter((res) => res.statusCode === 429);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy[0]?.json().error).toMatchObject({ type: "busy" });
    expect(busy[0]?.headers["x-vorq-retryable"]).toBe("true");
    // Refused before the pipeline, so a busy request costs no simulate and no
    // gas.
    expect(stub.broadcasts.length).toBeLessThanOrEqual(MAX_OP_QUEUE_DEPTH);
  });

  // -- R80: the stage is not a discriminator; the funding model is ------------

  /** `NotOpen()` as the endpoint returns it — the bytes, not a phrase. */
  const NOT_OPEN = encodeErrorResult({ abi: jobRegistryAbi, errorName: "NotOpen" });

  it("409s a send-stage revert with the contract's own error name (R80)", async () => {
    // This answered `400 invalid_request_error, code: null` — the same event the
    // simulate two lines above answers `409 {ok:false, reason:"NotOpen"}`, given
    // two answers by nothing but which chain call happened to see it first. R66(c)
    // put the send inside a `try` (before that it was `500 internal`), R70 gave the
    // non-verdicts a funding-model-aware classification, and R80 finishes the job:
    // a verdict is a verdict at either stage.
    //
    // `400` is wrong here for R70's reason — the caller's request was well-formed
    // and the node's own transaction was refused. A retryable `503` was defensible,
    // since a revert reaching the *send* means the state moved under an op the
    // simulate had already passed, but it throws away the one thing the endpoint
    // told us. The name serves the transience argument rather than contradicting
    // it: a caller that reads `AtCapacity` knows to re-read and retry.
    const { server, stub } = build({
      sendError: () => refusedBroadcast("execution reverted", 3, NOT_OPEN),
    });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "NotOpen" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    // Not an error envelope: the refusal shape is the door's verdict shape.
    expect(res.json()).not.toHaveProperty("error");
    // The endpoint refused the bytes, so nothing was broadcast.
    expect(stub.broadcasts).toEqual([]);
  });

  it("answers the identical 409 whichever stage the revert arrived at (R80)", async () => {
    // The disagreement itself, driven from both sides with one signed body. Two
    // harnesses: one whose pre-relay `eth_call` reverts `NotOpen`, one whose
    // broadcast is refused with the same bytes. A caller cannot tell which chain
    // call failed and the answer must not depend on it — which is exactly the
    // property a per-stage mapping cannot have.
    const issuedAt = now();
    const body = {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    };

    const simulateStage = build({ simulate: () => ({ kind: "revert", errorName: "NotOpen" }) });
    const fromSimulate = await push(simulateStage.server, body);
    await app?.close();
    app = undefined;

    const sendStage = build({
      sendError: () => refusedBroadcast("execution reverted", 3, NOT_OPEN),
    });
    const fromSend = await push(sendStage.server, body);

    expect([fromSimulate.statusCode, fromSend.statusCode]).toEqual([409, 409]);
    expect(fromSend.json()).toEqual(fromSimulate.json());
    expect(fromSend.headers["x-vorq-retryable"]).toBe(fromSimulate.headers["x-vorq-retryable"]);
    expect(fromSend.json()).toEqual({ ok: false, reason: "NotOpen" });
  });

  it("409s a bare revert() at the send stage, whose data is 0x and decodes to nothing", async () => {
    // R72's test is "did the endpoint answer with a revert", never "is `raw`
    // null", and R80 moves that test to the send stage unchanged. A contract that
    // reverts with no reason string and no custom error returns **empty** data, so
    // there is nothing to decode — but the endpoint pronounced, and classifying on
    // the absence of data would turn every bare `require(false)` reached at a
    // broadcast into a retryable `503` a daemon would retry forever.
    const { server, stub } = build({
      sendError: () => refusedBroadcast("execution reverted", 3, "0x"),
    });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    // No `raw`: there were no bytes to hand back.
    expect(res.json()).toEqual({ ok: false, reason: "unknown" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  // -- R70: the node's own failures are the node's, and they are retryable -----

  /**
   * One row per class of node-side broadcast failure, and one test each (R67).
   *
   * The node builds the bytes on this door and the relayer pays for them, which
   * is what makes every one of these the node's own failure. The classification
   * they were first given assumed the opposite — that a caller had signed and
   * funded its own transaction, so the endpoint's refusal was a verdict on that
   * caller's request — and sent all four of these back as
   * `400 invalid_request_error, x-vorq-retryable: false, code: null` — the
   * provider's `settle` dropped, the daemon told its request was malformed and
   * must never be retried, and nothing anywhere saying the operator had to top
   * up a wallet. R57 defines `invalid_request` as "the same request, unchanged,
   * cannot succeed later", which is false for every one of them.
   *
   * `-32000` is the generic code go-ethereum returns for the first two, which is
   * why they are matched on the message and the other two on the code.
   */
  const NODE_SIDE: readonly { label: string; error: () => Error; code: string }[] = [
    {
      // The worst of the four: the most likely to happen, it takes the whole
      // node down for writes, and it was reported as a per-caller input error.
      label: "an empty relayer wallet",
      error: () => refusedBroadcast("insufficient funds for gas * price + value"),
      code: "relayer_funds",
    },
    {
      // The external-self-submitter residue the design already accepts: a
      // transaction from the same key landed between the node's `pending` count
      // read and its broadcast. A retry a second later works.
      label: "a nonce that lost a race with an external submitter",
      error: () => refusedBroadcast("nonce too low"),
      code: "nonce_conflict",
    },
    {
      label: "the endpoint's own internal error",
      error: () => refusedBroadcast("internal error", -32603),
      code: "rpc_internal",
    },
    {
      // R42's code — the one viem itself retries — turned into a permanent
      // caller-side error.
      label: "the RPC endpoint rate-limiting the node",
      error: () => refusedBroadcast("limit exceeded", -32005),
      code: "rate_limited",
    },
  ];

  for (const { label, error, code } of NODE_SIDE) {
    it(`503s ${label}, retryably, rather than blaming the caller (R70)`, async () => {
      const { server, stub } = build({ sendError: error });
      const issuedAt = now();

      const res = await push(server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        type: "relay_unavailable",
        // No field of the request is at fault — the node built these bytes.
        param: null,
        // The discriminator the caller had none of. `code: null` on a 400 told a
        // daemon nothing about which of six unrelated failures it had met.
        code,
      });
      expect(res.headers["x-vorq-retryable"]).toBe("true");
      expect(stub.broadcasts).toEqual([]);
    });
  }

  it("names the wallet in the message when the relayer is the thing that is empty", async () => {
    // The operator-facing half of `relayer_funds`: an empty relayer takes every
    // write door down, and a response that says only "could not broadcast" sends
    // whoever is on call looking at the chain instead of at a balance.
    const { server } = build({
      sendError: () => refusedBroadcast("insufficient funds for gas * price + value"),
    });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.json().error.message).toMatch(/relayer account/i);
    expect(res.json().error.message).toMatch(/top it up/i);
  });

  it("logs an empty relayer at error, which is the line that reaches Sentry", async () => {
    const lines: string[] = [];
    const { server } = build({
      sendError: () => refusedBroadcast("insufficient funds for gas * price + value"),
      logger: { level: "error", stream: { write: (line: string) => void lines.push(line) } },
    });
    const issuedAt = now();

    await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(lines.map((line) => JSON.parse(line).msg)).toEqual([
      "relayer is out of gas funds; relays are failing",
    ]);
  });

  it("503s a broadcast nothing answered at all, retryably", async () => {
    // `sendFailure`'s `503 chain_unreachable` branch fires only when there is no
    // numeric JSON-RPC code anywhere in the `cause` chain — which is exactly what
    // a connection failure looks like through viem's real HTTP transport, and it
    // had no test on either door. Distinct from `relay_unavailable` above: there
    // the endpoint answered and refused, here nothing answered.
    const { server, stub } = build({ sendError: () => unreachableEndpoint() });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type: "chain_unreachable", param: null });
    expect(res.json().error.message).toMatch(/^could not reach the RPC endpoint: /);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  // -- R72: a refusal is a verdict only if the endpoint returned one ---------

  /**
   * The same four failure classes, raised at the **simulate** instead of at the
   * send — which is where they actually strike.
   *
   * For the three job ops the pre-relay `eth_call` is the pipeline's *first*
   * chain call, so an endpoint that has gone away never reaches the send at all
   * and the whole of R70's send-stage mapping sits downstream of it. That
   * `catch` handed every error to `decodeRevert`, which returns
   * `{reason:"unknown", raw:null}` for anything carrying no revert data, and the
   * door answered `409 {ok:false, reason:"unknown"}, x-vorq-retryable: false`.
   *
   * A `409` here is not an error envelope, it is a **verdict**: the daemon is
   * told the chain refused its op and that retrying is pointless. Under R57 that
   * promises the identical request can never succeed, which is false the moment
   * the RPC comes back — and the provider's `settle` is simply lost.
   *
   * The suite could not see any of this until the stub could refuse an
   * `eth_call`: it could refuse a broadcast and nothing else, so every test of a
   * failed chain call was really a test of a failed broadcast (R64/R65).
   */
  const SIMULATE_FAILURES: readonly {
    label: string;
    error: () => Error;
    type: string;
    code: string | null;
  }[] = [
    {
      // The one an operator meets first, and the one measured against viem's
      // real `http()` transport with nothing listening.
      label: "an endpoint that answered nothing at all",
      error: () => unreachableEndpoint(),
      type: "chain_unreachable",
      code: null,
    },
    {
      label: "the RPC endpoint rate-limiting the node",
      error: () => refusedCall("limit exceeded", -32005),
      type: "relay_unavailable",
      code: "rate_limited",
    },
    {
      label: "the endpoint's own internal error",
      error: () => refusedCall("internal error", -32603),
      type: "relay_unavailable",
      code: "rpc_internal",
    },
  ];

  for (const { label, error, type, code } of SIMULATE_FAILURES) {
    it(`503s ${label} at the simulate, retryably, rather than calling it a verdict (R72)`, async () => {
      const { server, stub } = build({ callError: error });
      const issuedAt = now();

      const res = await push(server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({ type, param: null, code });
      expect(res.headers["x-vorq-retryable"]).toBe("true");
      // Not the refusal shape: a `{ok:false}` body is this door's verdict, and
      // answering one for a chain the node could not reach is the defect.
      expect(res.json()).not.toHaveProperty("ok");
      expect(stub.broadcasts).toEqual([]);
    });
  }

  it("409s a bare revert() at the simulate, whose data is 0x and decodes to nothing", async () => {
    // The other direction, and the reason the test is "did the endpoint answer
    // with a revert" rather than "is `raw` null" (R72). A contract that reverts
    // with no reason string and no custom error returns **empty** data, so there
    // is nothing to decode — but the endpoint pronounced, and this is a verdict.
    // Classifying on the absence of data would turn every bare `require(false)`
    // on either registry into a retryable 503 a daemon would retry forever.
    const { server, stub } = build({ callError: () => bareRevert() });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    // No `raw`: there were no bytes to hand back.
    expect(res.json()).toEqual({ ok: false, reason: "unknown" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("409s a revert an endpoint reports under its generic code, not just under 3", async () => {
    // go-ethereum answers a reverted `eth_call` with JSON-RPC code 3, but that
    // code is not universal: some endpoints report the identical refusal under
    // `-32000`, where the wording is the only thing that distinguishes it from a
    // node-side refusal. Classifying on code 3 alone would answer every revert
    // on such an endpoint as a retryable 503 — every `NotOpen`, forever.
    const { server, stub } = build({ callError: () => refusedCall("execution reverted", -32000) });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("409s a code-3 refusal whose wording is not the phrase anyone matches on", async () => {
    // The middle clause, on its own. An endpoint that answers a reverted
    // `eth_call` with code 3 has pronounced, whatever it writes in `message` —
    // the code is the JSON-RPC-level statement that the call executed and
    // reverted, and the wording is the part that varies between endpoints and
    // between versions of one endpoint. Leaning on the phrase alone would make
    // the door's whole verdict/failure split depend on a string nobody
    // standardised.
    const { server, stub } = build({ callError: () => refusedCall("reverted", 3) });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "unknown" });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("409s a revert whose only evidence is the data the endpoint returned", async () => {
    // The strongest of the three tests, and the one no code and no wording can
    // supply: revert data came back, so the call executed, whatever the endpoint
    // chose to call the failure. Not every endpoint answers a reverted `eth_call`
    // with code 3 or the phrase "execution reverted" — some return the bytes
    // under a code of their own — and the bytes are then the whole of the
    // evidence.
    const opaque = `0x${"de".repeat(4)}` as const;
    const { server, stub } = build({
      callError: () => refusedCall("VM execution error.", -32015, opaque),
    });
    const issuedAt = now();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: Number(issuedAt),
      signature: await signClaim(provider, JOB_ID, issuedAt),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, reason: "unknown", raw: opaque });
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(stub.broadcasts).toEqual([]);
  });

  it("503s a dead endpoint on a registry op's floor read, not 500 internal_error", async () => {
    // The second half of the same defect. `registryFloor`'s `readContract` was
    // not wrapped at all, so `set_identity` and `request_capacity` answered
    // `500 internal_error, retryable=false` for the same causes — two write ops
    // calling a dead endpoint a verdict, two calling it an internal error, none
    // calling it retryable. This read happens **before** the simulate, so it is
    // what those two ops meet first.
    const { server, stub } = build({ callError: () => unreachableEndpoint() });
    const issuedAt = now();

    const res = await push(server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(issuedAt),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", issuedAt),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type: "chain_unreachable", param: null });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    // It never got as far as the simulate, which is the point.
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  it("503s a rate-limited registry floor read with the discriminating code", async () => {
    const { server, stub } = build({ callError: () => refusedCall("limit exceeded", -32005) });
    const issuedAt = now();

    const res = await push(server, {
      op: "request_capacity",
      n: 3, issued_at: Number(issuedAt),
      signature: await provider.signTypedData({
        domain: providerDomain,
        types: REQUEST_CAPACITY_TYPES,
        primaryType: "RequestCapacity",
        message: { n: 3, issuedAt },
      }),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type: "relay_unavailable", code: "rate_limited" });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toEqual([]);
  });

  it("503s a revert on the registry floor read — a node fault, not a verdict (R77)", async () => {
    // **The ruling that moved this.** A reverting floor read used to answer
    // `409 {ok:false, reason:"unknown"}, retryable=false`, by an explicit
    // opt-out from R77. It is not a verdict on anything the caller signed:
    // `lastIdentityAt` is a storage getter on a frozen contract and reverts only
    // when this node points at the wrong address or when the endpoint reports
    // unavailable historical state as `execution reverted`. `retryable=false`
    // then tells every provider daemon to stop, so a misconfigured node is met
    // with silence rather than retries that show an operator the real fault —
    // while the node holds the resolved `providerId` and still says "unknown".
    //
    // Red if the `viewRead` wrapper is removed: unwrapping puts the revert back
    // through `chainFailure`, `isVerdict` is true, and the `409` returns.
    const { server, stub } = build({ callError: () => bareRevert() });
    const issuedAt = now();

    const res = await push(server, {
      op: "set_identity",
      box_key: BOX_KEY, evidence: "0xdeadbeef", issued_at: Number(issuedAt),
      signature: await signSetIdentity(provider, BOX_KEY, "0xdeadbeef", issuedAt),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      type: "relay_unavailable",
      code: "registry_floor_read",
      param: null,
    });
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    // Still nothing relayed, and it never reached the simulate.
    expect(stub.simulated).toEqual([]);
    expect(stub.broadcasts).toEqual([]);
  });

  /**
   * The send-stage default, inverted (R72(b)).
   *
   * Every one of these is go-ethereum's own wording for a refusal of the
   * **transaction envelope** — its fees, its gas, its pool admission — and the
   * node chose every one of those values. The caller signed the op payload and
   * nothing else. All of them answered `400 invalid_request_error,
   * retryable=false` while the allowlist above them enumerated what was the
   * node's, which is backwards on a door where the node funds the transaction:
   * a list has to be revisited every time an endpoint invents a phrase, and each
   * phrase it has not met yet is answered as a verdict.
   *
   * Note the pair: `replacement transaction underpriced` was matched and bare
   * `transaction underpriced` was not, and the two mean the same thing about
   * whose fault it is.
   */
  const ENVELOPE_REFUSALS: readonly (readonly [string, number])[] = [
    ["txpool is full", -32000],
    ["transaction underpriced", -32000],
    ["max fee per gas less than block base fee", -32000],
    ["intrinsic gas too low", -32000],
    ["exceeds block gas limit", -32000],
    ["gas limit reached", -32000],
    ["future transaction tries to replace pending", -32000],
    ["resource not found", -32001],
    ["resource unavailable", -32002],
    ["method not supported", -32004],
  ];

  for (const [message, rpcCode] of ENVELOPE_REFUSALS) {
    it(`503s "${message}" — a refusal of the envelope the NODE built (R72)`, async () => {
      const { server, stub } = build({ sendError: () => refusedBroadcast(message, rpcCode) });
      const issuedAt = now();

      const res = await push(server, {
        op: "claim",
        job_id: JOB_ID, issued_at: Number(issuedAt),
        signature: await signClaim(provider, JOB_ID, issuedAt),
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({
        type: "relay_unavailable",
        param: null,
        // No named class matches, and that is the point: the default is now
        // retryable, so a refusal nobody here has a name for is still the
        // node's.
        code: "endpoint_refused",
      });
      expect(res.headers["x-vorq-retryable"]).toBe("true");
      expect(stub.broadcasts).toEqual([]);
    });
  }

  // -- input bounds ---------------------------------------------------------

  it("400s an unknown op, a malformed job id and an oversized evidence", async () => {
    const { server, stub } = build();
    const issuedAt = String(now());
    const signature = `0x${"00".repeat(65)}`;

    const unknownOp = await push(server, { op: "reclaim",  signature });
    expect(unknownOp.statusCode).toBe(400);
    expect(unknownOp.json().error).toMatchObject({ param: "op" });

    const badJobId = await push(server, {
      op: "claim",
      job_id: "0x01", issued_at: issuedAt,
      signature,
    });
    expect(badJobId.statusCode).toBe(400);
    expect(badJobId.json().error).toMatchObject({ param: "job_id" });

    // 32 769 bytes: one past the bound, which is itself the ~32 kB R50a measured
    // to be reachable on chain for roughly 1 M gas.
    const huge = await push(server, {
      op: "set_identity",
      box_key: BOX_KEY,
        evidence: `0x${"ab".repeat(32_769)}`,
        issued_at: issuedAt,
      signature,
    });
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error).toMatchObject({ param: "evidence" });

    expect(stub.broadcasts).toEqual([]);
  });

  // -- the result: inline, and by name --------------------------------------

  it("files a result past one part and names the whole of it", async () => {
    const SMALL_PART = 4 * 1024;
    const { server, stub } = build({ partBytes: SMALL_PART });
    const result = Buffer.alloc(3 * SMALL_PART, 0x41);
    const issuedAt = now();

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    }, result));

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    expect(res.json().result_cid).toBe(externallyMintedCid(result));
    expect(store.requests.filter((r) => r.url.includes("partNumber=")).length).toBeGreaterThan(1);
    expect([...store.objects.values()].some((object) => object.equals(result))).toBe(true);
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("answers a store that refuses a part the way it answers one that refuses the completion", async () => {
    // A result past one part reaches the store as one put per part. A refusal on
    // any of them is the same failure as one at the completion — nothing the
    // caller sent is wrong — and has to be the same retryable 503, or a daemon
    // would fail the job and refund the client for a store outage that a result
    // one part smaller would have survived with a retry.
    const SMALL_PART = 4 * 1024;
    const { server, stub } = build({ partBytes: SMALL_PART });
    store.failPartNumber = 2;
    try {
      const issuedAt = now();
      const res = await push(server, settleBody({
        op: "settle",
        job_id: JOB_ID,
        completion_tok: 100,
        issued_at: Number(issuedAt),
        signature: await signSettle(provider, JOB_ID, 100, issuedAt),
      }, Buffer.alloc(3 * SMALL_PART, 0x42)));

      expect(res.statusCode).toBe(503);
      expect(res.json().error.type).toBe("pinner_unavailable");
      expect(res.headers["x-vorq-retryable"]).toBe("true");
      expect(stub.simulated).toEqual([]);
      expect(stub.broadcasts).toEqual([]);
      // The upload it opened was abandoned, not left open.
      expect(store.uploads.size).toBe(0);
    } finally {
      store.failPartNumber = null;
    }
  });

  it("takes a result well past the app-wide 1 MiB body limit", async () => {
    // The reason `MAX_BODY_BYTES` is well above the app-wide 1 MiB: a
    // sealed result of a model's output is routinely larger than that, and the
    // door has to reach the handler with it. 1.5 MiB of bytes is 2 MiB of
    // base64, so this body is refused outright by the app-wide limit.
    const { server, stub } = build();
    const result = Buffer.alloc(1_500_000, 0x43);
    const issuedAt = now();

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    }, result));

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    expect(res.json().result_cid).toBe(externallyMintedCid(result));
    expect(stub.broadcasts).toHaveLength(1);
  });

  it("refuses a stale settle before a byte of the result is filed", async () => {
    const { server, stub } = build();
    const issuedAt = now() - 601n;

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    }));

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("StaleOp");
    // Not one request reached the store: the bytes were never filed.
    expect(store.requests).toEqual([]);
    expect(stub.simulated).toEqual([]);
  });

  it("400s a settle carrying neither result nor result_cid, naming both", async () => {
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(server, {
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "result", code: "result_required" });
    expect(res.json().error.message).toMatch(/result_cid/);
    expect(stub.simulated).toEqual([]);
  });

  it("400s a settle naming both a result and a result_cid", async () => {
    // Two results do not say which one this settle delivered.
    const { server, stub } = build();
    const issuedAt = now();

    const res = await push(server, settleBody({
      op: "settle",
      job_id: JOB_ID,
      completion_tok: 100,
      issued_at: Number(issuedAt),
      signature: await signSettle(provider, JOB_ID, 100, issuedAt),
      result_cid: UPLOAD_CID,
    }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "result", code: "result_ambiguous" });
    expect(stub.simulated).toEqual([]);
  });

  it("413s a body past this door's own limit, in the error envelope, before reading the chain", async () => {
    // `bodyLimit` is the outermost bound on the body and the only one that acts
    // before it is parsed — which is why there is no decoded cap behind it: a cap
    // applied after `JSON.parse` has already spent the allocation it existed to
    // prevent. Fastify raises its own 413, and `app.ts`'s error handler maps any
    // 4xx `statusCode` onto the `invalid_request` envelope rather than a 500: a
    // caller told "internal error" for its own oversized body would retry it.
    const { server, stub } = build();
    const oversized = `{"op":"settle","job_id":"${JOB_ID}","issued_at":1,"completion_tok":1,` +
      `"result":"${"A".repeat(MAX_BODY_BYTES)}","signature":"0x00"}`;

    const res = await server.inject({
      method: "POST",
      url: "/evm/ops",
      headers: { authorization: `Bearer ${SESSION}`, "content-type": "application/json" },
      payload: oversized,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.type).toBe("invalid_request_error");
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(store.requests).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  /**
   * `result_cid` — the door for a result too large to inline.
   *
   * The cid **is** the `resultCid` argument: the bytes are already in the store,
   * so this path files nothing. What makes it safe is that the upload is scoped
   * to the settling session's own address — a provider cannot settle with a
   * result somebody else uploaded.
   */
  describe("settling with an uploaded result", () => {
    const uploaded = (upload: Partial<Upload> = {}): Map<string, Upload> =>
      new Map([[UPLOAD_CID, { owner: SESSION_ADDRESS, purpose: "result", ...upload }]]);

    const byCid = async (cid = UPLOAD_CID): Promise<Record<string, unknown>> => {
      const issuedAt = now();
      return {
        op: "settle",
        job_id: JOB_ID,
        completion_tok: 100,
        issued_at: Number(issuedAt),
        signature: await signSettle(provider, JOB_ID, 100, issuedAt),
        result_cid: cid,
      };
    };

    it("puts the uploaded cid on chain, attaches the file, and files nothing", async () => {
      const attached: unknown[][] = [];
      const { server, stub } = build({ uploads: uploaded(), attached });

      const res = await push(server, await byCid());

      expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
      expect(res.json().result_cid).toBe(UPLOAD_CID);
      const call = decodeFunctionData({
        abi: jobRegistryAbi,
        data: parseTransaction(stub.broadcasts[0] as Hex).data as Hex,
      });
      expect(call.functionName).toBe("submitAndSettle");
      expect(call.args?.[2]).toBe(`0x${Buffer.from(UPLOAD_CID, "utf8").toString("hex")}`);
      // No second copy of bytes the provider already paid to upload.
      expect(store.requests).toEqual([]);
      expect(attached).toEqual([
        [UPLOAD_CID, SESSION_ADDRESS, "result", config.fileRetentionSeconds],
      ]);
    });

    it("refuses a cid nobody uploaded, a stranger's upload and the wrong purpose alike", async () => {
      const cases: Map<string, Upload>[] = [
        new Map(),
        uploaded({ owner: Buffer.alloc(20, 0xee) }),
        uploaded({ purpose: "input" }),
      ];
      for (const uploads of cases) {
        const { server, stub } = build({ uploads });
        const res = await push(server, await byCid());

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatchObject({
          param: "result_cid",
          code: "unknown_result",
        });
        expect(stub.simulated).toEqual([]);
        expect(stub.broadcasts).toEqual([]);
        await app?.close();
        app = undefined;
      }
    });

    it("relays nothing when the sweep deletes the upload between the lookup and the attach", async () => {
      const { server, stub } = build({ uploads: uploaded(), swept: new Set([UPLOAD_CID]) });

      const res = await push(server, await byCid());

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("unknown_result");
      expect(stub.simulated).toEqual([]);
      expect(stub.broadcasts).toEqual([]);
    });

    it("refuses a result_cid longer than a name this node could have minted", async () => {
      const { server } = build({ uploads: uploaded() });
      const res = await push(server, await byCid("b".repeat(MAX_CID_CHARS + 1)));

      expect(res.statusCode).toBe(400);
      expect(res.json().error.param).toBe("result_cid");
    });
  });

  it("400s a non-integer issued_at rather than rounding it", async () => {
    // A rounded `issued_at` is a signature that will not verify, and the caller
    // would have no way to see why.
    const { server } = build();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: 1.5,
      signature: `0x${"00".repeat(65)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "issued_at" });
  });

  it("400s an issued_at sent as a string: every integer is a JSON integer", async () => {
    const { server } = build();

    const res = await push(server, {
      op: "claim",
      job_id: JOB_ID, issued_at: String(now()),
      signature: `0x${"00".repeat(65)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "issued_at", type: "invalid_request_error" });
  });

  it("names the ops it knows when op is none of them", async () => {
    const { server } = build();

    const res = await push(server, { op: "reclaim", signature: `0x${"00".repeat(65)}` });

    expect(res.json().error).toMatchObject({
      param: "op",
      message: "op must be one of claim, settle, fail, set_identity, request_capacity",
    });
  });

  it("401s a malformed body with no session: the gate answers before the shape", async () => {
    const { server } = build();

    const res = await push(server, { op: "claim", job_id: "0x01" }, null);

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ type: "authentication_error" });
  });
});
