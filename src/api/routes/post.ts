import type { FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";
import { Type, type Static } from "typebox";
import type { Hex } from "viem";
import { chainParams, getJob, type Chain, type ChainParams } from "../../chain/client.js";
import type { Address } from "../../config.js";
import {
  cancelTypedData,
  capOf,
  CapOverflowError,
  feeOf,
  MAX_EXPIRY_SECONDS,
  MAX_SLA_SECONDS,
  orderTypedData,
  PAYMENT_SCHEME,
  type Terms,
} from "../../orders.js";
import { cancelHeld, holdOrder } from "../../match/held.js";
import { markAssigned, rankProviders, type Candidate } from "../../match/rank.js";
import { assertCommitment, assertSameCommitment, ContainerError } from "../../container.js";
import {
  hasAmount,
  parseAmount,
  parseContent,
  parseOrder,
  recovers,
  Submission,
  type Content,
} from "../../submission.js";
import { pinnerFor, put } from "../../pin/pinner.js";
import { chainGate, requireChain, type App, type RouteDeps } from "../deps.js";
import { viewRead } from "../chain-failure.js";
import { fundsOf, underOwnerFunds } from "../funding.js";
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
  Usd,
  UsdOut,
} from "../schemas/common.js";
import { usdParam } from "../usd.js";
import { attachFile, findUpload } from "./files.js";

/**
 * `POST /v1/jobs` — the 402 challenge and the submission — and
 * `POST /v1/jobs/{id}/cancel`.
 *
 * ## The flow, in one paragraph
 *
 * The order is **flat, chain-shaped terms**: the members of `Order` plus the
 * owner and its signature, each its own field. Every body on this door is JSON.
 * An order without `amount` is answered `402` with the quote — `cap`, the
 * protocol `fee` that `fee_bps` puts on top of it, the chain's `gas_fee`, their
 * sum as `amount` (what the claim will lock from the owner's prepaid balance),
 * the owner's available `balance`, and the `deposit` to make first: `0` when the
 * balance covers the order, otherwise the shortfall plus `deposit_fee`. The
 * client makes that deposit (`POST /v1/deposits`) and re-posts the same fields
 * with `amount` **echoed back** (R7), plus its sealed container. The node
 * re-checks everything it can check for free, re-reads `gasFee` and `feeBps`,
 * checks the balance, files the bytes and **holds the order**: a `jobs` row
 * carrying the order signature, which goes on chain inside the `claim` a
 * provider signs (`match/held.ts`). Nothing is relayed here.
 *
 * ## The container, inline or by name
 *
 * `task_cid` is not in the request: the client cannot know the name, because
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
 * Skipping it holds an order whose bytes miss their commitment — which every
 * provider re-derives and refuses.
 *
 * ## The body limit is the only bound
 *
 * {@link MAX_BODY_BYTES} is the bound and there is no cap on the decoded
 * container: a decoded cap on top of the body limit refuses a payload the door
 * has already read and parsed. A client with more than that uploads to
 * `/v1/files` first and posts the cid.
 *
 * ## Nothing is filed for an order that cannot be claimed
 *
 * Every free check — the order signature, the catalog row, the SLA, the
 * duplicate, the fees, the balance, the commitment — comes before the bytes are
 * filed or an upload is attached, so a refused order costs this node no storage.
 *
 * ## A body carrying content is never answered with a quote
 *
 * The challenge is computed from the signed terms alone, so it needs no bytes,
 * and a client that sent them anyway would be told to come back, uploading the
 * same megabytes a second time. The invariant is hung on the route as an
 * `onSend` hook ({@link neverChallengeAfterBytes}) rather than written as a
 * condition inside the branch that happens to send today's `402`: the hook
 * defends the door, including the paths nobody has written yet. What replaces
 * the would-be second challenge is a `400` naming `amount` with
 * `code: "container_without_payment"`, `x-vorq-retryable: false` (R57).
 *
 * The one re-quote that survives is the `409` below, and it is not a challenge:
 * `gasFee` or `feeBps` moved on chain since the quote, or the balance no longer
 * covers the order. It carries the fresh quote, it is `retryable: false`, and it
 * too is decided **before** the bytes are filed.
 *
 * ## What this door answers (R57 — retryability is the header, never the type)
 *
 * ```
 * 202 {job_id, task_cid}                held until a provider claims it
 * 200 {job_id}                          cancel: the order is ended (R16)
 * 402 {quote, accepts}                  the quote                      not retryable
 *                                       NEVER for a body with content
 * 400 invalid_request_error             the request is malformed       not retryable
 * 400 container_without_payment         the container arrived without  not retryable
 *                                       amount; do not re-upload it
 * 400 unknown_container                 container_cid names no input   not retryable
 *                                       upload of this owner's
 * 409 {error:{code:"DuplicateJob"}}     this job_id is already taken   not retryable
 * 409 {quote, accepts}                  a fee moved or the balance is  not retryable
 *                                       short; deposit and re-post
 * 413 body_too_large                    body past MAX_BODY_BYTES       not retryable
 * 429 busy                              too many posts of one job_id       RETRYABLE
 * 429 rate_limit_exceeded               the wallet's daily job limit   not retryable
 * 503 pinner_unavailable {code}         the bytes could not be filed       RETRYABLE
 * 503 chain_unreachable                 nothing answered at all            RETRYABLE
 * ```
 *
 * `task_cid` on the `202` is not decoration: this node mints it, and a caller
 * cannot compute it. The two `409`s are told apart by their body and never by
 * their status: a refusal carries `error`, a re-quote carries `quote` — the same
 * shape as the `402`, so a client has one code path for "cover this quote"
 * whichever status carried it.
 *
 * Registered **outside** the readiness gate and carrying no `as_of_block` (R28):
 * it reads only rows this node writes itself and the chain, never the indexed
 * projection's freshness.
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

/** Job ops are fresh within ±600 s inclusive against the node's clock (R24, R33). */
const JOB_OP_WINDOW_SECONDS = 600n;

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
 * `402` is the one status in this protocol a client is *expected* to loop on: it
 * means "cover this and send the same request again". A `402` answered to a body
 * that already carried the payload costs the client the **upload**, a second
 * time. Hung on the route, this holds for every path through the handler
 * including the ones that do not exist yet, and it is one deletion away from
 * being gone — which is what makes it testable (R67): deleting the hook from the
 * route options lets the `402` escape and `test/api-post.test.ts` goes red (R81).
 *
 * It **rewrites** rather than logs. A guard that only complains leaves the wrong
 * answer on the wire, and the wrong answer here is the whole cost.
 */
const CONTAINER_WITHOUT_PAYMENT = new ApiError(
  400,
  "invalid_request",
  "this body carries the container, so it is a complete submission and not a request for a " +
    "quote — send amount with it. The 402 challenge is computed from the signed terms " +
    "alone and must not carry the bytes: answering one here would ask for the same upload " +
    "twice.",
  "amount",
  "container_without_payment",
);

const neverChallengeAfterBytes: onSendHookHandler = async (request, reply, payload) => {
  if (reply.statusCode !== 402 || !carriedBytes.has(request)) return payload;
  reply
    .code(CONTAINER_WITHOUT_PAYMENT.status)
    // Re-stated because the reply already carries the `402`'s own header, and
    // `false` for a different reason: not "cover a quote", but "this body is
    // wrong". A `retryable: true` here would mean "resend the megabytes" — the
    // exact instruction this guard exists to withhold (R70).
    .header("x-vorq-retryable", String(isRetryable(CONTAINER_WITHOUT_PAYMENT.type)))
    .header("content-type", "application/json; charset=utf-8");
  // Serialised here rather than returned as an object: `onSend` is past the
  // serializer, so a payload handed back as an object reaches the socket as
  // `[object Object]`.
  return JSON.stringify(errorBody(CONTAINER_WITHOUT_PAYMENT));
};

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
  max_rate_in: Type.Optional(Usd({ description: "Only asks at or under this, USD per 1M input units." })),
  max_rate_out: Type.Optional(Usd({ description: "Only asks at or under this, USD per 1M output units." })),
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
    "within `max_rate_in` / `max_rate_out` where set, unsigned, answered `402 {candidates}`. **Challenge** (a signed order, no `amount`): " +
    "answered `402` with the quote: what the order locks and any deposit to make first. " +
    "**Submission** (order, `amount` and exactly one of `container`/`container_cid`): held, `202`, " +
    "until a provider's claim puts it on chain.",
  if: PROBE_TEST,
  then: MarketProbe,
  else: Submission,
});

const Candidate = Type.Object({
  provider_id: Int(),
  box_key: HexOut("The key to seal to."),
  rate_in: UsdOut(),
  rate_out: UsdOut(),
  rate_in_cached: UsdOut("USD per 1M cached input units, at most `rate_in`. Not signed."),
});

const Quote = Type.Object({
  quote: Type.Object({
    cap: UsdOut("The ceiling for the declared units, in USD."),
    fee_bps: Type.Integer(),
    fee: UsdOut(),
    gas_fee: UsdOut(),
    amount: UsdOut("cap + fee + gas_fee, in USD: what the claim locks from the prepaid balance."),
    balance: UsdOut("The owner's available prepaid balance: on chain, less what its open orders reserve."),
    deposit: UsdOut(
      "What to deposit before submitting: 0 when the balance covers amount, else the shortfall " +
        "plus deposit_fee.",
    ),
    deposit_fee: UsdOut("The flat fee the registry takes from each deposit."),
  }),
  candidates: Type.Array(Candidate),
  accepts: Type.Array(Type.Object({ scheme: Type.String(), network: Type.String() })),
});

const Held = Type.Object({
  job_id: HexOut(),
  task_cid: Type.String({ description: "The name this node filed the container under." }),
});

export function postRoutes(app: App, deps: RouteDeps): void {
  const pinner = pinnerFor(deps.config, deps.db);
  const serialized = subjectQueue("posts");
  const limiter = jobLimiter(deps.config.jobRateLimit);

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
          202: Held,
          402: Type.Union([Quote, Type.Object({ candidates: Type.Array(Candidate) })]),
          409: Type.Union([ErrorEnvelope, Quote]),
          ...errors(400, 413, 429, 503),
        },
      },
    },
    async (request, reply) => {
    const body = request.body;

    // ---- the market probe: no bid named, so nothing signed -----------------
    //
    // Every order carries both rates, so a body with neither is a client asking
    // for the market before it signs anything: every live ask for the model and
    // window within the ceilings it set, ranked as the challenge ranks them, and
    // nothing to pay yet. It
    // needs no signature because it commits to nothing — which in a browser is
    // one wallet prompt fewer per job. An open probe advances the rotation
    // exactly as an open challenge does.
    if (isProbe(body)) {
      const { decimals } = deps.config.addresses;
      const ceiling = (text: string | undefined, param: string) =>
        text === undefined ? null : usdParam(text, decimals, param, true);
      const job = {
        modelId: BigInt(body.model_id),
        slaSecs: BigInt(body.sla_secs),
        designated: BigInt(body.designated ?? 0),
        rateIn: ceiling(body.max_rate_in, "max_rate_in"),
        rateOut: ceiling(body.max_rate_out, "max_rate_out"),
        unitsIn: BigInt(body.units_in),
        unitsOut: BigInt(body.units_out),
      };
      const ranked = await rankProviders(deps.db, job, {
        livenessMs: deps.config.match.livenessMs,
        limit: deps.config.match.candidates,
      });
      const first = ranked[0];
      if (first !== undefined && job.designated === 0n) {
        await markAssigned(deps.db, first.provider_id, job.modelId);
      }
      return reply
        .code(402)
        .header("x-vorq-retryable", "false")
        .send({ candidates: ranked.map((c) => candidateOf(c, decimals)) });
    }

    const chain = requireChain(deps.chain);
    const params = configOf(chain);
    const { addresses } = deps.config;
    const { terms, owner, jobId, signature } = parseOrder(body, addresses.decimals);

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
    // side: the node's clock is a pre-check and the claim's simulate answers a
    // boundary miss with the chain's own `AlreadyExpired` / `ExpiryTooFar`.
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

    // `claim` recovers this same signature on chain; checking it here is what
    // keeps an order nobody can claim out of the book.
    if (!(await recovers(orderTypedData(addresses.chainId, addresses.jobRegistry, terms), owner, signature))) {
      throw new ApiError(
        400,
        "invalid_request",
        "signature does not recover to owner over this order",
        "signature",
        "invalid_order_signature",
      );
    }

    // Ahead of the challenge, so a wallet at its limit is told before it is
    // asked to deposit, and behind the order signature, so the count is only
    // ever read for a wallet that proved it is the one asking.
    limiter.check(owner, terms.modelId);

    // ---- no amount: the challenge ------------------------------------------

    if (!hasAmount(body)) {
      // Two cached config reads, the owner's balance, one bounded ranking read
      // and nothing else — no catalog read, no SLA read and **no pin**: the
      // quote is computed from the signed terms alone, which is exactly why the
      // challenge needs no bytes.
      //
      // A body that carried the container never leaves here as a `402`:
      // {@link neverChallengeAfterBytes} rewrites it on the way out. The branch
      // is deliberately left plain — putting the condition here as well would
      // give the invariant two homes, and deleting either one would then break
      // nothing (R67).
      return reply
        .code(402)
        // Explicit, per R57. The identical request will be answered 402 forever.
        .header("x-vorq-retryable", "false")
        .send(await quote(chain, params, cap, owner, terms));
    }

    // ---- a complete submission: the free checks first ----------------------

    // The other half of the door's shape: an order with no container cannot be
    // held, because the name `claim` puts on chain comes from filing the bytes
    // or from an upload that already holds them.
    if (content === null) {
      throw new ApiError(
        400,
        "invalid_request",
        "container or container_cid is required with amount: this node files the bytes and " +
          "puts the name it mints into order.taskCid, so a submission without them cannot be " +
          "claimed",
        "container",
        "container_required",
      );
    }

    const amount = parseAmount(body, addresses.decimals);

    const { rows: models } = await deps.db.query<{ enabled: boolean }>(
      "SELECT enabled FROM models WHERE model_id = $1",
      [terms.modelId],
    );
    // Existence and enablement in one row (R5): a retired model is refused here
    // rather than held for a claim that reverts `ModelDisabled`.
    if (models[0]?.enabled !== true) {
      throw badRequest("model_id names no enabled model", "model_id");
    }

    if (!(await configRead(() => params.slaAllowed(Number(terms.slaSecs))))) {
      throw badRequest("sla_secs is not an SLA this chain allows", "sla_secs");
    }

    // R37: `c` is spent the moment an order with it is held here or lands on
    // chain, and the remedy is a fresh `c`, never a retry. The row first — it is
    // free and it is where every order this node accepted lives — then the
    // chain, which answers for an id spent some other way (an owner's own
    // on-chain `cancel`, or a claim relayed by another coordinator).
    if (await isDuplicate(chain, jobId)) throw duplicateJob();

    // ---- the drift check and the balance -----------------------------------

    // `bust()` first: the cell has a 60 s TTL and the quote this client accepted
    // may well have populated it, so without the bust the node would compare the
    // amount against its own cached copy of the number that drifted.
    params.bust();
    const gasFee = await configRead(() => params.gasFee());
    const feeBps = await configRead(() => params.feeBps());
    if (amount !== cap + feeOf(cap, feeBps) + gasFee) {
      // The amount no longer matches `cap + feeCap + gasFee`: a fresh quote, in
      // the 402's own shape, and nothing held.
      return requote(reply, await quote(chain, params, cap, owner, terms, { gasFee, feeBps }));
    }

    // The claim locks `amount` from the prepaid balance, and the owner's other
    // open orders lock from the same balance. Short, the order would rest until
    // it expired with nothing able to claim it; the re-quote names the deposit.
    // Read here so a short balance files no bytes; the read the hold rests on is
    // made again under the owner's funds queue, below.
    const short = async (): Promise<boolean> =>
      (await fundsOf(chain, deps.db, addresses.jobRegistry, owner, feeBps, now)).available < amount;
    if (await short()) {
      return requote(reply, await quote(chain, params, cap, owner, terms, { gasFee, feeBps }));
    }

    // ---- the commitment ----------------------------------------------------

    // The one check no other party can make: no contract sees a container, and
    // an order over bytes that miss their commitment can never be worked. The
    // `400` names `container` rather than `c`: `c` is signed and the container
    // is not, so the container is the half a caller can put right.
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

    // Serialised on the `job_id` (R66): two posts of one order would otherwise
    // both pass the duplicate check above and both file the bytes. Behind the
    // queue the second finds the first's row and is refused before it files
    // anything. An SDK retrying a slow response does it by accident.
    //
    // The balance check the hold rests on and the hold itself run under the
    // owner's funds queue, which every other funds decision for this owner —
    // another post, a withdrawal, a batch line — also runs under: two of them
    // interleaved would both read one `available` and over-commit it.
    //
    // The wallet's slot is taken ahead of the queue and given back when the
    // order is refused: only an order this node holds counts against the limit.
    const release = limiter.take(owner, terms.modelId);
    return serialized(`post:${jobId}`, async () => {
      if (await heldRow(jobId)) throw duplicateJob();
      const taskCid = await file(request, content, ownerKey);
      return underOwnerFunds(owner, async () => {
        if (await short()) {
          release();
          return requote(reply, await quote(chain, params, cap, owner, terms, { gasFee, feeBps }));
        }
        const held = await holdOrder(deps.db, {
          jobId,
          owner,
          terms,
          taskCid,
          gasFee,
          orderSig: signature,
        });
        if (!held) throw duplicateJob();
        return reply.code(202).send({ job_id: jobId, task_cid: taskCid });
      });
    }).catch((error: unknown) => {
      release();
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
        summary: "Cancel an open order",
        description:
          "Signed by the owner over `Cancel {jobId, issuedAt}`; `issued_at` within ±600 s of this " +
          "node's clock. An open order is not on chain yet, so the cancel ends it in this node and " +
          "nothing is relayed. A claimed job is the provider's to resolve.",
        params: Type.Object({ id: Hex32({ description: "The job id." }) }),
        body: Type.Object({
          issued_at: SafeUint({ description: "Unix seconds." }),
          signature: Sig65(),
        }),
        response: {
          200: Type.Object({ job_id: HexOut() }),
          409: ErrorEnvelope,
          ...errors(400, 404, 413, 503),
        },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const jobId = request.params.id.toLowerCase() as Hex;
    const issuedAt = BigInt(request.body.issued_at);
    const signature = request.body.signature as Hex;

    // The job-op regime (R33): ±600 s inclusive, no nonce, because a cancelled
    // order cannot be cancelled twice.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (issuedAt + JOB_OP_WINDOW_SECONDS < now || issuedAt > now + JOB_OP_WINDOW_SECONDS) {
      throw refusal("StaleOp", "issued_at is not within 600 s of this node's clock", "issued_at");
    }

    const { chainId, jobRegistry } = deps.config.addresses;
    const outcome = await cancelHeld(
      deps.db,
      jobId,
      (signer) => recovers(cancelTypedData(chainId, jobRegistry, jobId, issuedAt), signer, signature),
      async () => (await getJob(chain, jobRegistry, jobId)).found,
    );
    switch (outcome) {
      case "cancelled":
        return reply.code(200).send({ job_id: jobId });
      case "unknown":
        throw new ApiError(404, "not_found", `no such job: ${jobId}`, "id");
      case "not_owner":
        throw refusal("NotTheOwner", "signature does not recover to the owner of this job", "signature");
      case "not_open":
        throw refusal(
          "NotOpen",
          "this job is no longer an open order: it was claimed, settled or cancelled",
          null,
        );
      case "leased":
        throw refusal(
          "order_leased",
          "a provider holds this order and may be claiming it now; cancel again once its lease " +
            "lapses unclaimed",
          null,
        );
    }
    },
  );

  // -------------------------------------------------------------------------

  /** Whether this node holds a row under `jobId`. */
  async function heldRow(jobId: Hex): Promise<boolean> {
    const { rows } = await deps.db.query("SELECT 1 FROM jobs WHERE job_id = $1", [
      Buffer.from(jobId.slice(2), "hex"),
    ]);
    return rows.length > 0;
  }

  /** Whether `jobId` is spent: a row here, or a row on chain. */
  async function isDuplicate(chain: Chain, jobId: Hex): Promise<boolean> {
    if (await heldRow(jobId)) return true;
    return (await getJob(chain, deps.config.addresses.jobRegistry, jobId)).found;
  }

  /**
   * Files the container, or adopts the upload that holds it, and answers the
   * name `claim` will put on chain.
   *
   * Inside the queue and after every refusal, so nothing is stored or granted
   * retention for an order any earlier check would have taken. A failed pin
   * holds nothing. A hold that fails after a pin leaves an orphan object, which
   * is the cheap direction: nothing names it, and the file sweep removes it once
   * it is past retention.
   */
  async function file(request: FastifyRequest, content: Content, ownerKey: Buffer): Promise<string> {
    if (content.kind === "inline") return throughPinner(request, () => put(pinner, content.bytes));
    // The upload stops being storage this node owes nobody and starts being an
    // order's payload. `false` means the sweep's 300 s window closed on it
    // between `findUpload` and here, so there is nothing left to name.
    const attached = await attachFile(
      deps.db,
      { cid: content.cid, owner: ownerKey, purpose: "input" },
      deps.config.fileRetentionSeconds,
    );
    if (!attached) throw unknownContainer(content.cid);
    return content.cid;
  }

  /**
   * The 402 body, and the 409 body when the quote goes stale — one shape (R15).
   *
   * `balance` is what the owner has available for a new order: its prepaid
   * balance on chain less what its open orders will lock. `deposit` is what it
   * must add first — `0` when `balance` covers `amount`, otherwise the shortfall
   * plus the `deposit_fee` the registry takes from the deposit itself, so the
   * deposit credits exactly the shortfall.
   *
   * `candidates` are the providers whose **published** ask clears these terms,
   * ranked as the matcher ranks them (cost, load, round-robin), at most
   * `MATCH_CANDIDATES`. The client seals to the first and pins it as
   * `designated`; an empty list is what makes an order rest open. Naming the
   * first advances its per-model cursor, so successive challenges at one price
   * rotate across equal providers instead of all naming the same one.
   */
  async function quote(
    chain: Chain,
    chainConfig: ChainParams,
    cap: bigint,
    owner: Address,
    terms: Terms,
    known?: { gasFee: bigint; feeBps: number },
  ) {
    const gasFee = known?.gasFee ?? (await configRead(() => chainConfig.gasFee()));
    const feeBps = known?.feeBps ?? (await configRead(() => chainConfig.feeBps()));
    const depositFee = await configRead(() => chainConfig.depositFee());
    const fee = feeOf(cap, feeBps);
    const amount = cap + fee + gasFee;
    const { addresses, match } = deps.config;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const { available } = await fundsOf(chain, deps.db, addresses.jobRegistry, owner, feeBps, now);
    const deposit = available >= amount ? 0n : amount - available + depositFee;
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
    const { decimals } = addresses;
    return {
      quote: {
        cap: formatUsd(cap, decimals),
        fee_bps: feeBps,
        fee: formatUsd(fee, decimals),
        gas_fee: formatUsd(gasFee, decimals),
        amount: formatUsd(amount, decimals),
        balance: formatUsd(available, decimals),
        deposit: formatUsd(deposit, decimals),
        deposit_fee: formatUsd(depositFee, decimals),
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
  rate_in_cached: formatUsd(candidate.rate_in_cached, decimals),
});

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

/** `409` with a fresh quote: not retryable, because the remedy is a deposit or a new amount. */
const requote = (reply: FastifyReply, body: unknown) =>
  reply.code(409).header("x-vorq-retryable", "false").send(body);

/**
 * A cached JobRegistry config read, classified as a **read** (R77).
 *
 * `gasFee`, `feeBps`, `depositFee` and `allowedSla` are storage getters on a
 * frozen contract: they cannot revert when this node is configured correctly,
 * so a failure is the node's — a dead endpoint, or a `job_registry` address that
 * points at some other contract — and never a verdict on the caller's order.
 * {@link viewRead} is the one definition of that rule; this name and its `code`
 * are what this door's tests are written against.
 */
const configRead = <T>(read: () => Promise<T>): Promise<T> => viewRead("config_read", read);

/**
 * `409` — refused, with the reason as `code`.
 *
 * Not retryable, per R57: re-sending the identical bytes cannot change the
 * answer. For `DuplicateJob` the remedy is a fresh `c` and a new order (R37).
 */
function refusal(code: string, message: string, param: string | null): ApiError {
  return new ApiError(409, "invalid_request", message, param, code);
}

const duplicateJob = (): ApiError =>
  refusal("DuplicateJob", "this job_id is already taken: sign a new order with a fresh c", "job_id");

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
