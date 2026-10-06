import type { FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";
import { Type, type Static } from "typebox";
import { encodeFunctionData, type Abi, type Hex, type TransactionReceipt } from "viem";
import { jobRegistryAbi } from "../../abi/jobRegistry.js";
import { chainParams, type Chain, type ChainParams } from "../../chain/client.js";
import { decodeRevert, isVerdict } from "../../chain/revert.js";
import type { Address } from "../../config.js";
import {
  authorizationTypedData,
  capOf,
  CapOverflowError,
  feeOf,
  MAX_EXPIRY_SECONDS,
  MAX_SLA_SECONDS,
  orderTypedData,
  PAYMENT_SCHEME,
  taskCidHex,
  tokenDomain,
  type Terms,
} from "../../orders.js";
import { markAssigned, rankProviders, type Candidate } from "../../match/rank.js";
import { repairOnRefusal } from "../../index/reconcile.js";
import { UNCONFIRMED, writePostedRows } from "../../index/write-through.js";
import { assertCommitment, assertSameCommitment, ContainerError } from "../../container.js";
import {
  hasPayment,
  parseContent,
  parseOrder,
  parsePayment,
  recovers,
  Submission,
} from "../../submission.js";
import { pinnerFor, put } from "../../pin/pinner.js";
import { chainGate, requireChain, type App, type RouteDeps } from "../deps.js";
import { sendFailure, viewRead } from "../chain-failure.js";
import { ApiError, badRequest, errorBody, isRetryable } from "../errors.js";
import { MAX_BODY_BYTES } from "../limits.js";
import { formatUsd } from "../../money.js";
import { throughPinner } from "../pin-failure.js";
import { subjectQueue } from "../queue.js";
import { jobLimiter } from "../rate-limit.js";
import {
  ErrorEnvelope,
  errors,
  Hex32,
  HexOut,
  Int,
  SafeUint,
  Sig65,
  Uint32,
  UsdOut,
} from "../schemas/common.js";
import { attachFile, findUpload } from "./files.js";

/**
 * `POST /v1/jobs` — the 402 challenge and the post relay — and
 * `POST /v1/jobs/{id}/cancel`.
 *
 * ## The flow, in one paragraph
 *
 * The order is **flat, chain-shaped terms**: the ten members of `Order` plus the
 * owner and its signature, each its own field. Every body on this door is JSON.
 * A post without `auth_sig` is answered `402` with the quote the client must
 * sign — `cap`, the protocol `fee` that `fee_bps` puts on top of it, the
 * chain's `gas_fee`, their sum as `amount`, and the exact payment authorization — and
 * nothing is relayed. The client signs an EIP-3009 `ReceiveWithAuthorization`
 * over precisely those terms and re-posts the same fields with `auth_sig`
 * **and `amount` echoed back** (R7), plus its sealed container. The node
 * re-checks everything it can check for free, re-reads `gasFee` and `feeBps`,
 * asks the chain for its verdict, files the bytes, and relays
 * `post(order, owner, orderSig, authSig)` from the relayer account with the
 * name the storage service minted.
 *
 * ## The container, inline or by name
 *
 * `task_cid` is gone from the request: the client cannot know the name, because
 * this node is the party that mints it. What the body carries instead is exactly
 * one of:
 *
 *   * `container` — the sealed bytes, base64. The door hashes them and requires
 *     `keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext)) == c`, then files
 *     them itself.
 *   * `container_cid` — the `vorq.cid` of a `POST /v1/files` upload with
 *     `purpose=input`, by this same owner. That door committed to the bytes as
 *     they streamed past, so the check here is `files.commitment == c`: no
 *     object is read back, and nothing is filed twice.
 *
 * Either way the commitment is the **whole** integrity story on this door.
 * Skipping it posts a job whose bytes miss their commitment — which every
 * provider re-derives and refuses, stranding the job with its escrow committed.
 *
 * ## The body limit is the only bound
 *
 * {@link MAX_BODY_BYTES} is the bound and there is no cap on the decoded
 * container. That is deliberate: a decoded cap on top of the body limit refuses
 * a payload the door has already read and parsed, which spends the allocation
 * the cap existed to prevent and then answers `400` for it. So the bound is the
 * one that acts **before** the bytes are buffered, and a client with more than
 * that uploads to `/v1/files` first — where the bytes are streamed rather than
 * held, under `MAX_BLOB_BYTES` — and posts the cid.
 *
 * ## Nothing is filed for an order the chain would refuse
 *
 * The free checks come first, and then — on **both** shapes — one `eth_call` of
 * the exact transaction, under a stand-in name inline
 * ({@link PLACEHOLDER_TASK_CID}) and under the real cid on the upload-first
 * path. The contract reads `taskCid` only for non-emptiness, so that simulate is
 * its verdict on everything else: the authorization and the funds behind it, the
 * expiry, the duplicate the index may not have seen. Without it, any keypair
 * that can sign an order and an authorization but holds no funds makes this node keep
 * the megabytes its body carried, or the megabytes it uploaded first, for
 * `FILE_RETENTION_SECONDS`. The upload-first path is not saved by the 300 s
 * orphan window: the attach that grants full retention happens one statement
 * before the relay that would have refused it. One `eth_call` per paid post is
 * what that costs.
 *
 * The pin — or the attach — then happens inside the serialised section
 * immediately before the relay, so the bytes are stored before the transaction
 * that names them is broadcast, and a pin that fails relays nothing. A relay
 * that fails after a successful pin leaves an orphan object, which is the cheap
 * direction: nothing names it, and the file sweep removes it once it is past
 * retention.
 *
 * ## A body carrying content is never answered with a quote
 *
 * **A body that carries the container is a complete submission**, and this door
 * will not answer one with a quote. The challenge is computed from the signed
 * terms alone — `cap` and `fee` are arithmetic over two cached reads — so it
 * needs no bytes, and a client that sent them anyway would be told to sign a
 * quote and come back, uploading the same megabytes a second time. The `402`
 * loop is the one place in this protocol where a client re-sends a whole request
 * on purpose, which makes it the one place a payload must not be.
 *
 * So the invariant is hung on the route as an `onSend` hook
 * ({@link neverChallengeAfterBytes}) rather than written as a condition inside
 * the branch that happens to send today's `402`. A branch-local check defends the
 * branch; the hook defends the door, including the paths nobody has written yet.
 * What replaces the would-be second challenge is a `400` naming `auth_sig`
 * with `code: "container_without_payment"` — a real error stating the real
 * reason, with `x-vorq-retryable: false`, because the identical body can never
 * be accepted (R57).
 *
 * The one re-quote that survives is the `409` below, and it is not a challenge:
 * `gasFee` or `feeBps` moved on chain between the quote and the resubmit, so
 * the authorization the client signed no longer matches `cap + feeCap + gasFeeSnap`
 * and there is no answer that accepts it. It is a refusal with the remedy
 * attached, it is `retryable: false`, and it too is decided **before** the
 * bytes are read.
 *
 * ## Why the free local checks are not optional
 *
 * `post`'s `authSig` is unauthenticated calldata that the contract stores
 * without verifying (R37): a bad payment signature posts a job that can never be
 * claimed, burns the client's `c` forever, and the node eats the gas it fronted.
 * Recovering the authorization locally costs one ECDSA operation and removes the whole
 * class. The same reasoning drives the order signature, the `job_id` binding, the
 * expiry window and the catalog row: each is a refusal the chain would make
 * anyway, made here before any gas is spent. The commitment check is the one that
 * is **not** of that kind — the chain cannot make it, no contract sees the
 * container, and nothing downstream will catch it either.
 *
 * ## What this door answers (R57 — retryability is the header, never the type)
 *
 * ```
 * 201 {job_id, task_cid, tx_hash}       relayed and mined
 * 200 {job_id, tx_hash}                 the same, for cancel (R16)
 * 402 {quote, accepts}                  sign this and come back        not retryable
 *                                       NEVER for a body with content
 * 400 invalid_request_error             the request is malformed       not retryable
 * 400 container_without_payment         the container arrived without  not retryable
 *                                       the payment; do not re-upload
 *                                       it to be quoted
 * 400 unknown_container                 container_cid names no input   not retryable
 *                                       upload of this owner's
 * 409 {error:{code:"<ContractError>"}}  THE CHAIN REFUSED IT           not retryable
 * 409 {quote, accepts}                  a fee drifted; re-sign         not retryable
 * 413 body_too_large                   body past MAX_BODY_BYTES       not retryable
 * 429 busy                              too many posts of one job_id       RETRYABLE
 * 429 rate_limit_exceeded               the wallet's daily job limit   not retryable
 * 503 pinner_unavailable {code}         the bytes could not be filed       RETRYABLE
 * 503 relay_unavailable {code}          the NODE could not relay it        RETRYABLE
 * 503 chain_unreachable                 nothing answered at all            RETRYABLE
 * 504 receipt_timeout                   broadcast, no receipt in time  not retryable
 * ```
 *
 * `task_cid` on the `201` is not decoration: this node mints it, so a caller that
 * is not told cannot learn the name of its own object by any other means — it
 * cannot compute one, and until the post is indexed there is nothing to read it
 * from. `cancel` names nothing new and carries no such field.
 *
 * The two `409`s are told apart by their body and never by their status: a
 * refusal carries `error`, a stale quote carries `quote` — the same shape as the
 * `402`, so a client has one code path for "sign this quote" whichever status
 * carried it.
 *
 * Registered **outside** the readiness gate and carrying no `as_of_block` (R28).
 * The index is read twice — the catalog row and the duplicate pre-check — but
 * only as free refusals ahead of the authoritative on-chain simulate, exactly as
 * `resolveProviderId` does on the op door. Gating this behind index freshness
 * would refuse a client its post for a lag that has no bearing on whether the
 * chain will accept it.
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------



/**
 * The largest body `POST /v1/jobs/{id}/cancel` reads, in bytes.
 *
 * Two fields and a 65-byte signature — a few hundred bytes written out, with
 * room for whitespace and for a field a later plan adds. Its own constant
 * because a cancel carries no content and has no reason to inherit a bound sized
 * for one.
 */
const MAX_ORDER_ENVELOPE_BYTES = 8 * 1024;

/**
 * How many posts of **one `job_id`** may be queued behind the one in flight.
 *
 * Re-exported from `api/queue.ts` under this door's own name so the test that
 * pins the `429 busy` path is written against the bound rather than a number
 * copied out of here (R67), and so the constant has exactly one definition.
 */
export { MAX_QUEUE_DEPTH as MAX_POST_QUEUE_DEPTH } from "../queue.js";

/** How long the node waits for a relayed transaction's receipt. See `routes/relay.ts`. */
const RECEIPT_TIMEOUT_MS = 60_000;

/** Job ops are fresh within ±600 s inclusive against the node's clock (R24, R33). */
const JOB_OP_WINDOW_SECONDS = 600n;

/** Only the JobRegistry's errors can come back from these two calls. */
const ABIS: readonly Abi[] = [jobRegistryAbi as Abi];

/**
 * The stand-in `taskCid` for the preflight simulate: non-empty, which is all the
 * contract reads of it, and nothing this node would ever mint.
 */
const PLACEHOLDER_TASK_CID = taskCidHex("-");

// ---------------------------------------------------------------------------
// Never a challenge for a body that carried the bytes
// ---------------------------------------------------------------------------

/**
 * The requests whose body carried the container, inline or by name.
 *
 * A `WeakSet` rather than a decorated property or a field on the parsed order,
 * because the reader is a hook that runs **after** the handler has returned and
 * has nothing of the handler's left but the request object. Weak, so a request
 * that never reaches the hook — a connection reset mid-response — is collected
 * with everything else it holds.
 */
const carriedBytes = new WeakSet<FastifyRequest>();

/**
 * **A body that carried a container is never answered with a quote.**
 *
 * The rule and the reason are in this file's header. What is worth saying here is
 * why it is an `onSend` hook and not an `if` beside the `402`.
 *
 * `402` is the one status in this protocol a client is *expected* to loop on: it
 * means "sign this and send the same request again". Every other refusal ends the
 * exchange. So a `402` answered to a body that already carried the payload does
 * not cost the client a request — it costs it the **upload**, a second time, and
 * a client obeying the protocol correctly is what makes it happen. That is a
 * defect of the door, not of a branch, and the branch that sends today's `402` is
 * not the one that will send tomorrow's: a readiness gate, a rate limiter, a
 * re-quote on some future term, all of them are one `reply.code(402)` away from
 * reintroducing it, and none of them would be written by someone reading the
 * quote branch.
 *
 * Hung on the route, it holds for every path through the handler including the
 * ones that do not exist yet, and it is one deletion away from being gone — which
 * is what makes it testable (R67). The fail-open mutation is deleting the hook
 * from the route options: the `402` then escapes on a body that carried bytes,
 * and `test/api-post.test.ts` goes red (R81).
 *
 * It **rewrites** rather than logs. A guard that only complains leaves the wrong
 * answer on the wire, and the wrong answer here is the whole cost.
 */
const CONTAINER_WITHOUT_PAYMENT = new ApiError(
  400,
  "invalid_request",
  "this body carries the container, so it is a complete submission and not a request for a " +
    "quote — send auth_sig with it. The 402 challenge is computed from the signed terms " +
    "alone and must not carry the bytes: answering one here would ask for the same upload " +
    "twice.",
  "auth_sig",
  "container_without_payment",
);

const neverChallengeAfterBytes: onSendHookHandler = async (request, reply, payload) => {
  if (reply.statusCode !== 402 || !carriedBytes.has(request)) return payload;
  reply
    .code(CONTAINER_WITHOUT_PAYMENT.status)
    // Re-stated because the reply already carries the `402`'s own header, and
    // `false` for a different reason: not "sign a quote", but "this body is
    // wrong". Retryability is the header and never the type (R57), and a
    // `retryable: true` here would mean "resend the megabytes" — the exact
    // instruction this guard exists to withhold (R70).
    .header("x-vorq-retryable", String(isRetryable(CONTAINER_WITHOUT_PAYMENT.type)))
    .header("content-type", "application/json; charset=utf-8");
  // Serialised here rather than returned as an object: `onSend` is past the
  // serializer, so a payload handed back as an object reaches the socket as
  // `[object Object]`.
  return JSON.stringify(errorBody(CONTAINER_WITHOUT_PAYMENT));
};

// ---------------------------------------------------------------------------
// The parsed request
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * The market probe: a body naming no bid. Every order carries both rates, so a
 * body with neither is a client asking for the market before it signs anything.
 */
export const MarketProbe = Type.Object({
  model_id: Uint32(),
  sla_secs: Uint32({ maximum: Number(MAX_SLA_SECONDS), description: "The window, in seconds." }),
  units_in: Uint32(),
  units_out: Uint32(),
  designated: Type.Optional(Uint32({ description: "Pin one provider; its ask is the only candidate." })),
});
type MarketProbe = Static<typeof MarketProbe>;

/** Neither rate: the body is a probe. The one test, used by the schema, the gate and the handler. */
const PROBE_TEST = { not: { anyOf: [{ required: ["rate_in"] }, { required: ["rate_out"] }] } };
const isProbe = (body: unknown): body is MarketProbe =>
  typeof body === "object" && body !== null && !("rate_in" in body) && !("rate_out" in body);

const JobBody = Type.Unsafe<MarketProbe | Submission>({
  type: "object",
  description:
    "**Probe** (neither `rate_in` nor `rate_out`): the ranked live asks for the model and window, " +
    "unsigned, answered `402 {candidates}`. **Challenge** (a signed order, no `auth_sig`): " +
    "answered `402` with the quote to sign. **Submission** (order, `auth_sig`, `amount` and " +
    "exactly one of `container`/`container_cid`): relayed, `201`.",
  if: PROBE_TEST,
  then: MarketProbe,
  else: Submission,
});

const Candidate = Type.Object({
  provider_id: Int(),
  box_key: HexOut("The key to seal to."),
  rate_in: UsdOut(),
  rate_out: UsdOut(),
});

const Quote = Type.Object({
  quote: Type.Object({
    cap: UsdOut("The escrowed ceiling for the declared units, in USD."),
    fee_bps: Type.Integer(),
    fee: UsdOut(),
    gas_fee: UsdOut(),
    amount: UsdOut("cap + fee + gas_fee, in USD: what the authorization must be for."),
    authorization: Type.Object({
      domain: Type.Object({
        name: Type.String(),
        version: Type.String(),
        chainId: Type.Integer(),
        verifyingContract: HexOut(),
      }),
      to: HexOut(),
      value: Int("The amount in atomic token units, as the authorization signs it."),
      valid_after: Int(),
      valid_before: Int(),
      nonce: HexOut("The job id."),
    }),
  }),
  candidates: Type.Array(Candidate),
  accepts: Type.Array(Type.Object({ scheme: Type.String(), network: Type.String() })),
});

const Posted = Type.Object({
  job_id: HexOut(),
  task_cid: Type.String({ description: "The name this node filed the container under." }),
  tx_hash: HexOut(),
});

export function postRoutes(app: App, deps: RouteDeps): void {
  const pinner = pinnerFor(deps.config, deps.db);
  const serialized = subjectQueue("posts");
  const limiter = jobLimiter(deps.config.jobRateLimit);

  // Reconcile-on-error (R3/R4), shared with `POST /evm/ops`. `cancel` is the one
  // op on this door a `NotOpen` can reach; `post` cannot, because a job that does
  // not exist yet has no row to repair.
  const repair = repairOnRefusal(
    deps.chain,
    deps.db,
    deps.config.addresses.jobRegistry,
    (error, jobId, reason) =>
      app.log.error({ err: error, jobId, reason }, "reconcile-on-refusal failed"),
  );

  // Built on first use rather than at registration: the app is constructible
  // without a chain (every chain-backed route then answers `503`), and the cache
  // must outlive the request, so it can be neither eager nor per-request.
  let params: ChainParams | null = null;
  const configOf = (chain: Chain): ChainParams =>
    (params ??= chainParams(chain, deps.config.addresses));

  app.post(
    "/v1/jobs",
    {
      bodyLimit: MAX_BODY_BYTES,
      onSend: neverChallengeAfterBytes,
      // After parsing, before validation: an order needs the chain and a probe
      // does not, and only the parsed body says which this is. A node with no
      // chain answers an order `503` before its shape, as it always has.
      preValidation: async (request) => {
        if (!isProbe(request.body)) requireChain(deps.chain);
      },
      schema: {
        tags: ["jobs"],
        summary: "Probe, quote or submit a job",
        body: JobBody,
        response: {
          201: Posted,
          402: Type.Union([Quote, Type.Object({ candidates: Type.Array(Candidate) })]),
          409: Type.Union([ErrorEnvelope, Quote]),
          ...errors(400, 413, 429, 503, 504),
        },
      },
    },
    async (request, reply) => {
    const body = request.body;

    // ---- the market probe: no bid named, so nothing signed -----------------
    //
    // Every order carries both rates, so a body with neither is a client asking
    // for the market before it signs anything: every live ask for the model and
    // window, ranked as the challenge ranks them, and nothing to pay yet. It
    // needs no signature because it commits to nothing — which in a browser is
    // one wallet prompt fewer per job. An open probe advances the rotation
    // exactly as an open challenge does.
    if (isProbe(body)) {
      const job = {
        modelId: BigInt(body.model_id),
        slaSecs: BigInt(body.sla_secs),
        designated: BigInt(body.designated ?? 0),
        rateIn: 0n,
        rateOut: 0n,
        unitsIn: BigInt(body.units_in),
        unitsOut: BigInt(body.units_out),
      };
      const ranked = await rankProviders(deps.db, job, {
        livenessMs: deps.config.match.livenessMs,
        limit: deps.config.match.candidates,
        market: true,
      });
      const first = ranked[0];
      if (first !== undefined && job.designated === 0n) {
        await markAssigned(deps.db, first.provider_id, job.modelId);
      }
      return reply
        .code(402)
        .header("x-vorq-retryable", "false")
        .send({ candidates: ranked.map((c) => candidateOf(c, deps.config.addresses.decimals)) });
    }

    const chain = requireChain(deps.chain);
    const params = configOf(chain);
    const { terms, owner, jobId, signature } = parseOrder(body, deps.config.addresses.decimals);

    // Exactly one of `container` and `container_cid`, or neither on a challenge.
    const content = parseContent(body);
    if (content !== null) {
      // Recorded before anything else can fail, so the hook cannot miss a
      // request whose body carried the container: the whole point of that guard
      // is the paths this handler does not take.
      carriedBytes.add(request);
    }

    // ---- everything free, before anything that costs a round trip ----------

    const now = BigInt(Math.floor(Date.now() / 1000));
    // `(now, now+86400]`, the contract's own two bounds (R24). No margin either
    // side: the node's clock is a pre-check and the simulate catches a boundary
    // miss with the chain's own `AlreadyExpired` / `ExpiryTooFar`.
    if (terms.expiresAt <= now || terms.expiresAt > now + MAX_EXPIRY_SECONDS) {
      throw badRequest(`expires_at must be in (now, now+${MAX_EXPIRY_SECONDS}]`, "expires_at");
    }
    // Ahead of the SLA read, and that order is the bound: see MAX_SLA_SECONDS.
    if (terms.slaSecs > MAX_SLA_SECONDS) {
      throw badRequest(`sla_secs must be at most ${MAX_SLA_SECONDS}`, "sla_secs");
    }

    let cap: bigint;
    try {
      cap = capOf(terms);
    } catch (error) {
      if (!(error instanceof CapOverflowError)) throw error;
      throw new ApiError(400, "invalid_request", error.message, "rate_in", "cap_overflow");
    }

    if (!(await recovers(orderTypedData(deps.config.addresses.chainId, deps.config.addresses.jobRegistry, terms), owner, signature))) {
      throw new ApiError(
        400,
        "invalid_request",
        "signature does not recover to owner over this order",
        "signature",
        "invalid_order_signature",
      );
    }

    // Ahead of the challenge, so a wallet at its limit is told before it is
    // asked to sign a payment, and behind the order signature, so the count is
    // only ever read for a wallet that proved it is the one asking.
    limiter.check(owner, terms.modelId);

    // ---- no payment: the challenge ----------------------------------------

    if (!hasPayment(body)) {
      // One cached `eth_call`, one bounded ranking read and nothing else.
      // Deliberately no catalog read, no SLA read and **no pin**: the quote is
      // computed from the signed terms alone, which is exactly why the
      // challenge needs no bytes, and the candidates are one indexed query over
      // `provider_presence`. This door is unauthenticated, and the work it does
      // per request is the bound; the cursor bump it makes touches a row the
      // provider's own poll created, so nothing here can grow a table.
      //
      // A body that carried the container never leaves here as a `402`:
      // {@link neverChallengeAfterBytes} rewrites it on the way out. The branch
      // is deliberately left plain — putting the condition here as well would
      // give the invariant two homes, and deleting either one would then break
      // nothing (R67).
      return reply
        .code(402)
        // Explicit, per R57. The identical request will be answered 402 forever;
        // what changes the answer is a signature, which is a different request.
        .header("x-vorq-retryable", "false")
        .send(await quote(params, cap, jobId, terms));
    }

    // ---- payment: the free checks first ------------------------------------

    // The other half of the door's shape: a payment with no container cannot be
    // relayed, because the name this node puts on chain comes from filing the
    // bytes or from an upload that already holds them.
    if (content === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "container or container_cid is required with auth_sig: this node files the bytes and " +
          "puts the name it mints into order.taskCid, so a submission without them cannot be " +
          "relayed",
        "container",
        "container_required",
      );
    }

    const { authSig, amount } = parsePayment(body, deps.config.addresses.decimals);

    const authorization = authorizationTypedData(deps.config.addresses, {
      from: owner,
      to: deps.config.addresses.jobRegistry,
      value: amount,
      validBefore: terms.expiresAt + 1n,
      jobId,
    });
    if (!(await recovers(authorization, owner, authSig))) {
      throw new ApiError(400, "invalid_request",
        "auth_sig does not recover to owner over the quoted payment authorization",
        "auth_sig", "invalid_payment_signature");
    }

    // ---- the index, then the chain ----------------------------------------

    const { rows: models } = await deps.db.query<{ enabled: boolean }>(
      "SELECT enabled FROM models WHERE model_id = $1",
      [terms.modelId],
    );
    // Existence and enablement in one row (R5): a retired model is refused here
    // rather than by fronting gas for a `ModelDisabled` revert.
    if (models[0]?.enabled !== true) {
      throw badRequest("model_id names no enabled model", "model_id");
    }

    if (!(await configRead(() => params.slaAllowed(Number(terms.slaSecs))))) {
      throw badRequest("sla_secs is not an SLA this chain allows", "sla_secs");
    }

    // The last of the "refuse rather than front gas for a revert" checks, and the
    // only one whose revert lands on somebody else's transaction: the payment
    // token validates `receiveWithAuthorization` through `SignatureChecker`, so a
    // payer carrying code is routed to ERC-1271 and its plain EOA signature —
    // which `recovers` above accepts, because that is pure `ecrecover` — fails
    // inside the token at **claim**. Without this read the node pins the
    // container, fronts the gas, posts, and the job then rests Open to expiry
    // with nothing anywhere naming the cause.
    if (await viewRead("payer_code_read", () => chain.hasCode(owner))) {
      throw new ApiError(
        400,
        "invalid_request",
        `owner ${owner} carries contract code, and this payment cannot be collected: the ` +
          "payment token validates a code-bearing authorizer through ERC-1271, not ecrecover, " +
          "so the claim would revert. Pay from an account with no code — an undelegated EOA — " +
          "or remove the account's EIP-7702 delegation and post again",
        "owner",
        "payer_has_code",
      );
    }

    const { rows: existing } = await deps.db.query<{ job_id: Buffer }>(
      `SELECT job_id FROM jobs WHERE job_id = $1 AND NOT (${UNCONFIRMED})`,
      [Buffer.from(jobId.slice(2), "hex")],
    );
    // R37: `c` is spent the moment a post lands, by anyone — an observer can
    // front-run this very post with a garbage `authSig`. The remedy is a fresh
    // `c`, never a retry, which is why this is not retryable.
    //
    // **An idempotent retry was designed here and deliberately not shipped, and
    // the reason is not caution — it is that this node cannot tell the two cases
    // apart.** The wanted behaviour is easy to state: on a repeated `jobId` whose
    // stored row matches the incoming request in every particular, answer the
    // original `201` again instead of costing a client a fresh DEK, a fresh
    // container and a full re-upload for a dropped connection. What it needs is a
    // field that a front-runner cannot reproduce, and there is none:
    //
    //   * `jobs` is a **pure projection of `Posted`** (R44: drop it and a replay
    //     must rebuild it byte-identical), and `Posted` carries `owner`, `c`,
    //     `modelId`, `slaSecs`, `designated`, the rates, the unit counts,
    //     `expiresAt` and `taskCid` — and **neither signature**. So `order_sig`
    //     is not a column that exists, and it is not a column that *could* exist
    //     without the rebuild path having nowhere to read it from.
    //   * Adding it would not help anyway. Every one of those values, the order
    //     signature included, is public calldata in the very transaction this
    //     node broadcasts; a front-runner copies them verbatim out of the mempool.
    //     The only field that differs in the attack R37 describes is `authSig`,
    //     which is not in `Posted` either, is `delete`d from the job by `claim`,
    //     and is exposed by no view — and which an attacker can equally well copy
    //     unchanged.
    //   * `task_cid` does not separate them either: it is on chain, so the same
    //     copy reproduces it, and the store names bytes by their content, so the
    //     name it would mint for a genuine retry is the same name.
    //
    // A comparison built from those columns therefore accepts an attacker's row
    // as the caller's own, and hands back a `job_id`, a `task_cid` and a
    // `tx_hash` for a job whose `authSig` is garbage and which no provider can
    // ever claim — while telling the client it succeeded. That is strictly worse
    // than the refusal it replaces, which at least leaves the client able to act.
    // The refusal stands, and the pre-check stays here, ahead of the bytes.
    //
    // What would actually settle it is evidence this node holds and an observer
    // cannot forge: that the transaction which posted this `jobId` was sent by
    // **this node's own relayer account**. That is a chain read of the posting
    // transaction's sender, not a column, and it is out of this change's scope.
    //
    // **`UNCONFIRMED` rows are excluded, and that exclusion is load-bearing.**
    // Every sentence above reasons from "a row for this `jobId` means the chain
    // has this job", which held while only the indexer (indexed logs) or
    // `reconcileJob` (a confirmed `getJob`) could create one. Write-through rows
    // are written from a *latest* receipt, so a reorg that orphans a post now
    // leaves a row for a job the chain never kept — and refusing on it would
    // lock the client out of re-posting **its own unspent order** with a
    // non-retryable `409` whose only remedy is a fresh `c`: a fresh DEK, a fresh
    // container and a full re-upload, paid for a chain event that was nobody's
    // fault. Ahead of the cursor the row is not yet evidence, so it does not get
    // to refuse. Nothing is lost by letting those through: the simulate inside
    // the queue below runs before a single byte is pinned or attached, and it
    // reverts `DuplicateJob` from the chain itself whenever the job really is
    // there. This pre-check only ever saved that one `eth_call`.
    if (existing.length > 0) throw duplicateJob();

    // ---- the drift check ----------------------------------------------------

    // `bust()` first: the cell has a 60 s TTL and the quote this client signed
    // may well have populated it, so without the bust the node would compare the
    // signed amount against its own cached copy of the number that drifted.
    params.bust();
    const gasFee = await configRead(() => params.gasFee());
    const feeBps = await configRead(() => params.feeBps());
    if (amount !== cap + feeOf(cap, feeBps) + gasFee) {
      // The signed authorization no longer matches `cap + feeCap + gasFeeSnap`, so the
      // job would post and never claim. A fresh quote, in the 402's own shape,
      // and nothing relayed.
      return reply
        .code(409)
        .header("x-vorq-retryable", "false")
        .send(await quote(params, cap, jobId, terms, gasFee, feeBps));
    }

    // ---- the commitment ----------------------------------------------------

    // The one check no other party can make: no contract sees a container, and
    // a job posted over bytes that miss their commitment can never be claimed
    // by anyone while its escrow is committed the moment it would be. The `400`
    // names `container` rather than `c`: `c` is signed and the container is not,
    // so the container is the half a caller can put right.
    //
    // An upload is checked against `files.commitment` — what `POST /v1/files`
    // computed while the bytes streamed past it — rather than by reading the
    // object back. The bytes are content-addressed, so the stored commitment is
    // a statement about the very object `container_cid` names.
    const ownerKey = Buffer.from(owner.slice(2), "hex");
    const upload =
      content.kind === "cid"
        ? await findUpload(deps.db, { cid: content.cid, owner: ownerKey, purpose: "input" })
        : null;
    try {
      if (content.kind === "inline") assertCommitment(content.bytes, terms.c);
      else if (upload === null) throw unknownContainer(content.cid);
      // `0x` for a row with no commitment, which matches no `c`: an `input`
      // upload always carries one, so a mismatch is the honest answer rather
      // than a 500 over a column that should not be null.
      else assertSameCommitment(`0x${(upload.commitment ?? Buffer.alloc(0)).toString("hex")}`, terms.c);
    } catch (error) {
      if (!(error instanceof ContainerError)) throw error;
      throw new ApiError(400, "invalid_request", error.message, "container", error.fault);
    }

    // One encoder for the preflight and for the relay, so the transaction the
    // chain passes verdict on differs from the one that is broadcast in the
    // `taskCid` alone.
    const calldataFor = (taskCid: Hex): Hex =>
      encodeFunctionData({
        abi: jobRegistryAbi,
        functionName: "post",
        args: [
          {
            c: terms.c,
            modelId: Number(terms.modelId),
            slaSecs: Number(terms.slaSecs),
            rateIn: terms.rateIn,
            rateOut: terms.rateOut,
            unitsIn: Number(terms.unitsIn),
            unitsOut: Number(terms.unitsOut),
            designated: Number(terms.designated),
            expiresAt: terms.expiresAt,
            // A `post` **parameter**, and no longer a signed member: the name
            // did not exist when the client signed, because this node had not
            // minted it yet.
            taskCid,
          },
          owner,
          signature,
          authSig,
        ],
      });

    // Serialised on the `job_id`, for the same reason `/evm/ops` serialises on
    // its subject (R66): two posts of one `job_id` both simulate against the
    // same pre-post state, both pass, and the loser reverts `DuplicateJob`
    // **after the relayer has paid for its execution**. Behind the queue the
    // loser re-simulates against the state the winner produced and is refused for
    // free. It needs no forgery — an SDK retrying a slow response does it by
    // accident.
    //
    // The wallet's slot is taken ahead of the queue and given back when the
    // post is refused: a refusal costs the caller nothing against its limit. A
    // `504` keeps it, because that transaction was broadcast and may yet mine.
    const release = limiter.take(owner, terms.modelId);
    return serialized(`post:${jobId}`, async () => {
      // The chain's verdict *before* anything is stored or attached, on both
      // shapes — see the header. Inside the queue, so the duplicate it catches
      // is the one the index pre-check cannot see, and classified through the
      // same `chainFailure` the relay's own simulate uses: a caller gets the
      // answer the relay would have given it, one pin or one attach earlier.
      //
      // An inline post has no name yet, so it simulates under
      // {@link PLACEHOLDER_TASK_CID}; a cid post already knows the name it will
      // put on chain and simulates under that. The contract reads `taskCid` only
      // for non-emptiness, so the verdict is the same either way.
      try {
        await chain.publicClient.call({
          account: chain.account.address,
          data: calldataFor(
            content.kind === "inline" ? PLACEHOLDER_TASK_CID : taskCidHex(content.cid),
          ),
          to: deps.config.addresses.jobRegistry,
        });
      } catch (error) {
        throw await chainFailure(error);
      }

      // **The bytes are filed — or the upload attached — inside the queue, after
      // the chain's verdict and immediately before the relay**, so nothing is
      // stored or granted retention for an order any earlier refusal (the
      // preflight above included) would have taken, the bytes are stored before
      // the transaction that names them is broadcast, and a pin that fails
      // relays nothing at all. The reverse order is the one that cannot be
      // repaired: a posted job whose payload was never stored is escrow
      // committed against a name that resolves to nothing.
      //
      // A relay that fails after a successful pin leaves an orphan object and no
      // chain state. That is the cheap direction and it is retry-safe: the same
      // bytes land on the same name, and the chain refuses a second post of the
      // same `jobId` outright. The file sweep removes the orphan once it is past
      // retention.
      let taskCid: string;
      if (content.kind === "inline") {
        taskCid = await throughPinner(request, () => put(pinner, content.bytes));
      } else {
        taskCid = content.cid;
        // The upload stops being storage this node owes nobody and starts being
        // a job's payload. `false` means the sweep's 300 s window closed on it
        // between `findUpload` and here, so there is nothing left to name and
        // nothing is relayed.
        const attached = await attachFile(
          deps.db,
          { cid: content.cid, owner: ownerKey, purpose: "input" },
          deps.config.fileRetentionSeconds,
        );
        if (!attached) throw unknownContainer(content.cid);
      }

      // `task_cid` on the success body, and only there: the caller cannot
      // compute this name and has nothing to read it from until the post is
      // indexed. A failed relay keeps the failure envelope it already had.
      //
      // The row is written from the receipt before the `201` goes out, so the
      // job is readable the moment its caller learns it exists. A post with no
      // receipt writes nothing here: the indexer picks its log up at finality,
      // which is the only repair path this door has and the one the `504` names.
      const registry = deps.config.addresses.jobRegistry;
      return relay(chain, registry, calldataFor(taskCidHex(taskCid)), reply, 201, { job_id: jobId, task_cid: taskCid }, {
        onReceipt: async (receipt) => {
          await writePostedRows(deps.db, registry, receipt.logs, receipt.blockNumber);
        },
      });
    }).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.type === "receipt_timeout")) release();
      throw error;
    });
    },
  );

  app.post(
    "/v1/jobs/:id/cancel",
    {
      bodyLimit: MAX_ORDER_ENVELOPE_BYTES,
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["jobs"],
        summary: "Cancel an open job",
        description:
          "Signed by the owner over `Cancel {jobId, issuedAt}`; the chain checks the signature. " +
          "`issued_at` within ±600 s of this node's clock.",
        params: Type.Object({ id: Hex32({ description: "The job id." }) }),
        body: Type.Object({
          issued_at: SafeUint({ description: "Unix seconds." }),
          signature: Sig65(),
        }),
        response: {
          200: Type.Object({ job_id: HexOut(), tx_hash: HexOut() }),
          409: ErrorEnvelope,
          ...errors(400, 413, 429, 503, 504),
        },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const jobId = request.params.id.toLowerCase() as Hex;
    const issuedAt = BigInt(request.body.issued_at);
    const signature = request.body.signature as Hex;

    // The job-op regime, not the registry one (R33): ±600 s inclusive, no nonce,
    // because the one-shot state machine is the replay guard. Refused before an
    // `eth_call` is spent on an op the chain would refuse anyway.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (issuedAt + JOB_OP_WINDOW_SECONDS < now || issuedAt > now + JOB_OP_WINDOW_SECONDS) {
      throw refusal({ reason: "StaleOp", raw: null });
    }

    // Deliberately **not** recovered and compared here. The owner of a job is on
    // chain, not in this request, and `cancel` is the one entry point — there is
    // no `cancelFor` — so the signature is checked by the only party that holds
    // the answer, in the simulate below, for free. The width check above is what
    // keeps a malformed signature from reaching it.
    const data = encodeFunctionData({
      abi: jobRegistryAbi,
      functionName: "cancel",
      args: [jobId, issuedAt, signature],
    });

      return serialized(`cancel:${jobId}`, () =>
        // 200, not 201: cancel creates nothing. Same body as post (R16).
        relay(chain, deps.config.addresses.jobRegistry, data, reply, 200, { job_id: jobId }, {
          onRefusal: repair(jobId),
        }),
      );
    },
  );

  // -------------------------------------------------------------------------

  /**
   * The 402 body, and the 409 body when the quote goes stale — one shape (R15).
   *
   * `candidates` are the providers whose **published** ask clears these terms,
   * ranked as the matcher ranks them (cost, load, round-robin), at most
   * `MATCH_CANDIDATES`. The client seals to the first and pins it as
   * `designated`; an empty list is what makes an order rest open. Naming the
   * first advances its per-model cursor, so successive challenges at one price
   * rotate across equal providers instead of all naming the same one.
   */
  async function quote(
    chainConfig: ChainParams,
    cap: bigint,
    jobId: Hex,
    terms: Terms,
    known?: bigint,
    knownFeeBps?: number,
  ) {
    const gasFee = known ?? (await configRead(() => chainConfig.gasFee()));
    const feeBps = knownFeeBps ?? (await configRead(() => chainConfig.feeBps()));
    const fee = feeOf(cap, feeBps);
    const { addresses, match } = deps.config;
    const ranked = await rankProviders(deps.db, terms, {
      livenessMs: match.livenessMs,
      limit: match.candidates,
    });
    // Only an open order advances the rotation. A pinned order ranks exactly
    // its pin, so bumping it would let anyone who can sign a challenge push a
    // provider of their choosing to the back of every equal-price ranking.
    const first = ranked[0];
    if (first !== undefined && terms.designated === 0n) {
      await markAssigned(deps.db, first.provider_id, terms.modelId);
    }
    const amount = cap + fee + gasFee;
    const { decimals } = addresses;
    return {
      quote: {
        cap: formatUsd(cap, decimals),
        fee_bps: feeBps,
        fee: formatUsd(fee, decimals),
        gas_fee: formatUsd(gasFee, decimals),
        amount: formatUsd(amount, decimals),
        authorization: {
          // through the one builder `authorizationTypedData` signs with, so the quote and the
          // digest cannot describe different domains
          domain: tokenDomain(addresses),
          to: addresses.jobRegistry,
          value: amount,
          valid_after: 0n,
          valid_before: terms.expiresAt + 1n,
          nonce: jobId,
        },
      },
      candidates: ranked.map((c) => candidateOf(c, decimals)),
      accepts: [{ scheme: PAYMENT_SCHEME, network: `eip155:${addresses.chainId}` }],
    };
  }
}

/** One ranked provider as a `402` names it: who, the key to seal to, and its ask. */
const candidateOf = (candidate: Candidate, decimals: number) => ({
  provider_id: candidate.provider_id,
  box_key: candidate.box_key,
  rate_in: formatUsd(candidate.rate_in, decimals),
  rate_out: formatUsd(candidate.rate_out, decimals),
});

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

/**
 * A cached JobRegistry config read, wrapped the way every other chain call on
 * this door is (R72) — and then one step further, because a **read** is not a
 * transaction (R77).
 *
 * `gasFee` and `allowedSla` are `eth_call`s like any other, and an unwrapped one
 * answers `500 internal_error, retryable=false` for a dead endpoint — a third
 * answer to a cause this door already has two correct answers for. That is the
 * exact defect R72(a) names on the op door, one call site further along: the
 * quote path's `gasFee` read is the **first** chain call a post makes, so it is
 * where an unreachable RPC strikes first.
 *
 * `sendFailure` alone is not enough, and the comment that used to stand here
 * claiming it was is the reason R77 exists. `sendFailure`'s relayer branch falls
 * through to `400 invalid_request` whenever `isVerdict(error)` is true, and a
 * reverting `eth_call` **is** a verdict by that predicate — that is what the
 * predicate is for. But `isVerdict` answers *"did the endpoint pronounce on this
 * transaction"*, and these two reads are not the caller's transaction: they are
 * the node reading its own configuration. `allowedSla` and `gasFee` are storage
 * getters on a frozen contract and cannot revert when the configuration is
 * right — they revert when it is **wrong** (a `job_registry` address pointing at
 * some other contract, so the fallback reverts) or when the endpoint reports
 * unavailable historical state as `execution reverted`. In both cases every
 * caller of a correctly-formed `POST /v1/jobs` would be told, non-retryably and
 * with no field named, that *its* request is invalid — the exact false statement
 * R72 exists to prevent.
 *
 * So a `400` out of `sendFailure` is converted here, with its own `code` so an
 * operator sees which read failed rather than a generic relay outage.
 *
 * The rule itself now lives in `api/chain-failure.ts` as {@link viewRead}, one
 * definition for every view read in the node rather than a shape each door
 * re-derives — which is how three other doors came to be missing it while this
 * one had it. This wrapper survives as the name and the `code` this door's tests
 * are written against.
 */
const configRead = <T>(read: () => Promise<T>): Promise<T> => viewRead("config_read", read);

const duplicateJob = (): ApiError => refusal({ reason: "DuplicateJob", raw: null });

/**
 * `container_cid` names no `input` upload of this owner's.
 *
 * A miss, a stranger's upload, an upload under another purpose and an upload the
 * sweep has just deleted are **the same answer**, deliberately: a distinguishable
 * "that file belongs to someone else" would turn this door into an oracle for
 * which cids exist, and the cid is the whole reference.
 */
const unknownContainer = (cid: string): ApiError =>
  new ApiError(
    400,
    "invalid_request",
    `container_cid names no upload with purpose 'input' for this owner: ${cid}. Upload the ` +
      "container to POST /v1/files and post the cid it answers with, or send the container inline",
    "container_cid",
    "unknown_container",
  );

/**
 * The request field a contract error names, when it names one.
 *
 * `refusal` is reached from two directions — the index pre-check and an on-chain
 * revert — and "literally the same response for the same cause" is only true if
 * the *whole* body agrees, `param` included. Deriving it from the error name
 * rather than passing it at one call site is what makes that hold by
 * construction: the pre-check cannot pick a field the revert path would not.
 */
const REFUSAL_PARAM: ReadonlyMap<string, string> = new Map([
  // A duplicate is a duplicate `job_id`, whoever noticed it.
  ["DuplicateJob", "job_id"],
]);

/**
 * `409` — **the chain refused it**, or would have.
 *
 * `code` carries the contract's own error name verbatim, so the answer from the
 * index pre-check and the answer from an on-chain revert are literally the same
 * response for the same cause — same status, same `type`, same `code`, same
 * `param`, same `x-vorq-retryable`. Not retryable, per R57: re-sending identical
 * bytes cannot change a verdict on chain state. For `DuplicateJob` specifically
 * the remedy is a fresh `c` and a new order (R37), never a retry.
 */
function refusal(revert: { reason: string; raw: Hex | null }): ApiError {
  const detail = revert.reason === "unknown" && revert.raw !== null ? ` (${revert.raw})` : "";
  return new ApiError(
    409,
    "invalid_request",
    `the chain refused this transaction: ${revert.reason}${detail}`,
    REFUSAL_PARAM.get(revert.reason) ?? null,
    revert.reason,
  );
}

/**
 * Every chain failure on this door, classified once (R72).
 *
 * **A refusal is a verdict only if the endpoint actually returned one.** This
 * door is relayer-funded from end to end — the node builds the transaction and
 * pays for it — so an unreachable endpoint, a rate limit or an empty relayer
 * wallet is the node's failure and answers `503`, retryably, never a `409` that
 * tells a client the chain has pronounced on its order.
 */
async function chainFailure(
  error: unknown,
  onRefusal?: (reason: string) => Promise<void>,
): Promise<ApiError> {
  if (!isVerdict(error)) return sendFailure(error);
  const revert = decodeRevert(error, ABIS);
  // Reconcile-on-error (R3/R4). `cancel` is the one op on this door that can be
  // refused `NotOpen`, and when it is, the caller is a client that read the book
  // and believed its own job was still open — the same staleness the ops door
  // repairs, arriving from the other side of the market.
  if (onRefusal !== undefined) await onRefusal(revert.reason);
  // Returned rather than thrown so the repair above cannot be skipped by a call
  // site that forgets to await: `throw await chainFailure(…)` is the only way to
  // use this, and it does not typecheck any other way.
  return refusal(revert);
}

/**
 * `eth_call` the exact transaction, then send it, then wait for its receipt.
 *
 * The simulate runs **from the relayer's own address**, because that is who
 * would send it; a simulate from anyone else is a simulate of a different
 * transaction. It costs no gas and it is the only thing standing between a bad
 * order and a paid revert — and it is what catches the `DuplicateJob` race that
 * the index pre-check can only narrow.
 *
 * `chain.relay`, never `walletClient.sendTransaction`: sends from the relayer
 * account are serialised process-wide because its nonce is a single counter, and
 * two overlapping sends sign the same one (R66).
 */
async function relay(
  chain: Chain,
  to: Address,
  data: Hex,
  reply: FastifyReply,
  status: 200 | 201,
  body: Record<string, unknown>,
  hooks: RelayHooks = {},
): Promise<FastifyReply> {
  const { onRefusal, onReceipt } = hooks;
  // At `latest`, not the node's floor: the contract reads `block.timestamp`
  // here (`AlreadyExpired`, `ExpiryTooFar`), and a simulate at an older block
  // refused a valid 24 h order (measured 2026-09-23). See `atFloor`.
  try {
    await chain.publicClient.call({ account: chain.account.address, to, data });
  } catch (error) {
    throw await chainFailure(error, onRefusal);
  }

  let txHash: Hex;
  try {
    txHash = await chain.relay({ to, data });
  } catch (error) {
    // The **same** classifier as the simulate, deliberately. `"relayer"` funding
    // (R70) still decides the non-verdict cases — the node built these bytes and
    // pays for them, so a dead endpoint, an empty wallet or a nonce race is the
    // node's problem and is retryable — but a revert that reaches this stage is
    // the chain pronouncing just as much as one at the simulate, and answering
    // it `400` here while the simulate two lines above answers `409` would put
    // two mappings for one cause on one door.
    throw await chainFailure(error, onRefusal);
  }

  let receipt: TransactionReceipt;
  try {
    receipt = await chain.receipt(txHash, RECEIPT_TIMEOUT_MS);
  } catch {
    throw new ApiError(
      504,
      "receipt_timeout",
      `transaction ${txHash} was relayed but no receipt arrived within ${RECEIPT_TIMEOUT_MS} ms; ` +
        `read GET /v1/jobs/${body.job_id as string} rather than re-sending it — that read answers ` +
        "404 until this transaction's log reaches the index, so keep polling it rather than treating " +
        "the 404 as final",
      null,
      txHash,
    );
  }

  // **Before `send`**, and awaited: a client's first poll lands milliseconds after
  // this answer, so whatever the hook writes has to be committed, not started.
  await bestEffort(reply, "receipt hook failed", txHash, body, () => onReceipt?.(receipt));

  // No `as_of_block` (R28): nothing here was read from the index.
  return reply.code(status).send({ ...body, tx_hash: txHash });
}

/** What a door adds around {@link relay}. Every hook is optional. */
interface RelayHooks {
  /** A chain verdict refused the transaction. */
  onRefusal?: (reason: string) => Promise<void>;
  /** The transaction mined. */
  onReceipt?: (receipt: TransactionReceipt) => Promise<void>;
}

/**
 * Runs a hook whose failure must not change the answer: by the time it runs the
 * transaction is mined, and a `5xx` for a job that exists is the one answer that
 * must never be given. The failure goes to the log instead, and the row it did
 * not write is written by the indexer at finality like any other.
 */
async function bestEffort(
  reply: FastifyReply,
  message: string,
  txHash: Hex,
  body: Record<string, unknown>,
  hook: () => Promise<void> | undefined,
): Promise<void> {
  try {
    await hook();
  } catch (error) {
    // `job_id` as well as the hash: the operator's question after one of these is
    // which job is unreadable, and the answer is in the body being sent.
    reply.log.warn({ err: error, txHash, jobId: body.job_id }, message);
  }
}

