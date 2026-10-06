import { Type } from "typebox";
import { recoverTypedDataAddress } from "viem";
import {
  lastSignedAtOf,
  publishSnapshot,
  storeSnapshot,
  type StoredSnapshot,
} from "../../asks/publisher.js";
import { askSnapshotTypedData, PushBody, pushOf, SKEW_SECONDS } from "../../asks/push.js";
import type { Db } from "../../db/db.js";
import {
  chainGate,
  requireChain,
  resolveProviderId,
  sessionGate,
  type App,
  type RouteDeps,
} from "../deps.js";
import { ApiError, badRequest } from "../errors.js";
import { budgeted, pageOf, Paging } from "../paging.js";
import { AsOfBlock, BEARER, errors, HexOut, Int, Uint32, UsdOut } from "../schemas/common.js";
import { sendFailure } from "../chain-failure.js";
import { formatUsd } from "../../money.js";

/**
 * The ask surface: the provider's push door, and the public book.
 *
 * ## `PUT /evm/asks` — the push
 *
 * A provider signs a whole `AskSnapshot` and this node lands it on chain,
 * paying the gas. The node has no key that could author a price and never
 * invents one: the snapshot's signature is the only authority, and it is
 * resolved through the providers projection to the `provider_id` the snapshot
 * names.
 *
 * **The session is a transport gate and nothing else** (R14). It is required —
 * this door writes a durable row and spends the relayer's gas, so it is not a
 * surface to leave open to anyone with a socket — but the session's address and
 * the recovered signer are deliberately never compared, exactly as on
 * `/evm/ops`. Comparing them would imply the session carried an authority it
 * does not have, and a node that trusted a session here would be a node that
 * could publish prices for a provider that never signed them.
 *
 * ```
 * 200 {provider_id, signed_at, published, tx_hash}   landed on chain
 * 400 invalid_request_error   malformed / too many quotes / clock skew   not retryable
 * 401 authentication_error    no session                                 not retryable
 * 403 invalid_op_signature    the signer is not that provider            not retryable
 * 409 invalid_request_error   stale, or superseded on chain              not retryable
 * 413                         body past this door's own limit            not retryable
 * 503 relay_unavailable       the node could not land it                     RETRYABLE
 * 503 chain_unreachable       nothing answered at all                        RETRYABLE
 * 504 receipt_timeout         broadcast, no receipt in time              not retryable
 * ```
 *
 * Retryability travels in `x-vorq-retryable` and never in `error.type` (R57).
 * Registered **outside** the readiness gate and carrying no `as_of_block`
 * (R28): it reads the chain and writes a row the index does not own.
 *
 * **A registered but *unlisted* provider may push, and this node will pay to
 * publish quotes its own `GET /evm/asks` will never show.** That asymmetry is
 * deliberate, and it is the one place the two halves of this file disagree
 * about who counts. The chain is the one quote surface: `AskRegistry.setAsks`
 * has no listing gate, so a snapshot refused here would still be publishable by
 * the provider itself, and refusing it would make this node's book a second
 * authority over what the chain may hold. The book filters on `listed` because
 * an unlisted provider cannot be claimed against and quoting it would advertise
 * work nobody can take — a statement about *this node's* recommendations, not
 * about the provider's right to publish.
 *
 * ## `GET /evm/asks` — the book
 *
 * The other half, and the opposite in every respect: unauthenticated, gated,
 * stamped with `as_of_block`, and served **straight from `asks_chain`**. The
 * chain is the one quote surface — `quotes_live` is what the node has promised
 * to publish, `asks_chain` is what the chain actually holds, and only the second
 * is something a client may act on.
 */

/**
 * The largest push body this door accepts, in bytes.
 *
 * A 64-quote snapshot with maximal `uint128` rates measures about 8 kB; 32 kB is
 * that with room for whitespace and a longer spelling of every number. The bound
 * exists here rather than being inherited from `app.ts`'s 1 MiB, because
 * `JSON.parse` runs synchronously on the event loop **before** any handler sees
 * the body, and a limit chosen for another door's `evidence` is not a limit
 * chosen for this one. Past it Fastify answers `413` without reading the rest of
 * the stream.
 */
export const MAX_PUSH_BYTES = 32 * 1024;

/** Wall clock, in seconds, as the chain's `block.timestamp` is measured. */
const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/**
 * Every chain failure on this door, classified by the **one** classifier (R70,
 * R72 — "do not build a second one").
 *
 * This door is relayer-funded end to end: the node builds the transaction and
 * pays for it. So a dead endpoint, a rate limit, an empty relayer wallet or a
 * full relay queue is the *node's* failure and `sendFailure`'s relayer envelope
 * answers `503`, retryably. Answering a `409` there would tell a provider daemon
 * the chain refused its prices and that retrying is pointless, and both would be
 * false. `sendFailure` keeps the one case that is still a verdict — the endpoint
 * pronounced on this transaction, which `isVerdict` decides inside it.
 *
 * Worth saying out loud for this door in particular: `setAsks` **skips rather
 * than reverts** for everything a provider can get wrong, so there is almost
 * nothing here for a verdict to be about. The refusals that matter are made
 * before the relay, and the one that cannot be — the chain skipping the entry
 * anyway — is answered by the publisher's confirmation, not by an error class.
 */
function chainFailure(error: unknown): never {
  throw sendFailure(error);
}

export function askRoutes(app: App, deps: RouteDeps): void {
  app.put(
    "/evm/asks",
    {
      bodyLimit: MAX_PUSH_BYTES,
      // The transport gate ahead of the parse, so an anonymous caller never
      // reaches the validation, the recover, the store or the relayer's gas.
      onRequest: [chainGate(deps.chain), sessionGate(deps.db)],
      schema: {
        tags: ["asks"],
        summary: "Publish an ask snapshot",
        description:
          "The provider's whole book, signed; this node lands it on chain and pays the gas. " +
          "The session is a transport gate only: the signature is the authority. " +
          "`409 stale_snapshot` or `superseded` when a newer snapshot stands.",
        security: BEARER,
        body: PushBody,
        response: {
          200: Type.Object({
            provider_id: Int(),
            signed_at: Int(),
            published: Type.Literal(true),
            tx_hash: HexOut(),
          }),
          ...errors(400, 401, 403, 409, 413, 503, 504),
        },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const push = pushOf(request.body, deps.config.addresses.decimals);

    // The chain's own clock-skew skip, mirrored (R29's other half). An accepted
    // push that the chain then skips for skew would raise this node's monotonic
    // floor above the chain's forever and brick the provider's book.
    if (push.signedAt > nowSeconds() + SKEW_SECONDS) {
      throw badRequest(
        `snapshot.signed_at is more than ${SKEW_SECONDS} s ahead of this node's clock; ` +
          "the chain skips such a snapshot rather than reverting it",
        "snapshot.signed_at",
      );
    }

    // Authority. One ECDSA recover, no chain access, and it happens before
    // anything that costs a round trip.
    let signer: `0x${string}`;
    try {
      signer = await recoverTypedDataAddress({
        ...askSnapshotTypedData(push.snapshot, chain.chain.id, deps.config.addresses.askRegistry),
        signature: `0x${push.signature.toString("hex")}`,
      });
    } catch {
      throw new ApiError(
        403,
        "invalid_op_signature",
        "signature does not recover over the AskSnapshot typed data",
        null,
        "invalid_signature",
      );
    }

    let providerId: bigint;
    try {
      providerId = await resolveProviderId(deps, Buffer.from(signer.slice(2), "hex"));
    } catch (error) {
      chainFailure(error);
    }
    if (providerId === 0n) {
      throw new ApiError(
        403,
        "invalid_op_signature",
        "the snapshot's signer is not a registered provider",
        null,
        "not_registered",
      );
    }
    // The snapshot names its own provider and `setAsks` skips a mismatch, so a
    // real operator cannot publish for somebody else's id — here or on chain.
    if (providerId !== push.providerId) {
      throw new ApiError(
        403,
        "invalid_op_signature",
        "the snapshot's signer operates a different provider than snapshot.provider_id",
        "snapshot.provider_id",
        "provider_mismatch",
      );
    }

    // The floor is `max(stored, chain)` (R11). The stored half alone is not
    // enough: `quotes_live` is durable but droppable in operator practice, and a
    // node whose row is gone would accept a replay of an old signed snapshot
    // that `AskRegistry.lastSignedAt` still stands above. The chain half alone
    // is not enough either: it lags an accepted-but-unpublished push by exactly
    // the window this node is responsible for.
    const stored = await readQuoteRow(deps.db, providerId);
    let chainFloor: bigint;
    try {
      chainFloor = await lastSignedAtOf(chain, deps.config, providerId);
    } catch (error) {
      chainFailure(error);
    }

    const storedFloor = stored?.signed_at ?? 0n;
    const publishedFloor = stored?.published_signed_at ?? 0n;
    const floor = storedFloor > chainFloor ? storedFloor : chainFloor;

    // The one admitted equality: an identical re-push of a snapshot this node
    // accepted and never proved published. Without it, a push whose relay
    // answered `503 retryable` could never be retried — the row it stored would
    // refuse it as stale forever, which is precisely what `retryable` promises
    // cannot happen (R57).
    const retryOfUnpublished =
      stored !== null && push.signedAt === storedFloor && publishedFloor < storedFloor;

    if (push.signedAt <= floor && !(retryOfUnpublished && push.signedAt > chainFloor)) {
      throw new ApiError(
        409,
        "invalid_request",
        `snapshot.signed_at ${push.signedAt} is not newer than this provider's floor ${floor}; ` +
          "the chain would skip it",
        "snapshot.signed_at",
        "stale_snapshot",
      );
    }

    // Stored **before** the relay, deliberately. The alternative — publish, then
    // store — loses the snapshot entirely if the process dies after the
    // broadcast, and the chain would then hold prices this node cannot explain.
    // This way the crash window leaves a row `startPublisher` finds.
    // The write is monotonic and lives beside `markPublished`, the other writer
    // of this row's monotonic pair (B-8).
    await storeSnapshot(deps.db, providerId, push.snapshotText, push.signature, push.signedAt);

    // Deliberately the object that was just stored, not a re-read of it:
    // `push.snapshotText` is `JSON.stringify` of this same object, so the row
    // and the calldata are provably the same values and cannot diverge, and a
    // `SELECT` here would cost a round trip to learn nothing. The boot sweep
    // *does* re-read, because there the storing process is gone and the row is
    // the only account of what the provider signed — that is the path where
    // "the stored values are the calldata" (R54a) has to be enforced rather
    // than argued.
    const row: StoredSnapshot = {
      providerId,
      signedAt: push.signedAt,
      snapshot: push.snapshot,
      signature: push.signature,
    };

    let outcome;
    try {
      outcome = await publishSnapshot(chain, deps.db, deps.config, row);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      chainFailure(error);
    }

    if (outcome.kind === "superseded") {
      throw new ApiError(
        409,
        "invalid_request",
        `a newer snapshot (signed_at ${outcome.lastSignedAt}) is already on chain for this ` +
          "provider, so this one was skipped and can never be published",
        "snapshot.signed_at",
        "superseded",
      );
    }

    if (outcome.kind === "skipped") {
      // R29 in one branch: the transaction succeeded and proved **nothing**.
      // The row stays unpublished, so nothing has bricked, and the answer is
      // retryable because the only skip a validated snapshot can still meet is
      // the chain's own clock skew — which resolves as block time advances.
      throw new ApiError(
        503,
        "relay_unavailable",
        `transaction ${outcome.txHash} mined but the chain shows no publication for this ` +
          `snapshot (lastSignedAt ${outcome.lastSignedAt}); setAsks skips rather than reverts, ` +
          "so nothing was recorded as published. Retry shortly.",
        null,
        "publication_skipped",
      );
    }

    // R17's body, exactly. No `as_of_block` (R28): nothing here was read from
    // the index.
    return reply.code(200).send({
      provider_id: providerId,
      signed_at: push.signedAt,
      published: true,
      tx_hash: outcome.txHash,
    });
    },
  );
}

/** The stored floor for one provider, or `null`. */
async function readQuoteRow(
  db: Db,
  providerId: bigint,
): Promise<{ signed_at: bigint; published_signed_at: bigint } | null> {
  // `BIGINT` columns, so `bigint` in JS (R45). Never `count(*)`, never a row
  // handed to a serialiser.
  const { rows } = await db.query<{ signed_at: bigint; published_signed_at: bigint }>(
    "SELECT signed_at, published_signed_at FROM quotes_live WHERE provider_id = $1",
    [providerId],
  );
  return rows[0] ?? null;
}

const ModelFilter = Uint32({ description: "An integer `model_id`, not a model name." });

export function askBookRoutes(
  gated: App,
  db: Db,
  decimals: number,
  asOfBlock: () => Promise<bigint | null>,
): void {
  gated.get(
    "/evm/asks",
    {
      schema: {
        tags: ["asks"],
        summary: "The ask book",
        description:
          "Every live ask of every listed provider, straight from what the chain holds. " +
          "A withdrawn slot is absent, never a zero.",
        querystring: Type.Object({ model: Type.Optional(ModelFilter), ...Paging }),
        response: {
          200: Type.Object({
            asks: Type.Array(
              Type.Object({
                provider_id: Int(),
                model_id: Int(),
                sla: Int("The window, in seconds."),
                rate_in: UsdOut("USD per 1M input units."),
                rate_out: UsdOut("USD per 1M output units."),
              }),
            ),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 503),
        },
      },
    },
    async (request, reply) => {
    const page = pageOf(request.query);
    const { model } = request.query;
    const modelId = model === undefined ? null : BigInt(model);
    const asOf = await asOfBlock();

    const { rows } = await db.query<{
      provider_id: bigint;
      model_id: bigint;
      sla: bigint;
      rate_in: bigint;
      rate_out: bigint;
    }>(
      // Listed providers only: an unlisted provider cannot be claimed against,
      // so quoting its prices would be advertising work nobody can take. The
      // rows themselves are never filtered by rate — a withdrawn slot is
      // `rateOut == 0` on chain, which the reducer applies as a DELETE (R35),
      // so `asks_chain` never holds one.
      `SELECT a.provider_id, a.model_id, a.sla, a.rate_in, a.rate_out
         FROM asks_chain a
         JOIN providers p ON p.provider_id = a.provider_id
        WHERE p.listed AND ($1::bigint IS NULL OR a.model_id = $1)
        ORDER BY a.provider_id, a.model_id, a.sla
        LIMIT $2 OFFSET $3`,
      [modelId, page.limit, page.offset],
    );

    return {
      // Bounded in rows and in bytes, with truncation signalled in a header
      // (R56, R58). The stop condition has two halves and both are required:
      // keep paging while `returned === limit` OR `x-vorq-page-truncated` is
      // `true` (R61).
      asks: budgeted(rows, page, reply, (row) => ({
        provider_id: row.provider_id,
        model_id: row.model_id,
        sla: row.sla,
        rate_in: formatUsd(row.rate_in, decimals),
        rate_out: formatUsd(row.rate_out, decimals),
      })),
      as_of_block: asOf,
    };
    },
  );

  /**
   * The cheapest ask per `(model, window)`, over listed providers.
   *
   * Both legs are minimised INDEPENDENTLY: the cheapest input rate and the
   * cheapest output rate need not come from one provider, and this is a floor
   * rather than a quote. Joined to `models` because `asks_chain.model_id` is an
   * unvalidated uint32 — a slot naming a model the catalog does not carry
   * cannot be ordered against (`post` refuses it) and must not appear here.
   *
   * **The window side is bounded by `sla`, not by the join.** `asks_chain.sla`
   * is the other unvalidated uint32 and a push is an upsert, so one provider
   * can accumulate arbitrarily many distinct windows on a real catalog model
   * and make the unfiltered listing as long as it likes. A caller pricing a
   * job knows the window it wants: `sla` reads that single `(model, window)`
   * row, and the listing's length stops being an input anyone else controls.
   *
   * A withdrawn slot is a DELETE in `asks_chain` (see the book above), so no
   * rate filtering is needed.
   */
  gated.get(
    "/evm/asks/floors",
    {
      schema: {
        tags: ["asks"],
        summary: "Cheapest ask per model and window",
        description:
          "Both legs are minimised independently over listed providers, so a floor is not " +
          "a quote any one provider made. Pass `sla` to read one window.",
        querystring: Type.Object({
          model: Type.Optional(ModelFilter),
          sla: Type.Optional(Uint32({ description: "The window, in seconds." })),
          ...Paging,
        }),
        response: {
          200: Type.Object({
            floors: Type.Array(
              Type.Object({ model_id: Int(), sla: Int(), rate_in: UsdOut(), rate_out: UsdOut() }),
            ),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 503),
        },
      },
    },
    async (request, reply) => {
    const page = pageOf(request.query);
    const { model, sla } = request.query;
    const modelId = model === undefined ? null : BigInt(model);
    const slaWindow = sla === undefined ? null : BigInt(sla);
    const asOf = await asOfBlock();

    const { rows } = await db.query<{
      model_id: bigint;
      sla: bigint;
      rate_in: bigint;
      rate_out: bigint;
    }>(
      `SELECT a.model_id, a.sla, MIN(a.rate_in) AS rate_in, MIN(a.rate_out) AS rate_out
         FROM asks_chain a
         JOIN providers p ON p.provider_id = a.provider_id
         JOIN models m ON m.model_id = a.model_id
        WHERE p.listed AND ($1::bigint IS NULL OR a.model_id = $1)
          AND ($4::bigint IS NULL OR a.sla = $4)
        GROUP BY a.model_id, a.sla
        ORDER BY a.model_id, a.sla
        LIMIT $2 OFFSET $3`,
      [modelId, page.limit, page.offset, slaWindow],
    );

    return {
      floors: budgeted(rows, page, reply, (row) => ({
        model_id: row.model_id,
        sla: row.sla,
        rate_in: formatUsd(row.rate_in, decimals),
        rate_out: formatUsd(row.rate_out, decimals),
      })),
      as_of_block: asOf,
    };
    },
  );
}
