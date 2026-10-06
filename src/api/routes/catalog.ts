import type { FastifyReply } from "fastify";
import { Type } from "typebox";
import type { Db } from "../../db/db.js";
import type { App } from "../deps.js";
import { ApiError } from "../errors.js";
import { budgeted, pageOf, Paging, type Page } from "../paging.js";
import { AsOfBlock, errors, HexOut, Int } from "../schemas/common.js";
import { jsonb } from "../wire.js";

/** The allowlist and the model catalog: two small, curation-written listings. */

const Model = Type.Object({
  id: Type.String({ description: "The model name, org-qualified." }),
  object: Type.Literal("model"),
  owned_by: Type.Literal("vorq"),
  vorq: Type.Object({
    model_id: Int("The on-chain id an order names."),
    enabled: Type.Boolean({ description: "`false` for a retired model: served, never orderable." }),
  }),
});

const ModelList = Type.Object({
  object: Type.Literal("list"),
  data: Type.Array(Model),
  as_of_block: AsOfBlock,
});

export function catalogRoutes(
  gated: App,
  db: Db,
  asOfBlock: () => Promise<bigint | null>,
): void {
  // Raw from the index, and unsigned: no signing key exists in this node. The
  // emulator's EIP-191 envelope is retired because the chain is the authority
  // — a signature here would only attest that the node read it correctly.
  gated.get(
    "/evm/allowlist",
    {
      schema: {
        tags: ["catalog"],
        summary: "List allowlist entries",
        description: "A revoked entry is a tombstone with `status: 2`, never a deletion.",
        querystring: Type.Object(Paging),
        response: {
          200: Type.Object({
            entries: Type.Array(
              Type.Object({ key: HexOut(), status: Type.Integer(), entry: Type.Unknown() }),
            ),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 503),
        },
      },
    },
    async (request, reply) => {
    const page = pageOf(request.query);
    const asOf = await asOfBlock();
    const { rows } = await db.query<{ key: Buffer; status: number; entry: string }>(
      "SELECT key, status, entry::text AS entry FROM allowlist ORDER BY key LIMIT $1 OFFSET $2",
      [page.limit, page.offset],
    );
    return {
      // A revoked entry is a tombstone with `status: 2`, never a deletion —
      // that is how a client tells "revoked" from "never listed".
      entries: budgeted(rows, page, reply, (row) => ({
        key: row.key,
        status: row.status,
        entry: jsonb(row.entry),
      })),
      as_of_block: asOf,
    };
    },
  );

  // One handler on two paths. `/v1/models` keeps the emulator's OpenAI shape
  // (R27) so Plan 4's client needs no change, and `/evm/models` serves the
  // identical body rather than a parallel projection that can drift.
  const models = async (page: Page, reply: FastifyReply) => {
    const asOf = await asOfBlock();
    const { rows } = await db.query<{ model_id: bigint; name: string; enabled: boolean }>(
      "SELECT model_id, name, enabled FROM models ORDER BY model_id LIMIT $1 OFFSET $2",
      [page.limit, page.offset],
    );
    return {
      object: "list",
      data: budgeted(rows, page, reply, (row) => ({
        id: row.name,
        object: "model",
        owned_by: "vorq",
        vorq: { model_id: row.model_id, enabled: row.enabled },
      })),
      as_of_block: asOf,
    };
  };

  const listing = (path: string, summary: string) =>
    gated.get(
      path,
      {
        schema: {
          tags: ["catalog"],
          summary,
          querystring: Type.Object(Paging),
          response: { 200: ModelList, ...errors(400, 503) },
        },
      },
      async (request, reply) => models(pageOf(request.query), reply),
    );
  listing("/evm/models", "List models");
  listing("/v1/models", "List models (OpenAI shape)");

  // `client.models.retrieve(name)`. A **wildcard**, not `/:name`, because a model name is
  // org-qualified — `org/model:fp8` — so the value spans path segments however the caller
  // spells it. Percent-encoded or not, the wildcard hands back the rest of the path and the
  // decode below normalises the two spellings onto the one name the catalog stores.
  //
  // A disabled model is served, not hidden: a client holding the name needs to learn that it
  // is retired, and a 404 says only that the name is unknown.
  gated.get(
    "/v1/models/*",
    {
      // The router's wildcard, spelled as the one path parameter it is.
      config: {
        swaggerTransform: ({ schema, url }) => ({
          schema: { ...schema, params: Type.Object({ name: Type.String({ description: "The model name, org-qualified." }) }) },
          url: url.replace("*", ":name"),
        }),
      },
      schema: {
        tags: ["catalog"],
        summary: "Read one model",
        description: "`client.models.retrieve(name)`. The name may span path segments, encoded or not.",
        params: Type.Object({ "*": Type.String({ description: "The model name." }) }),
        response: {
          200: Type.Object({ ...Model.properties, as_of_block: AsOfBlock }),
          ...errors(404, 503),
        },
      },
    },
    async (request) => {
    const raw = request.params["*"];
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      // A malformed escape is not a name this catalog can carry; fall through to the 404
      // below rather than answering 400 for what is, to a caller, an unknown model.
    }
    const asOf = await asOfBlock();
    const { rows } = await db.query<{ model_id: bigint; name: string; enabled: boolean }>(
      "SELECT model_id, name, enabled FROM models WHERE name = $1",
      [name],
    );
    const row = rows[0];
    if (!row) {
      throw new ApiError(404, "invalid_request", `No such model: ${name}`, null, "model_not_found");
    }
    return {
      id: row.name,
      object: "model",
      owned_by: "vorq",
      vorq: { model_id: row.model_id, enabled: row.enabled },
      as_of_block: asOf,
    };
    },
  );
}
