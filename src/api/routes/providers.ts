import { Type } from "typebox";
import type { Db } from "../../db/db.js";
import type { App } from "../deps.js";
import { ApiError } from "../errors.js";
import { budgeted, pageOf, Paging } from "../paging.js";
import { AsOfBlock, errors, HexOut, Int, Nullable, Uint32 } from "../schemas/common.js";
import { jsonb } from "../wire.js";

/** The provider directory, as the projection holds it. */

export interface ProviderRow {
  provider_id: bigint;
  operator: Buffer;
  box_key: Buffer | null;
  /** `evidence::text` — the raw `jsonb` text, never a parsed value (R51). */
  evidence: string | null;
  listed: boolean;
  reputation: bigint;
  allow_all_models: boolean;
  allowed_models: bigint[];
  capacity: bigint;
  active_jobs: bigint;
}

const PROVIDER_QUERY = `
  SELECT p.provider_id, p.operator, p.box_key, p.evidence::text AS evidence,
         p.listed, p.reputation, p.allow_all_models, p.allowed_models,
         -- effectiveCap, in SQL and to the chain's formula. Every input is
         -- load-bearing (R12): reputation scales it, the ceiling caps what may
         -- be requested, and the floor of 1 keeps a new provider claimable.
         GREATEST(1, p.reputation * LEAST(p.capacity_requested, p.capacity_ceiling) / 1000)
           AS capacity,
         -- Matches the chain's activeJobs while Plan 1 defers slot leasing.
         (SELECT count(*) FROM jobs j WHERE j.provider_id = p.provider_id AND j.state = 1)
           AS active_jobs
  FROM providers p`;

const evmProvider = (row: ProviderRow) => ({
  provider_id: row.provider_id,
  operator: row.operator,
  box_key: row.box_key,
  evidence: jsonb(row.evidence),
  listed: row.listed,
  reputation: row.reputation,
  allow_all_models: row.allow_all_models,
  allowed_models: row.allowed_models,
  capacity: row.capacity,
  active_jobs: row.active_jobs,
});

export const EvmProvider = Type.Object({
  provider_id: Int(),
  operator: HexOut("The operator address that signs this provider's ops."),
  box_key: Nullable(HexOut("The X25519 key a designated order is sealed to.")),
  evidence: Type.Unknown({ description: "The provider's published identity evidence, as JSON." }),
  listed: Type.Boolean(),
  reputation: Int(),
  allow_all_models: Type.Boolean(),
  allowed_models: Type.Array(Int()),
  capacity: Int("Effective capacity: the chain's effectiveCap."),
  active_jobs: Int(),
});

export function providerRoutes(
  gated: App,
  db: Db,
  asOfBlock: () => Promise<bigint | null>,
): void {
  gated.get(
    "/evm/providers",
    {
      schema: {
        tags: ["providers"],
        summary: "List providers",
        querystring: Type.Object(Paging),
        response: {
          200: Type.Object({ providers: Type.Array(EvmProvider), as_of_block: AsOfBlock }),
          ...errors(400, 503),
        },
      },
    },
    async (request, reply) => {
    const page = pageOf(request.query);
    const asOf = await asOfBlock();
    const { rows } = await db.query<ProviderRow>(
      `${PROVIDER_QUERY} ORDER BY p.provider_id LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    );
    return { providers: budgeted(rows, page, reply, evmProvider), as_of_block: asOf };
    },
  );

  gated.get(
    "/evm/providers/:provider_id",
    {
      schema: {
        tags: ["providers"],
        summary: "Read one provider",
        params: Type.Object({ provider_id: Uint32() }),
        response: {
          200: Type.Object({ ...EvmProvider.properties, as_of_block: AsOfBlock }),
          ...errors(400, 404, 503),
        },
      },
    },
    async (request) => {
    const providerId = BigInt(request.params.provider_id);
    const asOf = await asOfBlock();
    const { rows } = await db.query<ProviderRow>(
      `${PROVIDER_QUERY} WHERE p.provider_id = $1`,
      [providerId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new ApiError(404, "not_found", `no such provider: ${providerId}`);
    }
    return { ...evmProvider(row), as_of_block: asOf };
    },
  );
}
