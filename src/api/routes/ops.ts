import type { FastifyReply } from "fastify";
import { Type, type Static } from "typebox";
import {
  encodeFunctionData,
  recoverTypedDataAddress,
  type Abi,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { jobRegistryAbi } from "../../abi/jobRegistry.js";
import { providerRegistryAbi } from "../../abi/providerRegistry.js";
import { atFloor, floorMemo, type Chain } from "../../chain/client.js";
// `atFloor` pins the `/evm/ops` simulate (see `simulateThenRelay`); `floorMemo`
// serves the claim gates' state reads.
import { decodeRevert, isVerdict } from "../../chain/revert.js";
import type { Address } from "../../config.js";
import type { Db } from "../../db/db.js";
import { decodeLog } from "../../index/decode.js";
import { applyEvent } from "../../index/reducer.js";
import { repairOnRefusal } from "../../index/reconcile.js";
import { dropLease, HELD, takeForClaim, type ClaimableOrder } from "../../match/held.js";
import { pinnerFor, put, type Pinner } from "../../pin/pinner.js";
import { sendFailure, viewRead } from "../chain-failure.js";
import { ApiError } from "../errors.js";
import { MAX_BODY_BYTES } from "../limits.js";
import {
  addressOf,
  chainGate,
  requireChain,
  resolveProviderId,
  sessionGate,
  sessionOf,
  type App,
  type RouteDeps,
} from "../deps.js";
import { throughPinner } from "../pin-failure.js";
import { subjectQueue } from "../queue.js";
import {
  EIP712_NAMES,
  lockOf,
  readExitTerms,
  taskCidHex,
  type ExitTerms,
  type Terms,
} from "../../orders.js";
import {
  Address as AddressIn,
  Base64,
  BEARER,
  Cid,
  errors,
  Hex as HexIn,
  Hex32,
  HexOut,
  Int,
  SafeUint,
  Sig65,
  Uint32,
  Usd,
} from "../schemas/common.js";
import { usdParam } from "../usd.js";
import { attachFile, findUpload } from "./files.js";

/**
 * `POST /evm/ops` — the one op door — and `POST /evm/simulate/claim`, the
 * advisory gate a daemon consults before it signs anything.
 *
 * ## What the node is, and is not
 *
 * **The node never signs an actor's op.** It cannot, and that is a property of
 * the contracts rather than a policy here: every actor mutation on this chain is
 * authorised by an embedded signature and never by `msg.sender`, and the relayer
 * key answers to no registry id. The relayer pays gas. That is the whole of its
 * role.
 *
 * **Authority is the op signature; the session is a transport gate only.** A
 * valid session is never sufficient to relay an op somebody else signed — the
 * session's address and the recovered signer are deliberately never compared,
 * because comparing them would imply the session carried an authority it does
 * not have. What refuses a forged op is the same thing that refuses it on chain.
 *
 * ## What the node adds to an op
 *
 * The bodies a daemon sends carry the op's own signed fields and nothing else.
 * The node supplies the rest from the job's row: `claim` carries the client's
 * signed order, which only this node holds until the claim puts it on chain
 * (`match/held.ts`), and `submitAndSettle` and `fail` carry the job's
 * {@link ExitTerms}, which the contract checks against the hash it stored at
 * claim, including the relayer `Claimed` named. A claim on an order this node
 * does not hold is refused `NotOpen`; a settle or fail on a job it has no row
 * for, or whose `Claimed` it has not indexed, `NotClaimed`.
 *
 * ## Simulate before every relay
 *
 * Every op is `eth_call`ed **as the exact transaction that would be sent, from
 * the relayer's own address**, before a single wei of gas is spent. A revert
 * answers `409 {ok:false, reason:"<contract error name>"}` and relays nothing.
 * This is not the same check as `/evm/simulate/claim`: that one reads views and
 * is advisory. Neither check is ever removed for the other.
 *
 * ## What this door answers, and what each answer promises (R57, R72)
 *
 * ## The result rides with the settle
 *
 * Every body on this door is flat JSON. `result_cid` as the caller's own choice
 * of name is gone: a `settle` carries the op's fields — `op`, `job_id`,
 * `prompt_tok`, `cached_tok`, `completion_tok`, `rate_in_cached`, `issued_at`,
 * `signature` — plus exactly one of
 *
 *   * `result` — the sealed bytes, base64, which this node files itself;
 *   * `result_cid` — the cid of a `POST /v1/files` upload with `purpose=result`
 *     made by this session's own address, for a result too large to inline.
 *
 * Either way the name that reaches `submitAndSettle` is one **this node** put in
 * the store. It is not signed — it did not exist when the op was signed — and
 * there is **no commitment on this path**: the task side has `c`, and the result
 * side has nothing equivalent. This door invents none, deliberately. Anything it
 * made up would be a check on bytes the same party chose, which proves nothing,
 * and dressing the gap up is worse than naming it: the result is sealed to the
 * owner's key, so a client that cannot open what it fetched knows immediately,
 * and that is the answer.
 *
 * The other four ops carry no content at all.
 *
 * ```
 * 201 {tx_hash, status, block_number}   relayed and mined
 * 201 {…, result_cid}                   settle only: the name this node minted
 * 400 invalid_request_error             the request is malformed          not retryable
 * 400 unknown_result                    result_cid names no result upload not retryable
 *                                       of this session's address
 * 401 authentication_error              no session                        not retryable
 * 403 invalid_op_signature              the signature recovers to nobody  not retryable
 * 409 {ok:false, reason, raw?}          THE CHAIN REFUSED IT              not retryable
 * 413 body_too_large                   body past MAX_BODY_BYTES         not retryable
 * 429 busy                              too many ops queued on one subject    RETRYABLE
 * 503 pinner_unavailable {code}         the bytes could not be filed          RETRYABLE
 * 503 relay_unavailable  {code}         the NODE could not relay it           RETRYABLE
 * 503 chain_unreachable                 nothing answered at all               RETRYABLE
 * 504 receipt_timeout                   broadcast, no receipt in time     not retryable
 * ```
 *
 * `result_cid` on the success body is the only way a claimant learns the name of
 * what it delivered: this node mints it, and nothing the caller holds can predict
 * it. The four ops that file nothing carry no such field.
 *
 * The `409` and the two `503`s are the distinction this door exists to get
 * right, and it is drawn by {@link isVerdict}: a `409` is the chain pronouncing
 * on the op, which is why it is not retryable. **A failure to reach the chain is
 * never a `409`** — every op is relayed with the node's own money, so a dead
 * endpoint, a rate limit or an empty relayer wallet is the node's failure and
 * answers `503`, retryably, with a `code` naming which. Reporting one of those
 * as a verdict tells a provider daemon its `settle` was refused by the chain and
 * that retrying is pointless; both are false, and the op is simply lost.
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The largest `evidence` this door relays, in bytes.
 *
 * `IdentityUpdated.evidence` is arbitrary provider-written bytes and the
 * contract bounds it only by gas — R50a measured ~32 kB reachable for roughly
 * 1 M gas, which is also the size at which it wedged the reducer. Relaying more
 * than that would mean the node fronting gas for a value it has already decided
 * it will store as `{"raw":"0x…"}`. This is the bound and there is no way past
 * it: every write path here builds its own calldata, so no caller can put bytes
 * on chain that this node did not size first.
 */
const MAX_EVIDENCE_BYTES = 32_768;

/**
 * How many callers may be queued behind one op's subject.
 *
 * The mechanism, and the reason it refuses rather than queues without limit, now
 * live in `api/queue.ts` — one definition shared with the post door, rather than
 * two copies of an admission-control policy that would drift. Re-exported under
 * this door's own name so the test that pins the `429 busy` path is written
 * against the bound rather than against a number copied out of here (R67).
 */
export { MAX_QUEUE_DEPTH as MAX_OP_QUEUE_DEPTH } from "../queue.js";

/** How long the node waits for a relayed op's receipt. See `routes/relay.ts`. */
const RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Job ops are fresh within ±600 s **inclusive**, against the node's clock.
 *
 * Two staleness regimes exist and they are not the same (R24, R33). This is the
 * job-op one: no nonce, because the one-shot state machine is the replay guard,
 * and the window's only job is to stop a withheld op from landing at a moment
 * its signer did not choose. The registry-op regime is a strictly monotonic
 * per-op floor plus a skew ceiling, and it lives in {@link registryFloor}.
 *
 * The node's clock is a pre-check and the chain is authoritative, so no margin
 * is added on either side (R24): the pre-relay simulate catches a boundary miss
 * and answers with the chain's own `StaleOp`.
 */
const JOB_OP_WINDOW_SECONDS = 600n;

/** The skew ceiling the registries apply to a registry op's `issuedAt`. */
const REGISTRY_OP_SKEW_SECONDS = 3600n;

// ---------------------------------------------------------------------------
// The five ops
// ---------------------------------------------------------------------------

const OP_NAMES = ["claim", "settle", "fail", "set_identity", "request_capacity"] as const;
type OpName = (typeof OP_NAMES)[number];

/** Which registry's EIP-712 domain an op is signed against, and which floor it obeys. */
type Registry = "job" | "provider";

/**
 * One parsed, validated op: everything needed to recover its signer and to build
 * the transaction, and nothing that depends on who is asking.
 */
interface ParsedOp {
  name: OpName;
  registry: Registry;
  /** The EIP-712 primary type, spelled as the contract's typehash spells it. */
  primaryType: string;
  types: Record<string, readonly { name: string; type: string }[]>;
  message: Record<string, unknown>;
  issuedAt: bigint;
  /** `null` for the two registry ops. */
  jobId: Hex | null;
  /**
   * The result bytes this op carries and this node must file, or `null`.
   *
   * `settle` is the only op that can carry any, and it carries either these or
   * {@link ParsedOp.resultCid} — never both and never neither. The name goes on
   * chain, so the calldata cannot be built until the pin has completed; every
   * other op builds its calldata from the request alone and ignores the CID it
   * is handed.
   */
  toPin: Buffer | null;
  /** The cid of an upload this settle references instead of inlining. */
  resultCid: string | null;
  /**
   * Builds the calldata once the signature is known to be well-formed.
   *
   * Each builder throws on a context member it needs and was not handed, rather
   * than encoding an empty one: the contract would refuse it anyway, and paying
   * an `eth_call` to be told so would mean this node had built a transaction it
   * knew was wrong.
   */
  calldata: (signature: Hex, context: OpContext) => Hex;
}

/** What the node supplies to an op's calldata beyond the op's own fields. */
interface OpContext {
  /** The name the pin returned; `null` for every op that pins nothing. */
  mintedCid: string | null;
  /** `claim`'s held order. */
  order: ClaimableOrder | null;
  /** The exit terms `submitAndSettle` and `fail` pass back. */
  terms: ExitTerms | null;
}

/** One built-op context member, or a loud failure when the route forgot it. */
function needed<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} calldata was built without it`);
  return value;
}

/**
 * The EIP-712 domain both registries declare: `VORQ` version `2`, over the
 * verifying contract itself.
 *
 * Version **2**, and not the `1` of the session handshake. That difference is
 * deliberate and load-bearing: the handshake is an off-chain auth artifact and
 * must live in a namespace the chain will never accept, so a captured login can
 * never be replayed as an op.
 */
const opDomain = (registry: "job" | "provider", chainId: number, verifyingContract: Address) =>
  ({ name: EIP712_NAMES[registry], version: "2", chainId, verifyingContract }) as const;

/**
 * The five ops' EIP-712 type tables, in one place.
 *
 * Declared once rather than inline per `case` below: `Claim`, `Fail` and the
 * job-id half of `Settle` are the same two members, and three copies of
 * `{ name: "jobId", type: "bytes32" }` are three chances to edit one and not the
 * others. A member renamed or reordered recovers a different address and the op
 * is refused with no error naming the cause, so `test/signing-vectors.test.ts`
 * asserts this map against the contracts' own committed vectors.
 *
 * `Claim` and `Fail` are byte-identical here on purpose — only the primary type
 * NAME separates their digests, which is precisely why that pair is dangerous.
 */
export const OP_TYPES = {
  Claim: {
    Claim: [
      { name: "jobId", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
  // No `resultCid`: the provider hands the result to this node, which pins it and
  // learns the name from the storage service — a name that does not exist when
  // the op is signed.
  Settle: {
    Settle: [
      { name: "jobId", type: "bytes32" },
      { name: "promptTok", type: "uint32" },
      { name: "cachedTok", type: "uint32" },
      { name: "completionTok", type: "uint32" },
      { name: "rateInCached", type: "uint128" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
  Fail: {
    Fail: [
      { name: "jobId", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
  SetIdentity: {
    SetIdentity: [
      { name: "boxKey", type: "bytes32" },
      { name: "evidence", type: "bytes" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
  RequestCapacity: {
    RequestCapacity: [
      { name: "n", type: "uint32" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
} as const;

/** Which registry's domain verifies each op — the only place an op names an address. */
export const OP_REGISTRY = {
  Claim: "job",
  Settle: "job",
  Fail: "job",
  SetIdentity: "provider",
  RequestCapacity: "provider",
} as const;

/**
 * How a settle carries its result: the bytes, or the name of an upload that
 * already holds them. **Exactly one.**
 *
 * Neither is `result_required` — `EmptyResultCid` guards the chain against a
 * missing name and nothing guards it against a name for nothing, because the cid
 * of zero bytes is a perfectly valid cid — and both is `result_ambiguous`,
 * because a settle naming two results does not say which one it delivered.
 *
 * `result` has no decoded cap: {@link MAX_BODY_BYTES} is the bound, for the reason
 * written there.
 */
function parseResult(body: SettleOp): { toPin: Buffer | null; resultCid: string | null } {
  const inline = body.result !== undefined;
  const byCid = body.result_cid !== undefined;
  if (inline && byCid) {
    throw new ApiError(
      400,
      "invalid_request",
      "send exactly one of result and result_cid",
      "result",
      "result_ambiguous",
    );
  }
  if (body.result !== undefined) return { toPin: Buffer.from(body.result, "base64"), resultCid: null };
  if (body.result_cid !== undefined) return { toPin: null, resultCid: body.result_cid };
  throw new ApiError(
    400,
    "invalid_request",
    "a settle carries its result: send either result (the sealed bytes, base64) or result_cid " +
      "(the cid of a POST /v1/files upload with purpose=result). This node files the bytes and " +
      "puts the name it mints into submitAndSettle",
    "result",
    "result_required",
  );
}

const IssuedAt = SafeUint({
  description: "Unix seconds. Job ops: within ±600 s of this node's clock; registry ops: above the last.",
});
const JobId = Hex32();

const ClaimOp = Type.Object({ op: Type.Literal("claim"), job_id: JobId, issued_at: IssuedAt, signature: Sig65() });

const SettleOp = Type.Object({
  op: Type.Literal("settle"),
  job_id: JobId,
  // The backend's own counts, never estimates. The chain clamps each:
  // prompt_tok to units_in, cached_tok to prompt_tok, completion_tok to
  // units_out, rate_in_cached to rate_in.
  prompt_tok: Uint32({ description: "The backend's prompt tokens (media: the order's units_in)." }),
  cached_tok: Uint32({ description: "The cached share of prompt_tok; 0 when the backend reports none." }),
  completion_tok: Uint32({ description: "The delivered output units." }),
  rate_in_cached: Usd({ description: "USD per 1M cached prompt tokens; at most the job's rate_in." }),
  // Bounded at the width a name this node put on chain can have: a longer one
  // is not a cid any upload of this node's carries, so it can only miss.
  result: Type.Optional(
    Base64(undefined, {
      description: "The sealed result, base64. Exactly one of `result` and `result_cid`.",
      minLength: 4,
      error: { message: "must be non-empty canonical padded base64" },
    }),
  ),
  result_cid: Type.Optional(Cid({ description: "A `POST /v1/files` upload with `purpose=result`." })),
  issued_at: IssuedAt,
  signature: Sig65(),
});
type SettleOp = Static<typeof SettleOp>;

const FailOp = Type.Object({ op: Type.Literal("fail"), job_id: JobId, issued_at: IssuedAt, signature: Sig65() });

const SetIdentityOp = Type.Object({
  op: Type.Literal("set_identity"),
  box_key: Hex32({ description: "The X25519 key designated orders are sealed to." }),
  // `bytes`, not text: nothing on chain makes it JSON (R20), so it travels as
  // hex and the node reproduces it byte for byte.
  evidence: HexIn(MAX_EVIDENCE_BYTES),
  issued_at: IssuedAt,
  signature: Sig65(),
});

const RequestCapacityOp = Type.Object({
  op: Type.Literal("request_capacity"),
  n: Uint32({ description: "Concurrent jobs requested." }),
  issued_at: IssuedAt,
  signature: Sig65(),
});

/** One op, told apart by `op`. */
const OpBody = Type.Unsafe<
  | Static<typeof ClaimOp>
  | SettleOp
  | Static<typeof FailOp>
  | Static<typeof SetIdentityOp>
  | Static<typeof RequestCapacityOp>
>({
  type: "object",
  required: ["op"],
  discriminator: { propertyName: "op" },
  oneOf: [ClaimOp, SettleOp, FailOp, SetIdentityOp, RequestCapacityOp],
});
type OpBody = Static<typeof OpBody>;

const OpRelayed = Type.Object({
  tx_hash: HexOut(),
  status: Type.String({ description: "The receipt status: `success` or `reverted`." }),
  block_number: Int(),
  result_cid: Type.Optional(Type.String({ description: "Settle only: the name this node filed the result under." })),
});

/** `409`: the chain refused it, relayed nothing. Not retryable. */
export const OpRefused = Type.Object({
  ok: Type.Literal(false),
  reason: Type.String({ description: "The contract error name, or `unknown`." }),
  raw: Type.Optional(HexOut("The revert bytes, only when `reason` is `unknown`.")),
});

const SimulateResult = Type.Union([
  Type.Object({ ok: Type.Literal(true) }),
  Type.Object({ ok: Type.Literal(false), reason: Type.String() }),
]);

/**
 * The validated body of `op`, to the contract's field names and widths.
 *
 * The type strings are the contracts' typehash strings, member for member:
 * `Claim(bytes32 jobId,uint64 issuedAt)`,
 * `Settle(bytes32 jobId,uint32 promptTok,uint32 cachedTok,uint32 completionTok,uint128 rateInCached,uint64 issuedAt)`,
 * `Fail(bytes32 jobId,uint64 issuedAt)`,
 * `SetIdentity(bytes32 boxKey,bytes evidence,uint64 issuedAt)`,
 * `RequestCapacity(uint32 n,uint64 issuedAt)`. A member renamed or reordered
 * here recovers a different address and the op is refused, which is a silent
 * failure — so this list is written against the vendored ABI and the contract
 * source, not from memory.
 *
 * **`resultCid` is not a member of `Settle` any more**, and the ABI cannot tell
 * you that: `submitAndSettle` takes the CID outside the signed `Usage` tuple, so
 * regenerating the ABI carries none of this. The provider hands the result to
 * this node, which pins it and learns the name from the storage service — a name
 * that does not exist when the op is signed. The consequence is stated rather
 * than glossed: unlike the task side there is **no commitment standing behind the
 * result**, no `c` to check the bytes against, and this door invents none. The
 * settle signature attests the metered usage and nothing about which bytes
 * produced it.
 *
 * `decimals` converts `rate_in_cached` from USD to the atomic rate it is signed as.
 */
function parseOp(body: OpBody, decimals: number): ParsedOp {
  const issuedAt = BigInt(body.issued_at);

  switch (body.op) {
    case "claim": {
      const hex = body.job_id.toLowerCase() as Hex;
      return {
        name: body.op,
        registry: "job",
        primaryType: "Claim",
        types: OP_TYPES.Claim,
        message: { jobId: hex, issuedAt },
        issuedAt,
        jobId: hex,
        toPin: null,
        resultCid: null,
        calldata: (signature, { order }) => {
          const held = needed(order, "the held order: claim");
          return encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "claim",
            args: [orderArg(held), held.owner, held.orderSig, issuedAt, signature],
          });
        },
      };
    }

    case "settle": {
      const hex = body.job_id.toLowerCase() as Hex;
      const promptTok = BigInt(body.prompt_tok);
      const cachedTok = BigInt(body.cached_tok);
      const completionTok = BigInt(body.completion_tok);
      const rateInCached = usdParam(body.rate_in_cached, decimals, "rate_in_cached", true);
      const { toPin, resultCid } = parseResult(body);
      return {
        name: body.op,
        registry: "job",
        primaryType: "Settle",
        types: OP_TYPES.Settle,
        message: { jobId: hex, promptTok, cachedTok, completionTok, rateInCached, issuedAt },
        issuedAt,
        jobId: hex,
        toPin,
        resultCid,
        calldata: (signature, { mintedCid, terms }) => {
          if (mintedCid === null) {
            throw new Error("settle calldata was built before the result was pinned");
          }
          // A CID is text by construction, so it is encoded UTF-8 — exactly what
          // the projection decodes back out of `result_cid`.
          const cidHex: Hex = `0x${Buffer.from(mintedCid, "utf8").toString("hex")}`;
          return encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "submitAndSettle",
            args: [
              hex,
              needed(terms, "the exit terms: settle"),
              {
                promptTok: Number(promptTok),
                cachedTok: Number(cachedTok),
                completionTok: Number(completionTok),
                rateInCached,
              },
              cidHex,
              issuedAt,
              signature,
            ],
          });
        },
      };
    }

    case "fail": {
      const hex = body.job_id.toLowerCase() as Hex;
      return {
        name: body.op,
        registry: "job",
        primaryType: "Fail",
        types: OP_TYPES.Fail,
        message: { jobId: hex, issuedAt },
        issuedAt,
        jobId: hex,
        toPin: null,
        resultCid: null,
        calldata: (signature, { terms }) =>
          encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "fail",
            args: [hex, needed(terms, "the exit terms: fail"), issuedAt, signature],
          }),
      };
    }

    case "set_identity": {
      const boxKeyHex = body.box_key.toLowerCase() as Hex;
      const evidenceArg = body.evidence as Hex;
      return {
        name: body.op,
        registry: "provider",
        primaryType: "SetIdentity",
        types: OP_TYPES.SetIdentity,
        message: { boxKey: boxKeyHex, evidence: evidenceArg, issuedAt },
        issuedAt,
        jobId: null,
        toPin: null,
        resultCid: null,
        calldata: (signature) =>
          encodeFunctionData({
            abi: providerRegistryAbi,
            functionName: "setIdentity",
            args: [boxKeyHex, evidenceArg, issuedAt, signature],
          }),
      };
    }

    case "request_capacity": {
      const n = BigInt(body.n);
      return {
        name: body.op,
        registry: "provider",
        primaryType: "RequestCapacity",
        types: OP_TYPES.RequestCapacity,
        message: { n, issuedAt },
        issuedAt,
        jobId: null,
        toPin: null,
        resultCid: null,
        calldata: (signature) =>
          encodeFunctionData({
            abi: providerRegistryAbi,
            functionName: "requestCapacity",
            args: [Number(n), issuedAt, signature],
          }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const ABIS: readonly Abi[] = [jobRegistryAbi as Abi, providerRegistryAbi as Abi];

/**
 * How long a claim holds its order's lease while it is relayed: the relayer
 * queue's wait, the simulate, the send and the receipt, with room to spare. The
 * lease is what `cancelHeld` reads to refuse a cancel under a claim in flight.
 */
const CLAIM_HOLD_MS = 2 * RECEIPT_TIMEOUT_MS;

/** The `Order` struct `claim` takes, from a held order. */
const orderArg = (held: ClaimableOrder) => ({
  c: held.terms.c,
  modelId: Number(held.terms.modelId),
  slaSecs: Number(held.terms.slaSecs),
  rateIn: held.terms.rateIn,
  rateOut: held.terms.rateOut,
  unitsIn: Number(held.terms.unitsIn),
  unitsOut: Number(held.terms.unitsOut),
  designated: Number(held.terms.designated),
  expiresAt: held.terms.expiresAt,
  taskCid: taskCidHex(held.taskCid),
});

/**
 * The locks of the claims this node is relaying right now, per owner.
 *
 * `balanceOf` at the floor does not yet show a claim that is broadcast and not
 * mined, so two claims on one owner's orders, relayed a moment apart, both read
 * the same balance — and the second, short, reverts `InsufficientDeposit`
 * **after the relayer has paid for it**. Counting the first's lock against the
 * second's gate refuses that one for free instead. An entry lives from the
 * gate to the receipt: by then the floor has reached the claim's block, and the
 * balance read there is net of its lock.
 *
 * **The check and the entry are one synchronous step** ({@link reserve}), taken
 * after the balance read resolves. Two concurrent claims are handed the same
 * memoised read, so a check made before an `await` and an entry added after it
 * would let both pass on one balance.
 *
 * Process memory, like the relayer's own queue: one relayer account is one
 * process's to send from.
 */
class ClaimsInFlight {
  private readonly byOwner = new Map<string, Map<Hex, bigint>>();

  /** Whether `balance` covers `lock` once this owner's other claims in flight are counted. */
  covers(owner: Address, jobId: Hex, lock: bigint, balance: bigint): boolean {
    let pending = 0n;
    for (const [other, held] of this.byOwner.get(owner.toLowerCase()) ?? []) {
      if (other !== jobId) pending += held;
    }
    return balance - pending >= lock;
  }

  /**
   * {@link covers}, and when it does, the lock recorded in the same step. `null`
   * when it does not; otherwise the function that removes the entry.
   */
  reserve(owner: Address, jobId: Hex, lock: bigint, balance: bigint): (() => void) | null {
    if (!this.covers(owner, jobId, lock, balance)) return null;
    return this.add(owner, jobId, lock);
  }

  private add(owner: Address, jobId: Hex, lock: bigint): () => void {
    const key = owner.toLowerCase();
    const locks = this.byOwner.get(key) ?? new Map<Hex, bigint>();
    locks.set(jobId, lock);
    this.byOwner.set(key, locks);
    return () => {
      locks.delete(jobId);
      if (locks.size === 0 && this.byOwner.get(key) === locks) this.byOwner.delete(key);
    };
  }
}

/** A refusal the claim gates make, in the chain's own vocabulary where it has one. */
type GateRefusal = { reason: string };

export function opsRoutes(app: App, deps: RouteDeps): void {
  /** The claim gates' view reads, one per distinct read per floor block. */
  const claimReads = floorMemo();
  const serialized = subjectQueue("ops");
  const pinner: Pinner = pinnerFor(deps.config, deps.db);
  const claiming = new ClaimsInFlight();

  // Reconcile-on-error, hung on the refusal rather than on the route (R3/R4).
  const repair = repairOnRefusal(
    deps.chain,
    deps.db,
    deps.config.addresses.jobRegistry,
    (error, jobId, reason) =>
      app.log.error({ err: error, jobId, reason }, "reconcile-on-refusal failed"),
  );

  /** A view read at the floor, remembered for the floor block, classified as a read (R77). */
  const read = <T>(chain: Chain, abi: Abi, at: Address, functionName: string, args: unknown[]): Promise<T> =>
    viewRead("claim_simulate_read", () =>
      claimReads(
        chain,
        `${at}:${functionName}:${args.map(String).join(",")}`,
        (pin) => chain.publicClient.readContract({ address: at, abi, functionName, args, ...pin }) as Promise<T>,
      ),
    );

  /**
   * The reads behind the two claim gates the chain's own state answers and the
   * order's signature cannot: whether the gas fee this order was quoted at is
   * the live one, and — for the caller to decide against this owner's claims in
   * flight — its lock and the owner's balance.
   *
   * A different gas fee is refused rather than claimed: `claim` locks the live
   * fee, and the client accepted the quoted one.
   */
  async function fundsGate(
    chain: Chain,
    owner: Address,
    terms: Terms,
    quotedGasFee: bigint,
  ): Promise<GateRefusal | { lock: bigint; balance: bigint }> {
    const { jobRegistry } = deps.config.addresses;
    const [gasFee, feeBps] = await Promise.all([
      read<bigint>(chain, jobRegistryAbi as Abi, jobRegistry, "gasFee", []),
      read<number>(chain, jobRegistryAbi as Abi, jobRegistry, "feeBps", []),
    ]);
    if (BigInt(gasFee) !== quotedGasFee) return { reason: "GasFeeChanged" };
    const lock = lockOf(terms, Number(feeBps), quotedGasFee);
    const balance = await read<bigint>(chain, jobRegistryAbi as Abi, jobRegistry, "balanceOf", [owner]);
    return { lock, balance: BigInt(balance) };
  }

  app.post(
    "/evm/ops",
    {
      bodyLimit: MAX_BODY_BYTES,
      // Transport gate only, and ahead of the body: nothing before it can tell an
      // unauthenticated caller about chain state or about what a well-formed op
      // looks like. The bound on what such a request makes this process allocate
      // is `MAX_BODY_BYTES`, which acts before any hook.
      onRequest: [chainGate(deps.chain), sessionGate(deps.db)],
      schema: {
        tags: ["ops"],
        summary: "Relay a provider op",
        description:
          "claim, settle, fail, set_identity or request_capacity, each signed over its registry's " +
          "own EIP-712 domain. Simulated as the exact transaction before any gas is spent; a revert " +
          "answers `409 {ok:false, reason}` and relays nothing. The session is a transport gate only.",
        security: BEARER,
        body: OpBody,
        response: {
          201: OpRelayed,
          409: OpRefused,
          ...errors(400, 401, 403, 413, 429, 503, 504),
        },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const session = sessionOf(request);
    const { signature } = request.body;
    const op = parseOp(request.body, deps.config.addresses.decimals);

    const registryAddress =
      op.registry === "job"
        ? deps.config.addresses.jobRegistry
        : deps.config.addresses.providerRegistry;

    // ---- staleness, regime by regime (R24, R33) ---------------------------

    // Job ops: ±600 s inclusive against the node's clock. Cheap, needs no RPC,
    // and refuses an op the chain would refuse anyway — the point is to refuse
    // it before spending an `eth_call` on it, not to be the authority.
    if (op.registry === "job") {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const behind = op.issuedAt + JOB_OP_WINDOW_SECONDS < now;
      const ahead = op.issuedAt > now + JOB_OP_WINDOW_SECONDS;
      if (behind || ahead) return refused(reply, { reason: "StaleOp", raw: null });
    }

    // ---- who signed it ----------------------------------------------------

    let signer: string;
    try {
      // The whole argument is cast in one place: viem infers `message` from a
      // *literal* `types`, and this one is chosen at runtime from five. The cast
      // buys nothing dangerous — every field was validated above — and casting
      // the object rather than each member keeps the shape visible.
      signer = await recoverTypedDataAddress({
        domain: opDomain(op.registry, deps.config.addresses.chainId, registryAddress),
        types: op.types,
        primaryType: op.primaryType,
        message: op.message,
        signature: signature as Hex,
      } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    } catch {
      throw invalidOpSignature();
    }

    const signerBytes = Buffer.from(signer.slice(2), "hex");
    const providerId = await resolveProviderId(deps, signerBytes);
    // A signer that resolves to no registry id can never authorise anything on
    // either registry, so this is refused here rather than by burning an
    // `eth_call` on a call the chain will certainly revert.
    if (providerId === 0n) throw invalidOpSignature();

    // Registry ops: a strictly monotonic per-op floor plus a skew ceiling — a
    // different regime from the job ops above, and conflating the two is the
    // failure mode R33 exists to name.
    if (op.registry === "provider") {
      // **No `catch` here, and that is the whole handling** — the read inside
      // `registryFloor` is a `viewRead`, so its failure arrives already
      // classified as an `ApiError` and travels to the error handler untouched,
      // exactly as the advisory gate's six reads and `resolveProviderId` do.
      // Routing it back through `chainFailure` would re-classify a decided
      // answer with a function that expects a raw endpoint error: a revert *is*
      // an `isVerdict`, which is how this read used to answer `409
      // reason:"unknown"` for a fault that is the node's. Dead endpoint and rate
      // limit are unchanged — `viewRead` passes every non-verdict through
      // `sendFailure`, the same classification `chainFailure` reached for them.
      const floor = await registryFloor(
        chain,
        deps.config.addresses.providerRegistry,
        op,
        providerId,
      );
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (op.issuedAt <= floor || op.issuedAt > now + REGISTRY_OP_SKEW_SECONDS) {
        return refused(reply, { reason: "StaleOp", raw: null });
      }
    }

    // ---- the result, for a settle -----------------------------------------

    // Looked up after every refusal the op's fields can earn, so a refused
    // settle costs no read. A miss, a stranger's upload, an upload under another
    // purpose and an upload the sweep has just deleted are the same answer,
    // deliberately: the cid is the whole reference, so a distinguishable "that
    // file is someone else's" would turn this door into an oracle for which cids
    // exist.
    const resultUpload =
      op.resultCid === null
        ? null
        : await findUpload(deps.db, {
            cid: op.resultCid,
            owner: session.address,
            purpose: "result",
          });
    if (op.resultCid !== null && resultUpload === null) throw unknownResult(op.resultCid);

    // Job ops are read back through the job; the two registry ops through the
    // provider row this signature resolved to.
    const resume =
      op.jobId === null ? `GET /evm/providers/${providerId}` : `GET /v1/jobs/${op.jobId}`;
    const relay = async (): Promise<FastifyReply> => {
      const jobId = op.jobId;
      const context: OpContext = { mintedCid: null, order: null, terms: null };
      let onReceipt: ((receipt: TransactionReceipt) => Promise<void>) | undefined;
      let settled = (): void => undefined;

      try {
        // ---- what the node adds: the held order, or the exit terms ----------

        if (op.name === "claim" && jobId !== null) {
          // Locked, and the claimant's lease written over it, so an owner's cancel
          // cannot end the row under a claim in flight (`cancelHeld`).
          const order = await takeForClaim(deps.db, jobId, providerId, CLAIM_HOLD_MS);
          if (order === null) return refused(reply, { reason: "NotOpen", raw: null });
          const gate = await fundsGate(chain, order.owner, order.terms, order.gasFee);
          // The check against the claims in flight and this claim's entry, in one
          // step with no `await` between them; released in the `finally` below.
          const reserved =
            "reason" in gate ? null : claiming.reserve(order.owner, jobId, gate.lock, gate.balance);
          if (reserved === null) {
            await dropLease(deps.db, jobId, providerId);
            return refused(reply, { reason: "reason" in gate ? gate.reason : "InsufficientDeposit", raw: null });
          }
          settled = reserved;
          context.order = order;
          // The row takes the claim from the receipt, before the answer goes out:
          // the owner's `reserved` stops counting this order the moment its lock
          // is on chain, and the book stops offering it.
          onReceipt = (receipt) => markClaimed(deps.db, deps.config.addresses.jobRegistry, receipt);
        } else if ((op.name === "settle" || op.name === "fail") && jobId !== null) {
          context.terms = await readExitTerms(deps.db, jobId);
          if (context.terms === null) return refused(reply, { reason: "NotClaimed", raw: null });
        }

        // ---- the result, for a settle ----------------------------------------

        // **The bytes are filed inside the queue and immediately before the
        // simulate**, so the ordering that matters holds: the result is stored
        // before the transaction naming it is broadcast, and a pin that fails
        // relays nothing.
        //
        // A relay that fails after a successful pin leaves an orphan object and no
        // chain state. That is the cheap direction and it is retry-safe: the store
        // names the same bytes the same way, so a retried settle lands on the
        // same name and one `pins` row, and the contract's one-shot state machine
        // refuses a second `settle` on a job that already settled. Nothing is
        // charged twice and nothing is duplicated, which is what makes
        // `x-vorq-retryable: true` on the failure honest (R57, R70).
        const toPin = op.toPin;
        if (toPin !== null) {
          context.mintedCid = await throughPinner(request, () => put(pinner, toPin));
        } else if (op.resultCid !== null) {
          // The upload stops being storage this node owes nobody and starts being
          // a settled job's result. `false` means the sweep's 300 s window closed
          // on it between the lookup and here, so there is nothing left to name
          // and nothing is relayed.
          const attached = await attachFile(
            deps.db,
            { cid: op.resultCid, owner: session.address, purpose: "result" },
            deps.config.fileRetentionSeconds,
          );
          if (!attached) throw unknownResult(op.resultCid);
          context.mintedCid = op.resultCid;
        }
        const data = op.calldata(signature as Hex, context);
        return await simulateThenRelay(
          chain,
          registryAddress,
          data,
          reply,
          resume,
          async (reason) => {
            if (op.name === "claim" && jobId !== null) await dropLease(deps.db, jobId, providerId);
            await repair(jobId)(reason);
          },
          context.mintedCid === null ? {} : { result_cid: context.mintedCid },
          onReceipt,
        );
      } finally {
        settled();
      }
    };

    // `(op, job_id)` for a job op, `(op, provider_id)` for a registry op — the
    // key R66 specifies. It closes the duplicate-submission case exactly: two
    // identical ops share a key, so the second re-simulates against the state
    // the first produced and is refused for free.
    //
    // Named, not closed: a `settle` racing a `fail` on one job takes two
    // different keys and is still two broadcasts, one of which the contract's
    // one-shot state machine reverts after paying. That is a caller
    // contradicting itself rather than a caller retrying, it is not reachable by
    // accident, and widening the key to `job_id` alone would serialise a claim
    // behind an unrelated settle for the same job.
    //
    // A queue that refuses (`429 busy`) does so before the section runs, so
    // nothing has been filed for it.
    return serialized(`${op.name}:${op.jobId ?? providerId}`, relay);
  });

  app.post(
    "/evm/simulate/claim",
    {
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["ops"],
        summary: "Would a claim land?",
        description:
          "The advisory gate a daemon consults before it signs: the held order from this node, the " +
          "gates from chain view reads at the node's floor, in the contract's own order. The funds " +
          "gate answers `InsufficientDeposit` when the owner's balance, less its other claims in " +
          "flight, does not cover the lock; `GasFeeChanged` when the order was quoted at another gas " +
          "fee. `/evm/ops` simulates the claim itself.",
        body: Type.Object({ job_id: Hex32(), address: AddressIn({ description: "The operator." }) }),
        response: { 200: SimulateResult, ...errors(400, 503) },
      },
    },
    async (request) => {
    const chain = requireChain(deps.chain);
    const jobId = request.body.job_id.toLowerCase() as Hex;
    const address = addressOf(Buffer.from(request.body.address.slice(2), "hex"));
    const { jobRegistry, providerRegistry } = deps.config.addresses;
    const job = (abi: Abi, at: Address, name: string, args: unknown[]) => read(chain, abi, at, name, args);

    // **The order from this node, every gate from the chain.** An unclaimed
    // order exists only in this node's database, so that is where its terms are
    // read; every verdict on them is a view read at the node's floor, remembered
    // per floor block — a batch's lines are claimed in a burst, and each answer
    // would otherwise re-read the same balance and provider gates. Every read is
    // a `viewRead` (R77), so a dead endpoint answers `503`, never a verdict.
    //
    // The gates are evaluated in the contract's own order, so the reason this
    // returns is the reason `claim` would revert with.
    const order = await heldOrder(deps.db, jobId);
    if (order === null) return { ok: false, reason: "NotOpen" };
    const { terms } = order;

    // The order's gates. The signature and the expiry ceiling were checked when
    // the order was accepted and cannot change since.
    if (!(await job(jobRegistryAbi as Abi, jobRegistry, "allowedSla", [Number(terms.slaSecs)]))) {
      return { ok: false, reason: "SlaNotAllowed" };
    }
    if (BigInt(Math.floor(Date.now() / 1000)) > terms.expiresAt) {
      return { ok: false, reason: "AlreadyExpired" };
    }
    if (!(await job(providerRegistryAbi as Abi, providerRegistry, "modelExists", [Number(terms.modelId)]))) {
      return { ok: false, reason: "UnknownModel" };
    }
    if (!(await job(providerRegistryAbi as Abi, providerRegistry, "modelEnabled", [Number(terms.modelId)]))) {
      return { ok: false, reason: "ModelDisabled" };
    }
    // An id the chain has a row for is spent: claimed through a relay this node
    // has not indexed yet, or cancelled on chain by its owner.
    const view = await job(jobRegistryAbi as Abi, jobRegistry, "getJob", [jobId]) as { found: boolean };
    if (view.found) return { ok: false, reason: "NotOpen" };

    const providerId = Number(await job(providerRegistryAbi as Abi, providerRegistry, "idOf", [address]));
    // Before anything `_rec`-gated: `isListed`, `modelAllowed` and
    // `effectiveCap` all revert `UnknownProviderId` on id 0, so asking them
    // first would turn a clean answer into a decode failure.
    if (providerId === 0) return { ok: false, reason: "UnknownProvider" };
    if (!(await job(providerRegistryAbi as Abi, providerRegistry, "isListed", [providerId]))) {
      return { ok: false, reason: "NotListed" };
    }
    if (
      !(await job(providerRegistryAbi as Abi, providerRegistry, "modelAllowed", [
        providerId,
        Number(terms.modelId),
      ]))
    ) {
      return { ok: false, reason: "ModelNotAllowed" };
    }
    // Designation is matched against the signer's provider id, never an address.
    if (terms.designated !== 0n && terms.designated !== BigInt(providerId)) {
      return { ok: false, reason: "NotDesignated" };
    }
    // Both from the chain (R21). The SQL pair on `/evm/providers` is for display.
    const [active, cap] = await Promise.all([
      job(jobRegistryAbi as Abi, jobRegistry, "activeJobs", [providerId]),
      job(providerRegistryAbi as Abi, providerRegistry, "effectiveCap", [providerId]),
    ]);
    if (Number(active) >= Number(cap)) return { ok: false, reason: "AtCapacity" };

    // The lock, last as in `claim`.
    const gate = await fundsGate(chain, order.owner, terms, order.gasFee);
    if ("reason" in gate) return { ok: false, reason: gate.reason };
    if (!claiming.covers(order.owner, jobId, gate.lock, gate.balance)) {
      return { ok: false, reason: "InsufficientDeposit" };
    }

    // Advisory, and it says so by what it omits: the op signature and the
    // ±600 s window are not evaluated here. The authoritative simulate is the
    // one inside `POST /evm/ops`.
    return { ok: true };
  });
}

/** An open held order, read without a lock: the advisory gate decides nothing. */
async function heldOrder(db: Db, jobId: Hex): Promise<ClaimableOrder | null> {
  const { rows } = await db.query<{
    owner: Buffer;
    c: Buffer;
    model_id: bigint;
    sla_secs: bigint;
    designated: bigint;
    rate_in: bigint;
    rate_out: bigint;
    units_in: bigint;
    units_out: bigint;
    expires_at: bigint;
    task_cid: Buffer;
    gas_fee: bigint;
    order_sig: Buffer;
  }>(
    `SELECT owner, c, model_id, sla_secs, designated, rate_in, rate_out, units_in, units_out,
            expires_at, task_cid, gas_fee, order_sig
       FROM jobs WHERE job_id = $1 AND state = 0 AND ${HELD}`,
    [Buffer.from(jobId.slice(2), "hex")],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const hex = (buffer: Buffer): Hex => `0x${buffer.toString("hex")}`;
  return {
    owner: addressOf(row.owner),
    terms: {
      c: hex(row.c),
      modelId: BigInt(row.model_id),
      slaSecs: BigInt(row.sla_secs),
      rateIn: BigInt(row.rate_in),
      rateOut: BigInt(row.rate_out),
      unitsIn: BigInt(row.units_in),
      unitsOut: BigInt(row.units_out),
      designated: BigInt(row.designated),
      expiresAt: BigInt(row.expires_at),
    },
    taskCid: row.task_cid.toString("utf8"),
    gasFee: BigInt(row.gas_fee),
    orderSig: hex(row.order_sig),
  };
}

/**
 * The claim's own `Claimed` log, applied to its row through the reducer's arm,
 * so the row is claimed by the time the answer goes out. The indexed log that
 * follows writes the same absolute values; `Posted` arrives with it and clears
 * the order signature.
 */
async function markClaimed(db: Db, registry: Address, receipt: TransactionReceipt): Promise<void> {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    const event = decodeLog(log);
    if (event?.eventName === "Claimed") await applyEvent(db, event, receipt.blockNumber);
  }
}

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

const invalidOpSignature = (): ApiError =>
  new ApiError(
    403,
    "invalid_op_signature",
    "the op signature does not recover to a registered provider",
  );

/** `result_cid` names no `result` upload of this session's address. */
const unknownResult = (cid: string): ApiError =>
  new ApiError(
    400,
    "invalid_request",
    `result_cid names no upload with purpose 'result' for this session: ${cid}. Upload the ` +
      "result to POST /v1/files and settle with the cid it answers with, or send the result inline",
    "result_cid",
    "unknown_result",
  );

/**
 * Every chain failure on this door, classified once (R72).
 *
 * **A refusal is a verdict only if the endpoint actually returned one.** That is
 * the whole rule, and it is applied at every chain call the op pipeline makes —
 * the registry floor read, the pre-relay simulate, the send — because the caller
 * cannot tell which one failed and the answer must not depend on it. Before
 * this, the three answered a dead endpoint three different ways: `500
 * internal_error` from the unwrapped floor read, `409 {ok:false,
 * reason:"unknown"}` from the simulate's `catch`, and (correctly) `503` from the
 * send. The simulate one was the worst of the three and the one an operator met
 * first: for the three job ops it is the pipeline's *first* chain call, so a
 * node whose RPC has gone away told every daemon that the chain had refused its
 * op and that a retry could not help.
 *
 * `sendFailure(…, "relayer")` is where a non-verdict goes because it already
 * separates "nothing answered" from "the endpoint answered and refused", and
 * names which refusal it was — the same classification the send stage uses, so
 * the two stages cannot drift.
 */
async function chainFailure(
  reply: FastifyReply,
  error: unknown,
  onRefusal?: (reason: string) => Promise<void>,
): Promise<FastifyReply> {
  if (!isVerdict(error)) throw sendFailure(error);
  // Non-decodable revert data is reported as `unknown` with the bytes attached,
  // never mapped onto the nearest familiar name.
  const revert = decodeRevert(error, ABIS);
  // Reconcile-on-error, wired to the verdict rather than to the route: this is
  // the single point every refusal on this door passes through, at either stage,
  // so a repair hung here cannot be missed by a stage somebody adds later.
  if (onRefusal !== undefined) await onRefusal(revert.reason);
  return refused(reply, revert);
}

/** `409 {ok:false, reason, raw?}` — the refusal shape both doors share. */
function refused(reply: FastifyReply, revert: { reason: string; raw: Hex | null }): FastifyReply {
  return reply
    .code(409)
    // Explicit, per R57. A refusal is a verdict on the chain state as it stands;
    // re-sending identical bytes cannot change it, and a client that wants a
    // different answer needs a different op.
    .header("x-vorq-retryable", "false")
    .send(
      // `raw` appears **only** when the reason is `unknown`. A named reason is
      // the whole answer — the bytes it was decoded from add nothing a caller
      // can use — whereas an undecodable revert is precisely the case where the
      // bytes are the only thing left to hand over.
      revert.reason === "unknown" && revert.raw !== null
        ? { ok: false, reason: revert.reason, raw: revert.raw }
        : { ok: false, reason: revert.reason },
    );
}

/**
 * The monotonic floor for a registry op, read from the chain.
 *
 * R11 puts the floor at `max(stored, chain)`. These two ops have no stored
 * floor — `lastIdentityAt` and `lastCapacityAt` are the chain's own mappings and
 * nothing here mirrors them — so the maximum is the chain's value, and reading
 * it from the chain is what makes a wipe of this node's database unable to
 * accept a replayed op.
 */
async function registryFloor(
  chain: Chain,
  providerRegistry: Address,
  op: ParsedOp,
  providerId: bigint,
): Promise<bigint> {
  const functionName = op.name === "set_identity" ? "lastIdentityAt" : "lastCapacityAt";
  // `lastIdentityAt` / `lastCapacityAt` are storage getters on a frozen
  // contract, so R77 covers them like every other view read: a failure here is
  // **this node's**, never a verdict on the op. They cannot revert when the node
  // is configured correctly — they revert when the configured registry address
  // points at some other contract, so the fallback reverts, or when the endpoint
  // reports unavailable historical state as `execution reverted`. Either way the
  // op the caller signed is fine, and answering `409 reason:"unknown"` with
  // `retryable=false` tells every provider daemon to stop at once, so a
  // misconfigured node produces silence instead of retries pointing at the real
  // fault. It also contradicts what this pipeline already knows: `providerId` was
  // resolved one step above, so the node has the provider in hand while calling
  // it `"unknown"`.
  const last = await viewRead("registry_floor_read", () =>
    chain.publicClient.readContract({
      address: providerRegistry,
      abi: providerRegistryAbi as Abi,
      functionName,
      args: [Number(providerId)],
    }),
  );
  return BigInt(last as bigint | number);
}

/**
 * `eth_call` the exact transaction, then send it, then wait for its receipt.
 *
 * The simulate runs **from the relayer's address**, not from the signer's: the
 * transaction that would be broadcast is sent by the relayer, and a simulate
 * from any other sender is a simulate of a different transaction. It costs no
 * gas and it is the only thing standing between a bad op and a paid revert.
 */
async function simulateThenRelay(
  chain: Chain,
  to: Address,
  data: Hex,
  reply: FastifyReply,
  /**
   * The route that shows whether this op landed — named in the `504`.
   *
   * It has to be a route that exists and answers the question, and it is passed
   * in rather than written into the message because the two kinds of op are read
   * back in different places. For a job op the answer is
   * `GET /v1/jobs/{job_id}`; for a registry op it is the provider row. Each
   * reflects the op once its log is indexed.
   */
  resume: string,
  onRefusal?: (reason: string) => Promise<void>,
  /**
   * Extra members of the success body — `{result_cid}` for a settle, nothing for
   * every other op.
   *
   * Only the `201` carries them. A failed relay keeps the envelope it already
   * had: bolting a minted name onto an error would change what a failure looks
   * like on a door whose failure shapes are the contract.
   */
  extra: Record<string, unknown> = {},
  /** Runs once the transaction mined, awaited before the answer; its failure is logged, never answered. */
  onReceipt?: (receipt: TransactionReceipt) => Promise<void>,
): Promise<FastifyReply> {
  // **At the node's floor, and the gas estimate with it.** Every op on this door
  // follows one of this node's own receipts — a settle or a fail its claim, a
  // claim the owner's deposit — and `latest` on a load-balanced endpoint is
  // whichever node answers. Measured on Base Sepolia 2026-10-15: a settle relayed
  // one second after its claim's `201` was simulated on a node one block behind
  // and refused `NotClaimed`, and the job failed with its answer in hand. The
  // estimate is pinned too because the broadcast otherwise estimates at `latest`
  // and meets the same stale node at the send.
  //
  // The floor trails the head by at most one indexer tick. `NotOpen`,
  // `SlaExpired` and the fail grace only loosen at an older `block.timestamp`,
  // and `StaleOp` has ±600 s. `claim`'s `ExpiryTooFar` is the one check that
  // tightens: a 24 h order claimed within a block of its acceptance can be
  // refused at the floor (measured 2026-09-23 on the same check, then in `post`). That
  // refusal is transient — the daemon backs off and claims again a block later —
  // while a claim simulated at `latest` could be refused for good against a
  // stale node that has not seen the owner's deposit.
  let gas: bigint;
  try {
    await atFloor(chain, (pin) =>
      chain.publicClient.call({ account: chain.account.address, to, data, ...pin }),
    );
    gas = await atFloor(chain, (pin) =>
      chain.publicClient.estimateGas({ account: chain.account, to, data, ...pin }),
    );
  } catch (error) {
    return chainFailure(reply, error, onRefusal);
  }

  // `chain.relay`, not `walletClient.sendTransaction` directly: sends from the
  // relayer account are serialised process-wide, because the account's
  // transaction nonce is one counter and two overlapping sends sign the same one
  // (R66).
  //
  // And the send is inside a `try`. It was bare, so a refused broadcast — the
  // very failure a nonce collision provokes — surfaced as `500 internal,
  // retryable=false` for an op that never broadcast.
  //
  // **The same `chainFailure` the simulate uses** (R80), because the stage is not
  // a discriminator. A revert that reaches the broadcast is the endpoint
  // pronouncing on the transaction exactly as one at the simulate is, so it is
  // `409` with the contract's own error name — `DuplicateJob`, `AtCapacity`,
  // `NotOpen` — at either stage, and `POST /v1/jobs` (the other relayer-funded
  // door) answers the same way since Task 9's fix round. It was `400` here, so
  // one event had two answers depending on which chain call saw it first; that
  // it looked defensible is only because the two doors were written a task
  // apart. A send-stage revert *is* transient — the state moved under an op the
  // simulate had passed — and the name serves that better than an opaque
  // retryable `503`: a caller that reads `AtCapacity` knows to re-read and retry.
  //
  // Everything that is not a verdict still goes to `sendFailure` inside
  // `chainFailure`, so the funding model still decides who is blamed (R70): an
  // empty relayer wallet, a nonce that lost a race with an external submitter,
  // `-32603`, `-32005` and a dead endpoint keep their retryable answers, and
  // `param` stays `null` because no field of the request is at fault. Every door
  // in this node works that way — the caller signs the payload and the relayer
  // funds the transaction — which is why `sendFailure` takes no funding
  // parameter to tell one kind from another.
  let txHash: Hex;
  try {
    txHash = await chain.relay({ to, data, gas });
  } catch (error) {
    return chainFailure(reply, error, onRefusal);
  }

  let receipt;
  try {
    receipt = await chain.receipt(txHash, RECEIPT_TIMEOUT_MS);
  } catch {
    throw new ApiError(
      504,
      "receipt_timeout",
      `op ${txHash} was relayed but no receipt arrived within ${RECEIPT_TIMEOUT_MS} ms; ` +
        `read ${resume} rather than re-sending it`,
      null,
      txHash,
    );
  }

  if (onReceipt !== undefined && receipt.status === "success") {
    try {
      await onReceipt(receipt);
    } catch (error) {
      // The transaction is mined; a `5xx` for an op that landed is the one
      // answer that must never be given. The indexer writes the same row.
      reply.log.error({ err: error, txHash }, "receipt hook failed");
    }
  }

  // No `as_of_block` (R28): nothing here was read from the index.
  return reply.code(201).send({
    tx_hash: txHash,
    status: receipt.status,
    block_number: receipt.blockNumber,
    ...extra,
  });
}
