import type { FastifyReply } from "fastify";
import { Type, type Static } from "typebox";
import { encodeFunctionData, recoverTypedDataAddress, type Abi, type Hex } from "viem";
import { jobRegistryAbi } from "../../abi/jobRegistry.js";
import { providerRegistryAbi } from "../../abi/providerRegistry.js";
import { atFloor, type Chain } from "../../chain/client.js";
// `atFloor` is used by `/evm/simulate/claim`'s state reads only; see `simulateThenRelay`.
import { decodeRevert, isVerdict } from "../../chain/revert.js";
import type { Address } from "../../config.js";
import { repairOnRefusal } from "../../index/reconcile.js";
import { dropUnconfirmed } from "../../index/write-through.js";
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
import { EIP712_NAMES } from "../../orders.js";
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
} from "../schemas/common.js";
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
 * ## Simulate before every relay
 *
 * Every op is `eth_call`ed **as the exact transaction that would be sent, from
 * the relayer's own address**, before a single wei of gas is spent. A revert
 * answers `409 {ok:false, reason:"<contract error name>"}` and relays nothing.
 * This is not the same check as `/evm/simulate/claim`: that one reads views and
 * is advisory, and it cannot see the escrow pull — a payment-token failure
 * inside `claim` reverts with an error in neither of this node's ABIs, which is
 * exactly the `409 {ok:false, reason:"unknown", raw:"0x…"}` case. Neither check
 * is ever removed for the other.
 *
 * ## What this door answers, and what each answer promises (R57, R72)
 *
 * ## The result rides with the settle
 *
 * Every body on this door is flat JSON. `result_cid` as the caller's own choice
 * of name is gone: a `settle` carries the op's fields — `op`, `job_id`,
 * `completion_tok`, `issued_at`, `signature` — plus exactly one of
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
   * `mintedCid` is the name the pin returned, and `null` for every op that pins
   * nothing. `settle` throws on a `null` rather than encoding an empty `bytes`:
   * the contract's `EmptyResultCid` would refuse it anyway, and paying an
   * `eth_call` to be told so would mean this node had built a transaction it knew
   * was wrong.
   */
  calldata: (signature: Hex, mintedCid: string | null) => Hex;
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
      { name: "completionTok", type: "uint32" },
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
  completion_tok: Uint32({ description: "The delivered output units." }),
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
 * `Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)`,
 * `Fail(bytes32 jobId,uint64 issuedAt)`,
 * `SetIdentity(bytes32 boxKey,bytes evidence,uint64 issuedAt)`,
 * `RequestCapacity(uint32 n,uint64 issuedAt)`. A member renamed or reordered
 * here recovers a different address and the op is refused, which is a silent
 * failure — so this list is written against the vendored ABI and the contract
 * source, not from memory.
 *
 * **`resultCid` is not a member of `Settle` any more**, and the ABI cannot tell
 * you that: `submitAndSettle` still takes the CID and its selector is unchanged,
 * so regenerating the ABI carries none of this. The provider hands the result to
 * this node, which pins it and learns the name from the storage service — a name
 * that does not exist when the op is signed. The consequence is stated rather
 * than glossed: unlike the task side there is **no commitment standing behind the
 * result**, no `c` to check the bytes against, and this door invents none. The
 * settle signature attests the delivered count and nothing about which bytes
 * produced it.
 */
function parseOp(body: OpBody): ParsedOp {
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
        calldata: (signature) =>
          encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "claim",
            args: [hex, issuedAt, signature],
          }),
      };
    }

    case "settle": {
      const hex = body.job_id.toLowerCase() as Hex;
      const completionTok = BigInt(body.completion_tok);
      const { toPin, resultCid } = parseResult(body);
      return {
        name: body.op,
        registry: "job",
        primaryType: "Settle",
        types: OP_TYPES.Settle,
        message: { jobId: hex, completionTok, issuedAt },
        issuedAt,
        jobId: hex,
        toPin,
        resultCid,
        calldata: (signature, mintedCid) => {
          if (mintedCid === null) {
            throw new Error("settle calldata was built before the result was pinned");
          }
          // A CID is text by construction, so it is encoded UTF-8 — exactly what
          // the projection decodes back out of `result_cid`.
          const cidHex: Hex = `0x${Buffer.from(mintedCid, "utf8").toString("hex")}`;
          return encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "submitAndSettle",
            args: [hex, Number(completionTok), cidHex, issuedAt, signature],
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
        calldata: (signature) =>
          encodeFunctionData({
            abi: jobRegistryAbi,
            functionName: "fail",
            args: [hex, issuedAt, signature],
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

export function opsRoutes(app: App, deps: RouteDeps): void {
  const serialized = subjectQueue("ops");
  const pinner: Pinner = pinnerFor(deps.config, deps.db);

  // Reconcile-on-error, hung on the refusal rather than on the route (R3/R4).
  const repair = repairOnRefusal(
    deps.chain,
    deps.db,
    deps.config.addresses.jobRegistry,
    (error, jobId, reason) =>
      app.log.error({ err: error, jobId, reason }, "reconcile-on-refusal failed"),
  );

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
    const op = parseOp(request.body);

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
      let mintedCid: string | null = null;
      if (toPin !== null) {
        mintedCid = await throughPinner(request, () => put(pinner, toPin));
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
        mintedCid = op.resultCid;
      }
      const data = op.calldata(signature as Hex, mintedCid);
      return simulateThenRelay(
        chain,
        registryAddress,
        data,
        reply,
        resume,
        repair(op.jobId),
        mintedCid === null ? {} : { result_cid: mintedCid },
      );
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
          "The advisory gate a daemon consults before it signs: chain view reads only, so it " +
          "answers during the finality lag. It cannot see the escrow pull; `/evm/ops` simulates that.",
        body: Type.Object({ job_id: Hex32(), address: AddressIn({ description: "The operator." }) }),
        response: { 200: SimulateResult, ...errors(400, 503) },
      },
    },
    async (request) => {
    const chain = requireChain(deps.chain);
    const jobId = request.body.job_id.toLowerCase() as Hex;
    const address = addressOf(Buffer.from(request.body.address.slice(2), "hex"));

    // **R77, on the door a provider daemon hits hardest.** Every one of the six
    // reads below is a view read, and every one of them was bare: a dead
    // endpoint, a rate limit, a bare revert and a decoded revert all answered
    // `500 internal_error` with `x-vorq-retryable: false`, which under R57 is the
    // promise that the identical request can never succeed — false the moment the
    // RPC comes back. Wrapping the helper rather than the call sites is the point:
    // a seventh gate added below this line cannot be written unwrapped.
    const read = <T>(abi: Abi, at: Address, functionName: string, args: unknown[]): Promise<T> =>
      viewRead("claim_simulate_read", () =>
        atFloor(
          chain,
          (pin) =>
            chain.publicClient.readContract({ address: at, abi, functionName, args, ...pin }) as Promise<T>,
        ),
      );

    const jobRegistry = deps.config.addresses.jobRegistry;
    const providerRegistry = deps.config.addresses.providerRegistry;

    // **Chain `eth_call`s only, no index reads** (R22). That is what makes this
    // answer meaningful during the finality lag, which is precisely when a
    // daemon is deciding whether to sign — an index-backed answer would be
    // stale in exactly the window the caller cares about.
    //
    // The gates are evaluated in the contract's own order, so the reason this
    // returns is the reason `claim` would revert with, and not merely *a* reason
    // it would fail.
    const job = await read<{
      found: boolean;
      state: number;
      providerId: number;
      designated: number;
      modelId: number;
    }>(jobRegistryAbi as Abi, jobRegistry, "getJob", [jobId]);

    if (!job.found) {
      // **The one repair this route does make, and it costs no chain method.**
      // A `jobs` row for a job `getJob` does not have is a write-through row
      // whose post was orphaned (`index/write-through.ts`), and this is where
      // that is discovered: the daemon simulates before it signs and treats a
      // refusal as a skip, so it never reaches the `/evm/ops` door where
      // `repairOnRefusal` lives, and a phantom nobody deletes keeps being
      // advertised — and keeps taking a lease slot on every poll — until its
      // own `expires_at`.
      //
      // R22 is not bent by it. The ruling pins this route's *answer* to chain
      // `eth_call`s, and `api-relay.test.ts` enforces it by asserting on the
      // methods issued; a `DELETE` issues none, reads nothing, and changes no
      // answer. What the comment below rightly refuses is a full `reconcileJob`,
      // which would add an `eth_blockNumber` and a second `getJob` for a verdict
      // this branch already holds. `dropUnconfirmed` is guarded to rows ahead of
      // the cursor, so a lagging endpoint cannot make it delete the indexer's
      // work.
      //
      // Awaited, so the answer is deterministic and a test can assert on the
      // row; swallowed, because a repair bolted to somebody else's request must
      // not turn that request's answer into a `500`.
      try {
        if (await dropUnconfirmed(deps.db, Buffer.from(jobId.slice(2), "hex"))) {
          app.log.warn({ jobId }, "dropped a job row the chain does not have");
        }
      } catch (err) {
        app.log.error({ err, jobId }, "phantom row cleanup failed");
      }
      return { ok: false, reason: "UnknownJob" };
    }
    // `getJob` already renders an expired-but-open job as `state 3 / cause 5`
    // (R3), so this one comparison covers both "resolved" and "abandoned" —
    // exactly as `claim`'s own `state != Open || now > expiresAt` does.
    // **Reconcile is deliberately NOT wired here, and R22 is the reason.** This
    // route is the earliest and most-hit place the node learns that a job the
    // book still advertises is gone, so repairing the row here is tempting and
    // would be genuinely useful — and for the branch above, where the chain has
    // no such job at all, the repair is a bare `DELETE` cheap enough to make.
    // Not this one: a `NotOpen` job is one the chain *has*, so putting the row
    // right means reading its 20 fields back, which is the reconcile R22
    // refuses. R22 pins this route to chain `eth_call`s and
    // nothing else, and the guard that enforces it (`api-relay.test.ts`) asserts
    // on the *methods issued*, not only on where the answer came from — a
    // reconcile adds an `eth_blockNumber` and a write, and turning that guard
    // down to accommodate a repair would cost more than the repair is worth.
    // The pre-relay simulate inside `POST /evm/ops` covers the same revert on the
    // path that actually spends something.
    if (job.state !== 0) return { ok: false, reason: "NotOpen" };

    const providerId = await read<number>(
      providerRegistryAbi as Abi,
      providerRegistry,
      "idOf",
      [address],
    );
    // Before anything `_rec`-gated: `isListed`, `modelAllowed` and
    // `effectiveCap` all revert `UnknownProviderId` on id 0, so asking them
    // first would turn a clean answer into a decode failure.
    if (providerId === 0) return { ok: false, reason: "UnknownProvider" };

    const listed = await read<boolean>(providerRegistryAbi as Abi, providerRegistry, "isListed", [
      providerId,
    ]);
    if (!listed) return { ok: false, reason: "NotListed" };

    const modelAllowed = await read<boolean>(
      providerRegistryAbi as Abi,
      providerRegistry,
      "modelAllowed",
      [providerId, job.modelId],
    );
    if (!modelAllowed) return { ok: false, reason: "ModelNotAllowed" };

    // Designation is matched against the signer's provider id, never an address.
    if (job.designated !== 0 && job.designated !== providerId) {
      return { ok: false, reason: "NotDesignated" };
    }

    // Both from the chain (R21). The SQL pair on `/evm/providers` is for display
    // and would be answering from the index, which this route does not do.
    const [active, cap] = await Promise.all([
      read<number>(jobRegistryAbi as Abi, jobRegistry, "activeJobs", [providerId]),
      read<number>(providerRegistryAbi as Abi, providerRegistry, "effectiveCap", [providerId]),
    ]);
    if (active >= cap) return { ok: false, reason: "AtCapacity" };

    // Advisory, and it says so by what it omits: the escrow pull, the op
    // signature and the ±600 s window are not evaluated here. The authoritative
    // simulate is the one inside `POST /evm/ops`.
    return { ok: true };
  });
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
  // never mapped onto the nearest familiar name: the escrow pull inside `claim`
  // can revert inside the payment token, whose errors are in neither
  // registry's ABI.
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
): Promise<FastifyReply> {
  // At `latest`, never at the node's floor: a simulate is a verdict on the
  // transaction as it would mine, and the contract reads `block.timestamp`
  // (`AlreadyExpired`, `ExpiryTooFar`, the fail-grace price). Pinned to an older
  // block it refused a valid 24 h order as `ExpiryTooFar` (measured 2026-09-23).
  // The floor is for state reads that authorise against this node's own receipts.
  try {
    await chain.publicClient.call({ account: chain.account.address, to, data });
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
    txHash = await chain.relay({ to, data });
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

  // No `as_of_block` (R28): nothing here was read from the index.
  return reply.code(201).send({
    tx_hash: txHash,
    status: receipt.status,
    block_number: receipt.blockNumber,
    ...extra,
  });
}
