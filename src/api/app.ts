import { randomBytes } from "node:crypto";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import { Type } from "typebox";
import type { Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import type { EscrowKeys } from "../escrow/keys.js";
import type { KeyEpochStart } from "../escrow/release.js";
import { cursorBlock } from "../index/indexer.js";
import type { Indexer, IndexerStatus } from "../index/indexer.js";
import { registerCors } from "./cors.js";
import type { App, WireTypeProvider } from "./deps.js";
import { ApiError, fail } from "./errors.js";
import { escrowRoutes } from "./escrow.js";
import { askBookRoutes, askRoutes } from "./routes/asks.js";
import { authRoutes } from "./routes/auth.js";
import { batchCreateRoute, batchRoutes } from "./routes/batches.js";
import { catalogRoutes } from "./routes/catalog.js";
import { fileRoutes } from "./routes/files.js";
import { jobRoutes } from "./routes/jobs.js";
import { opsRoutes } from "./routes/ops.js";
import { postRoutes } from "./routes/post.js";
import { providerRoutes } from "./routes/providers.js";
import { relayRoutes } from "./routes/relay.js";
import { compileSchema, validationFailure } from "./schemas/ajv.js";
import { AsOfBlock, Int, Nullable } from "./schemas/common.js";
import { toJsonText } from "./serialize.js";

/**
 * The HTTP surface: app construction, the readiness gate, the JSON boundary and
 * the error handling. **The routes themselves live in `./routes/*.ts`** (R53) —
 * this file was 787 lines carrying eight of them when four more subject areas
 * were about to arrive, and a route module per subject is what keeps a feature
 * diff readable.
 *
 * One rule shapes what is left here.
 *
 * **A node answers from its index or not at all.** A readiness gate turns every
 * route registered inside the gated plugin into a `503` while the index trails
 * the chain. Serving a stale row without saying so is the failure this prevents;
 * `as_of_block` on every index-backed response is the other half of the same
 * promise.
 *
 * The corollary is what decides where a route goes, and R28 follows from it
 * rather than the other way round: a route that reads the **chain** rather than
 * the index — `/evm/chain`, `/evm/ops`,
 * `/evm/simulate/claim`, and the auth handshake — is registered **outside** the
 * gate and carries **no** `as_of_block`. Gating those would be actively wrong:
 * `/evm/simulate/claim` exists precisely to be meaningful during the finality
 * lag (R22), and a claim refused for a second because the index was catching up
 * is a claim a competitor takes.
 */

export interface AppOptions {
  db: Db;
  indexer: Indexer;
  config: Config;
  /**
   * The chain handle. Optional so a read-only app can be built without an RPC
   * endpoint; the chain-backed routes are still registered and answer `503
   * chain_unreachable`, so the route table never depends on how the app was
   * constructed — a route that silently vanished would be far worse than one
   * that says why it cannot answer.
   */
  chain?: Chain;
  /**
   * The escrow's held generations, on a node that hosts an escrow.
   *
   * Absent means this node holds no key material, which the escrow doors answer
   * exactly as `ESCROW_MODE=off` does — one refusal, one code. The routes
   * are registered either way (I2/P14): a door that vanished would answer `404`,
   * and "this node has no such endpoint" is a different claim from "this node
   * holds no keys".
   */
  escrowKeys?: EscrowKeys;
  /**
   * The escrow's clock, in milliseconds. Injected because `/release` bounds
   * `issued_at` to ±600 s, and a bound measured against `Date.now` is a bound no
   * test can stand either side of without sleeping.
   */
  escrowClock?: () => number;
  /**
   * When this node's custody of its key material began (Task 5/6), read fresh on
   * every request because a handover can move it. Absent means "not orphaned".
   */
  escrowKeyEpochStart?: () => KeyEpochStart | null;
  /** Fastify's logger option. Off by default, which keeps test output pristine. */
  logger?: FastifyServerOptions["logger"];
}

/**
 * The outcome of one readiness probe. A rejection is carried rather than
 * flattened into `ready: false`: "trailing the chain" heals itself and "the
 * chain is unreachable" needs an operator, and a caller that cannot tell them
 * apart will wait for the wrong one.
 */
type Probe = { ok: true; status: IndexerStatus } | { ok: false; error: unknown };

/**
 * The largest request body this API accepts, in bytes.
 *
 * Every write door is attacker-facing: `POST /evm/ops` carries provider-supplied
 * `evidence` and a settle's result bytes, and `POST /v1/jobs` a whole signed
 * order plus its container. Fastify's own default is 1 MiB; it is restated here
 * rather than inherited, because "what bounds this input" is a question this plan
 * has had to answer five times and the answer should be visible at the door.
 *
 * This is the value every door that declares nothing gets. The two that carry a
 * payload declare `MAX_BODY_BYTES` instead — one ceiling, shared, not a number
 * per door — and that limit is the whole bound on the payload: there is no
 * decoded cap behind it, because a cap applied after `JSON.parse` has already
 * spent the allocation it existed to prevent. A caller with more than the
 * ceiling uploads to `POST /v1/files`, where the bytes are streamed rather than
 * held. See `./limits.ts` for why the inline threshold is derived from it.
 */
const BODY_LIMIT_BYTES = 1024 * 1024;

export function buildApp({
  db,
  indexer,
  config,
  chain,
  escrowKeys,
  escrowClock,
  escrowKeyEpochStart,
  logger = false,
}: AppOptions): App {
  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // Always minted here. Fastify's default takes `request-id` from the client
    // when present, which would let a caller choose the id in the logs.
    requestIdHeader: false,
    genReqId: () => `req_${randomBytes(8).toString("hex")}`,
  }).withTypeProvider<WireTypeProvider>();

  // Route schemas validate through `schemas/ajv.ts`: bodies uncoerced, path and
  // query parameters coerced from their digits.
  app.setValidatorCompiler(compileSchema);
  app.decorateRequest("session", null);

  // **Root instance, before everything, and outside the readiness gate.** The
  // gate is the encapsulated plugin at the bottom of this file; a preflight
  // registered inside it would answer 503 while the index trails the chain,
  // which a browser reports as an opaque CORS failure rather than as a node
  // catching up. Registering nothing at all is the default — see ./cors.ts.
  registerCors(app, config);

  /**
   * Every response body goes through the one JSON boundary — success and
   * failure alike. Non-2xx bodies carry `bigint`s too (`/readyz`, and the 402
   * and 409 bodies later tasks add), so a serializer wired only into the happy
   * path would throw exactly where the node is already in trouble.
   */
  app.setReplySerializer((payload) => toJsonText(payload));
  // Response schemas are the published contract, not a second serializer: the
  // reply serializer above wins over them, and compiling them into one anyway
  // would spend startup on code that never runs.
  app.setSerializerCompiler(() => toJsonText);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      // The one refusal an operator has to act on: the relayer cannot pay gas, so
      // every relay on this node is being dropped until the wallet is topped up.
      if (error.code === "relayer_funds") {
        request.log.error({ err: error }, "relayer is out of gas funds; relays are failing");
      }
      return fail(reply, error);
    }
    // A route schema refused the request: answered in the same envelope as every
    // other refusal, naming the field and, where a client branches on it, the code.
    const { validation, validationContext } = error as FastifyError;
    if (validation !== undefined) {
      return fail(reply, validationFailure(validation as never, validationContext ?? "body"));
    }
    // Fastify's own body-parse and payload-size failures arrive here with a
    // status of their own; reporting them as 500s would tell a caller its
    // request was the node's fault.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = error instanceof Error ? error.message : "invalid request";
      // The oversized body is named rather than left to Fastify's English: it is
      // the one 4xx a client answers by doing something specific — upload the
      // bytes to `/v1/files` and re-post the cid — so it is the one it has to be
      // able to recognise without string-matching.
      const tooLarge = (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE";
      return fail(
        reply,
        new ApiError(status, "invalid_request", message, null, tooLarge ? "body_too_large" : null),
      );
    }
    // Anything else is a bug or a failed dependency: logged in full, reported as
    // nothing. An internal message on the wire is how connection strings leak.
    request.log.error({ err: error }, "unhandled error");
    return fail(reply, new ApiError(500, "internal", "internal error"));
  });

  app.setNotFoundHandler((request, reply) =>
    fail(reply, new ApiError(404, "not_found", `Unknown route: ${request.method} ${request.url}`)),
  );

  // -------------------------------------------------------------------------
  // Readiness, probed at most once per poll interval
  // -------------------------------------------------------------------------

  // The gate runs before every route, and readiness cannot change faster than
  // the indexer polls: without this cache each request would cost a head round
  // trip and a cursor read for an answer that is already known. The
  // promise is stored rather than the value, so a burst arriving on a cold cell
  // shares one probe.
  let probe: { at: number; result: Promise<Probe> } | null = null;

  function readiness(): Promise<Probe> {
    const now = Date.now();
    if (probe !== null && now - probe.at < config.blockTimeMs) return probe.result;

    // Never rejects: the failure is a value, so the cached promise cannot become
    // an unhandled rejection while it waits for its next reader.
    const result = indexer.status().then(
      (status): Probe => ({ ok: true, status }),
      (error): Probe => ({ ok: false, error }),
    );
    probe = { at: now, result };
    return result;
  }

  // The API reference: the spec every route schema below contributes to, and a
  // browsable page over it. Outside the readiness gate like `/healthz`: the
  // reference does not depend on the index.
  app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "VORQ coordinator",
        version: "1",
        description:
          "Every refusal is `{error:{message,type,param,code}}`; whether the identical request " +
          "may succeed later is the `x-vorq-retryable` header. Integers wider than 32 bits, " +
          "rates and money travel as decimal strings; byte strings as 0x hex.",
      },
      // The node that serves this document: every node publishes its own.
      servers: [{ url: "/" }],
      // Open unless an operation names `bearerAuth`.
      security: [],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "A session token from `POST /auth/session`: `vorq_sess_…`.",
          },
        },
      },
    },
  });
  app.register(swaggerUi, { routePrefix: "/docs" });

  // Every route is registered inside this plugin so the spec above sees it: a
  // route added to the root before the swagger plugin loads never reaches it.
  app.register(async (scope) => {
    routes(scope.withTypeProvider<WireTypeProvider>(), {
      db,
      indexer,
      config,
      chain,
      escrowKeys,
      escrowClock,
      escrowKeyEpochStart,
      readiness,
    });
  });

  return app;
}

function routes(
  app: App,
  {
    db,
    config,
    chain,
    escrowKeys,
    escrowClock,
    escrowKeyEpochStart,
    readiness,
  }: Omit<AppOptions, "logger"> & { readiness: () => Promise<Probe> },
): void {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness",
        description: "`200` whenever the process serves HTTP. Reads nothing.",
        response: { 200: Type.Object({ status: Type.Literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  const ReadyBody = Type.Object({
    ready: Type.Boolean(),
    reason: Type.Union([
      Type.Literal("ready"),
      Type.Literal("trailing"),
      Type.Literal("cold_start"),
      Type.Literal("reorg"),
      Type.Literal("chain_unreachable"),
    ]),
    cursor: AsOfBlock,
    head_block: Nullable(Int()),
    lag: Nullable(Type.Integer({ description: "head_block − cursor, signed." })),
  });

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness",
        description:
          "`200` when the index is within the ready lag of the chain head, `503` otherwise. " +
          "`reason` says why: `trailing` heals itself, `chain_unreachable` needs an operator.",
        response: { 200: ReadyBody, 503: ReadyBody },
      },
    },
    async (_request, reply) => {
    const result = await readiness();

    if (!result.ok) {
      // Distinguishable from `trailing` by design, and by more than the status
      // code: the node cannot see the chain, so it cannot say how far behind it
      // is either, and reporting a lag of anything would be an invention.
      return reply.code(503).send({
        ready: false,
        reason: "chain_unreachable",
        cursor: null,
        head_block: null,
        lag: null,
      });
    }

    const { cursor, head, ready, forked } = result.status;
    // `cursor !== null`, not truthiness: on a fresh chain the head sits at 0 for
    // the first blocks and the cursor legitimately rests there, indexed and
    // caught up. `if (cursor)` would report that node as never having started.
    const started = cursor !== null;

    return reply.code(ready ? 200 : 503).send({
      ready,
      // `reorg` before `trailing`: a forked node has a cursor and may even be
      // within the lag, and reporting it as merely behind would promise a
      // recovery that no amount of waiting brings.
      reason: ready ? "ready" : forked !== null ? "reorg" : started ? "trailing" : "cold_start",
      cursor,
      head_block: head,
      // Signed, and deliberately not clamped at zero. A negative lag means the
      // index holds blocks this RPC endpoint has not reached — a failover to a
      // node that is itself behind, which the indexer already tolerates by
      // refusing to rewind the cursor. Clamping it to 0 would render that
      // condition as "perfectly caught up", hiding the one thing an operator
      // needs to see. It is a diagnostic, not a duration.
      lag: started ? head - cursor : null,
    });
    },
  );

  // -------------------------------------------------------------------------
  // Chain-backed routes, outside the gate
  // -------------------------------------------------------------------------

  // These never read the index, so index freshness has nothing to say about
  // them. `/evm/simulate/claim` is the sharpest case (R22): it is the advisory
  // pre-sign gate a daemon consults *during* the finality lag, and gating it
  // would make it answer 503 in exactly the window it exists for.
  authRoutes(app, { db, config, chain });
  relayRoutes(app, { db, config, chain });
  opsRoutes(app, { db, config, chain });
  // The client's write doors. Outside the gate for the same reason `/evm/ops`
  // is: the authority is the chain, the answer is a relayed transaction, and a
  // post refused for a second because the index was catching up is a job the
  // client cannot place. They carry no `as_of_block` (R28) — the duplicate
  // pre-check reads the index, but only as a free refusal ahead of the
  // authoritative on-chain simulate, exactly as `resolveProviderId` does.
  postRoutes(app, { db, config, chain });
  // The batch input door. Outside the gate because it reads no index at all: the
  // object store and this node's own `files` table are its whole dependency set,
  // so index freshness has nothing to say about an upload (R28).
  fileRoutes(app, { db, config, chain });
  // `POST /v1/batches` only. It reads one `files` row and inserts one `batches`
  // row — no index — and a client that has just uploaded its input should not be
  // refused because the indexer is a few blocks behind. The batch *reads* fold
  // over `jobs` and are registered inside the gate below.
  batchCreateRoute(app, { db, config, chain });
  // The provider's write door. Same reasoning: it relays, it does not read the index.
  askRoutes(app, { db, config, chain });
  // Plan 3's escrow doors, and the strongest case for being outside the gate
  // (P26). They read this process's own memory and the chain — never the index —
  // and a node catching up on log replay still holds every key it held a second
  // ago. Gated, an ordinary restart would look to a provider trying to release a
  // DEK exactly like key loss. Registered **unconditionally**: at
  // `ESCROW_MODE=off` the door exists and refuses `403 escrow_unavailable`,
  // because a route wired only when the mode is on answers `404`, which claims
  // something different and false (I2/P14).
  escrowRoutes(app, {
    config,
    keys: escrowKeys ?? null,
    chain,
    clock: escrowClock,
    keyEpochStart: escrowKeyEpochStart,
  });

  // -------------------------------------------------------------------------
  // Everything the index backs, behind the gate
  // -------------------------------------------------------------------------

  // Registered as a plugin so the gate is scoped by Fastify's encapsulation
  // rather than by a list of exempt paths that a later route must remember to
  // join. Plan 3's escrow routes read the chain, not the index, and belong
  // outside this scope for the same reason `/healthz` does.
  app.register(async (scope) => {
    const gated = scope.withTypeProvider<WireTypeProvider>();
    /**
     * **Every route in this scope can 503, and a client decides whether to retry
     * from the `x-vorq-retryable` header — never from `error.type`** (R57).
     *
     * There are two causes today, `not_ready` and `chain_unreachable`, and they
     * are deliberately distinguishable because they need different *human*
     * responses: the first heals itself, the second needs an operator. But a
     * client that switches on `type` to decide whether to retry breaks the day a
     * third cause appears, and it will. The header is the contract; the type is
     * diagnosis. Plans 3 and 4 inherit this on every gated route they add.
     */
    gated.addHook("onRequest", async () => {
      const result = await readiness();
      if (!result.ok) {
        throw new ApiError(
          503,
          "chain_unreachable",
          "chain unreachable; readiness cannot be determined",
        );
      }
      if (!result.status.ready) throw new ApiError(503, "not_ready", "index catching up");
    });

    /**
     * The block every index-backed response is stamped with.
     *
     * Read **before** the data on purpose. The cursor only advances, so reading
     * it first can only understate how fresh the answer is; reading it second
     * could claim a block the rows do not yet reflect, and a client polling for
     * `as_of_block >= n` would stop one block early.
     */
    const asOfBlock = (): Promise<bigint | null> => cursorBlock(db);

    // The epoch getter reaches the job book as well as `/release`: the book must
    // stop advertising jobs whose wraps name keys this node's custody never
    // covered (Task 6). Passed as the same function, not a snapshot — a handover
    // moves the marker.
    jobRoutes(gated, { db, config, chain }, asOfBlock, () => escrowKeyEpochStart?.() ?? null);
    providerRoutes(gated, db, asOfBlock);
    catalogRoutes(gated, db, asOfBlock);
    askBookRoutes(gated, db, config.addresses.decimals, asOfBlock);
    // Read, list and cancel. Every one of them answers with a fold over `jobs`,
    // so serving one while the index trails would be exactly the stale answer
    // this gate exists to refuse — cancel included, because its refusal ("this
    // batch already finished") is that same fold.
    batchRoutes(gated, { db, config, chain }, asOfBlock);
  });
}
