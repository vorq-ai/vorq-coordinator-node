import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import { batchCounts, batchStatus } from "../../batches/fold.js";
import { batchObject } from "../../batches/object.js";
import { batchLineStates, listBatches, readBatch, type BatchRecord } from "../../batches/store.js";
import { sessionGate, sessionOf, type App, type RouteDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import {
  AsOfBlock,
  BEARER,
  errors,
  HexOut,
  Int,
  Nullable,
  SafeUint,
  Uint32,
  Usd,
  UsdOut,
} from "../schemas/common.js";
import { planBatch } from "../../match/plan.js";
import { formatUsd } from "../../money.js";
import { usdParam } from "../usd.js";
import { attachFile, MAX_BATCH_LINES } from "./files.js";

/**
 * `/v1/batches` — create, read, list, cancel.
 *
 * OpenAI's shape, and none of OpenAI's storage. What a `batches` row carries is
 * only what a fold cannot produce: the window, the two file ids, and the handful
 * of stamps the worker owns. **Status and counts are computed on every read**
 * from the member jobs (`src/batches/fold.ts`), joined through `batch_lines`,
 * which is what makes a counter that has drifted from the rows it counts
 * impossible by construction.
 *
 * ## Where these routes sit relative to the readiness gate
 *
 * Split, and on the gate's own rule rather than by resource:
 *
 *   * **create** is outside. It reads no index at all — one `files` row and one
 *     insert — and a client that has just uploaded its input should not be
 *     refused because the indexer is a few blocks behind. Same reasoning as
 *     `POST /v1/jobs` (R28).
 *   * **read, list and cancel** are inside, and carry `as_of_block`. Every one of
 *     them answers with a fold over `jobs`, and serving a stale fold without
 *     saying so is exactly what the gate exists to prevent — cancel included,
 *     because its refusal ("this batch already finished") is that same fold.
 */

/** The two endpoints a batch line may name. */
const ENDPOINTS = ["/v1/responses", "/v1/embeddings"] as const;

/**
 * Windows, in seconds.
 *
 * A superset of OpenAI's, whose enum is `24h` alone: `1h` is offered because the
 * window **is** the per-line SLA this network signs, and an hour is a real SLA a
 * provider quotes. A client written against OpenAI sends `24h` and is unaffected.
 */
const WINDOWS = { "1h": 3600n, "24h": 86400n } as const;

/** OpenAI's own metadata bounds: 16 pairs, 64-char keys, 512-char string values. */
const MAX_METADATA_PAIRS = 16;
const MAX_METADATA_KEY_CHARS = 64;
const MAX_METADATA_VALUE_CHARS = 512;

/** Entries one plan may name: a bound on the work an unsigned read does. */
const MAX_PLAN_MODELS = 16;

/** One page of `GET /v1/batches`. OpenAI's default and ceiling. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const CompletionWindow = Type.Enum(["1h", "24h"], {
    description: "The window, and the SLA every line is signed for.",
    "x-vorq-error": { code: "invalid_completion_window" },
  },
);

const Metadata = Type.Record(
  Type.String(),
  Type.String({ maxLength: MAX_METADATA_VALUE_CHARS }),
  {
    maxProperties: MAX_METADATA_PAIRS,
    propertyNames: { maxLength: MAX_METADATA_KEY_CHARS },
    description: `At most ${MAX_METADATA_PAIRS} pairs, ${MAX_METADATA_KEY_CHARS}-character keys, ${MAX_METADATA_VALUE_CHARS}-character values.`,
  },
);

const BatchCreate = Type.Object({
  input_file_id: Type.String({ description: "A `POST /v1/files` upload with `purpose=batch`." }),
  endpoint: Type.Enum(ENDPOINTS, { "x-vorq-error": { code: "invalid_endpoint" } }),
  completion_window: CompletionWindow,
  metadata: Type.Optional(Metadata),
});

const BatchPlan = Type.Object({
  completion_window: CompletionWindow,
  models: Type.Array(
    Type.Object({
      model_id: Uint32(),
      lines: Uint32({ minimum: 1, maximum: MAX_BATCH_LINES }),
      units_in: SafeUint({ description: "The total over this model's lines." }),
      units_out: SafeUint({ description: "The total over this model's lines." }),
      max_rate_in: Type.Optional(Usd({ description: "The most these lines pay per 1M input units, in USD." })),
      max_rate_out: Type.Optional(Usd({ description: "The most these lines pay per 1M output units, in USD." })),
    }),
    { minItems: 1, maxItems: MAX_PLAN_MODELS },
  ),
});

/**
 * Two bodies on one door, told apart by `input_file_id`: with it, a create;
 * without it, a plan. `if`/`then`/`else` rather than `oneOf`, so a refusal names
 * the field that is wrong in the shape the caller sent.
 */
const BatchBody = Type.Unsafe<Static<typeof BatchCreate> | Static<typeof BatchPlan>>({
  type: "object",
  description:
    "**Create** (`input_file_id` present): a batch over an uploaded file. " +
    "**Plan** (no `input_file_id`): which providers would take how many lines, at which ask, " +
    "within each entry's `max_rate_in` / `max_rate_out`, answered `402` with nothing signed " +
    "and nothing reserved.",
  if: { required: ["input_file_id"] },
  then: BatchCreate,
  else: BatchPlan,
});

const Batch = Type.Object({
  id: Type.String(),
  object: Type.Literal("batch"),
  endpoint: Type.String(),
  input_file_id: Type.String(),
  completion_window: Type.String(),
  status: Type.Union(
    ["validating", "in_progress", "finalizing", "completed", "failed", "expired", "cancelling", "cancelled"]
      .map((status) => Type.Literal(status)),
  ),
  errors: Nullable(
    Type.Object({
      object: Type.Literal("list"),
      data: Type.Array(
        Type.Object({ code: Type.String(), message: Type.String(), line: Nullable(Type.Integer()) }),
      ),
    }),
  ),
  output_file_id: Nullable(Type.String()),
  error_file_id: Nullable(Type.String()),
  created_at: Type.Integer(),
  expires_at: Type.Integer(),
  in_progress_at: Nullable(Type.Integer()),
  finalizing_at: Nullable(Type.Integer()),
  completed_at: Nullable(Type.Integer()),
  failed_at: Nullable(Type.Integer()),
  expired_at: Nullable(Type.Integer()),
  cancelling_at: Nullable(Type.Integer()),
  cancelled_at: Nullable(Type.Integer()),
  request_counts: Type.Object({
    completed: Type.Integer(),
    failed: Type.Integer(),
    total: Type.Integer(),
  }),
  metadata: Type.Record(Type.String(), Type.String()),
  vorq: Type.Object({ sla: Type.String() }),
});

const BatchRead = Type.Object({ ...Batch.properties, as_of_block: AsOfBlock });

const PlanResponse = Type.Object({
  plan: Type.Array(
    Type.Object({
      model_id: Int(),
      lines: Int(),
      allocation: Type.Array(
        Type.Object({
          provider_id: Int(),
          box_key: HexOut("The key to seal this provider's lines to."),
          rate_in: UsdOut(),
          rate_out: UsdOut(),
          lines: Int(),
        }),
        { description: "Cheapest first. Fewer lines than asked means the network cannot take them now." },
      ),
    }),
  ),
});

const BatchId = Type.Object({ batch_id: Type.String() });

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** `batch_` and 12 random bytes. Nothing is derived from it and nothing parses it. */
const mintBatchId = (): string => `batch_${randomBytes(12).toString("hex")}`;

/**
 * The batch object, folded. `now` is taken once per request so the expiry the
 * status is decided against is the same instant the counts were read at.
 */
async function render(deps: RouteDeps, row: BatchRecord) {
  const now = nowSeconds();
  const counts = batchCounts(await batchLineStates(deps.db, row.batch_id, now));
  return { object: batchObject(row, counts, now), counts, now };
}

export function batchCreateRoute(app: App, deps: RouteDeps): void {
  app.post(
    "/v1/batches",
    {
      onRequest: sessionGate(deps.db),
      schema: {
        tags: ["batches"],
        summary: "Create a batch, or plan one",
        security: BEARER,
        body: BatchBody,
        response: { 200: Batch, 402: PlanResponse, ...errors(400, 401) },
      },
    },
    async (request, reply) => {
    const session = sessionOf(request);
    const body = request.body;

    // ---- the plan: no file yet, so nothing signed ---------------------------
    //
    // A client asks first how the network would take its lines: per entry, which
    // providers within the entry's ceilings, at which ask, and how many lines
    // each — never past a provider's on-chain capacity (`match/plan.ts`). It seals each line
    // to its allotted provider and then uploads and creates as usual. Nothing is
    // held, so the answer is about now.
    if (!("input_file_id" in body)) {
      const window = WINDOWS[body.completion_window];
      const { decimals } = deps.config.addresses;
      const ceiling = (text: string | undefined, param: string) =>
        text === undefined ? null : usdParam(text, decimals, param, true);
      const requests = body.models.map((m, i) => ({
        modelId: BigInt(m.model_id),
        slaSecs: window,
        lines: BigInt(m.lines),
        unitsIn: BigInt(m.units_in),
        unitsOut: BigInt(m.units_out),
        maxRateIn: ceiling(m.max_rate_in, `models[${i}].max_rate_in`),
        maxRateOut: ceiling(m.max_rate_out, `models[${i}].max_rate_out`),
      }));
      const plans = await planBatch(deps.db, requests, { livenessMs: deps.config.match.livenessMs });
      return reply
        .code(402)
        .header("x-vorq-retryable", "false")
        .send({
          plan: requests.map((r, i) => ({
            model_id: r.modelId,
            lines: r.lines,
            allocation: (plans[i] ?? []).map((a) => ({
              ...a,
              rate_in: formatUsd(a.rate_in, decimals),
              rate_out: formatUsd(a.rate_out, decimals),
            })),
          })),
        });
    }

    const { endpoint, input_file_id: inputFileId, metadata = {} } = body;
    const window = WINDOWS[body.completion_window];

    // Owner and purpose in the same predicate as the id, so **every** way of
    // failing this check produces one answer. A distinguishable "that file
    // belongs to someone else" would turn this door into an oracle for whether a
    // file id exists, which is the only thing standing between one client's batch
    // input and another's.
    const { rows: files } = await deps.db.query<{ file_id: string }>(
      "SELECT file_id FROM files WHERE file_id = $1 AND owner = $2 AND purpose = 'batch'",
      [inputFileId, session.address],
    );
    const unknownInputFile = (): ApiError =>
      new ApiError(
        400,
        "invalid_request",
        `No such file with purpose 'batch': ${inputFileId}`,
        "input_file_id",
        "invalid_input_file",
      );
    if (files[0] === undefined) throw unknownInputFile();

    // The file stops being an upload nobody claimed and gets retention rather
    // than the 300 s the sweep would otherwise reap it after. Scoped by file id
    // because ownership was settled by the predicate above, and idempotent, so
    // creating a second batch from the same input file leaves the same expiry.
    //
    // **Before the row, and the answer is not optional.** `false` means the
    // sweep's window closed on the file between the select above and here, so
    // there is nothing left to validate; a batch inserted first would sit in
    // `validating` naming an object that no longer exists, and the worker would
    // fail it line by line. Same refusal as a file that was never there — the
    // caller uploads again and creates the batch, which is the one remedy either
    // way.
    if (!(await attachFile(deps.db, { fileId: inputFileId }, deps.config.fileRetentionSeconds))) {
      throw unknownInputFile();
    }

    const created = nowSeconds();
    const batchId = mintBatchId();
    // `validating`, and the worker owns the transition out of it. At 50 000 lines
    // the split, the pins and the `postMany` run behind this answer; a row that
    // started `in_progress` with no lines would fold to `completed` on the very
    // first read.
    await deps.db.query(
      `INSERT INTO batches (batch_id, owner, endpoint, completion_window, input_file_id,
                            status, created_at, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, 'validating', $6, $7, $8::jsonb)`,
      [
        batchId,
        session.address,
        endpoint,
        window,
        inputFileId,
        created,
        created + window,
        JSON.stringify(metadata),
      ],
    );

    const row = await readBatch(deps.db, batchId, session.address);
    return reply.code(200).send(batchObject(row as BatchRecord, batchCounts([]), created));
    },
  );
}

export function batchRoutes(
  gated: App,
  deps: RouteDeps,
  asOfBlock: () => Promise<bigint | null>,
): void {
  const gate = sessionGate(deps.db);
  const owned = async (request: FastifyRequest, batchId: string): Promise<BatchRecord> => {
    const session = sessionOf(request);
    const row = await readBatch(deps.db, batchId, session.address);
    // 404 for a stranger's batch as well as a missing one, for `invalid_input_file`'s
    // reason: a 403 confirms the id is real.
    if (row === null) throw new ApiError(404, "not_found", `No such batch: ${batchId}`);
    return row;
  };

  gated.get(
    "/v1/batches",
    {
      onRequest: gate,
      schema: {
        tags: ["batches"],
        summary: "List batches",
        description: "The caller's batches, newest first; page with `after`.",
        security: BEARER,
        querystring: Type.Object({
          limit: Type.Optional(Uint32({ minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })),
          after: Type.Optional(Type.String({ description: "The last id of the previous page." })),
        }),
        response: {
          200: Type.Object({
            object: Type.Literal("list"),
            data: Type.Array(Batch),
            first_id: Nullable(Type.String()),
            last_id: Nullable(Type.String()),
            has_more: Type.Boolean(),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 401, 503),
        },
      },
    },
    async (request) => {
    const session = sessionOf(request);
    const asOf = await asOfBlock();
    const limit = request.query.limit ?? DEFAULT_LIMIT;
    const after = request.query.after ?? null;

    // One more than asked for: `has_more` is whether a further page exists, and
    // the alternative is a `count(*)` over the caller's whole history per page.
    const rows = await listBatches(deps.db, session.address, limit + 1, after);
    const page = rows.slice(0, limit);
    const now = nowSeconds();
    const data = await Promise.all(
      page.map(async (row) =>
        batchObject(row, batchCounts(await batchLineStates(deps.db, row.batch_id, now)), now),
      ),
    );

    return {
      object: "list",
      data,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
      has_more: rows.length > limit,
      as_of_block: asOf,
    };
    },
  );

  gated.get(
    "/v1/batches/:batch_id",
    {
      onRequest: gate,
      schema: {
        tags: ["batches"],
        summary: "Read a batch",
        description: "Status and counts are folded from the member jobs on every read.",
        security: BEARER,
        params: BatchId,
        response: { 200: BatchRead, ...errors(401, 404, 503) },
      },
    },
    async (request) => {
    const asOf = await asOfBlock();
    const row = await owned(request, request.params.batch_id);
    const { object: body } = await render(deps, row);
    return { ...body, as_of_block: asOf };
    },
  );

  gated.post(
    "/v1/batches/:batch_id/cancel",
    {
      onRequest: gate,
      schema: {
        tags: ["batches"],
        summary: "Cancel a batch",
        description:
          "Stops lines that are still open; a claimed line runs to its own end. " +
          "Refused `400 batch_not_cancellable` once the batch has finished.",
        security: BEARER,
        params: BatchId,
        response: { 200: BatchRead, ...errors(400, 401, 404, 503) },
      },
    },
    async (request) => {
    const asOf = await asOfBlock();
    const row = await owned(request, request.params.batch_id);
    const now = nowSeconds();
    const counts = batchCounts(await batchLineStates(deps.db, row.batch_id, now));

    // Decided on the status **before** the stamp, because `cancelling_at`
    // outranks everything else in the fold: writing it first would make every
    // batch look cancellable, including one that finished an hour ago.
    const status = batchStatus(row, counts, now);
    if (status !== "validating" && status !== "in_progress" && status !== "cancelling") {
      throw new ApiError(
        400,
        "invalid_request",
        `Cannot cancel a batch with status ${status}`,
        null,
        "batch_not_cancellable",
      );
    }

    // `COALESCE`, so a second cancel is a no-op rather than a fresh stamp: a
    // client that retries a timed-out request must not move the moment it asked.
    // Nothing here reaches a **claimed** line — a provider that holds one runs it
    // to its own end, exactly as it does for a standalone job. The worker relays
    // the per-line cancels for the lines still open.
    const { rows } = await deps.db.query<{ cancelling_at: bigint }>(
      `UPDATE batches SET cancelling_at = COALESCE(cancelling_at, $2)
        WHERE batch_id = $1 RETURNING cancelling_at`,
      [row.batch_id, now],
    );
    const stamped: BatchRecord = { ...row, cancelling_at: rows[0]?.cancelling_at ?? now };
    return { ...batchObject(stamped, counts, now), as_of_block: asOf };
    },
  );
}
