import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
  FastifyTypeProvider,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Static, TSchema } from "typebox";
import { getAddress } from "viem";
import { providerRegistryAbi } from "../abi/providerRegistry.js";
import type { Chain } from "../chain/client.js";
import type { Address, Config } from "../config.js";
import type { Db } from "../db/db.js";
import { viewRead } from "./chain-failure.js";

export { chainGate, requireChain } from "./chain-failure.js";
import { ApiError } from "./errors.js";
import { readSession, type Session } from "./sessions.js";

/**
 * Request types from the route schemas; reply types from nothing.
 *
 * A handler returns `bigint`s and `Buffer`s and the one JSON boundary
 * (`serialize.ts`) turns them into the JSON integers and hex the response
 * schemas describe — so the response schema is a contract on the wire, not on
 * the handler's value, and typing the handler's return against it would be
 * wrong on every route.
 */
export interface WireTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends TSchema ? Static<this["schema"]> : unknown;
  serializer: unknown;
}

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  WireTypeProvider
>;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by {@link sessionGate}; `null` on a route that has none. */
    session: Session | null;
  }
}

/** What every route module is handed. */
export interface RouteDeps {
  db: Db;
  config: Config;
  chain?: Chain;
}

/** `0x…` checksummed, the form viem wants and the form a log shows. */
export const addressOf = (bytes: Buffer): Address =>
  getAddress(`0x${bytes.toString("hex")}`) as Address;

/**
 * The session behind `Authorization: Bearer vorq_sess_…`, or a 401.
 *
 * **This is a transport gate and nothing else.** It says a caller holds a token
 * this node minted; it says nothing about what that caller may authorise. On
 * `POST /evm/ops` the authority is the op signature the contracts verify, and a
 * valid session is never sufficient to relay an op somebody else signed — the
 * session and the signer are deliberately not compared, because comparing them
 * would suggest the session carried authority it does not have.
 */
export async function requireSession(db: Db, request: FastifyRequest): Promise<Session> {
  const header = request.headers.authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token === "" || token === header) {
    throw new ApiError(
      401,
      "authentication",
      "Missing or invalid session token; expected 'Authorization: Bearer vorq_sess_...'.",
      null,
      "invalid_session",
    );
  }
  const session = await readSession(db, token);
  if (session === null) {
    throw new ApiError(401, "authentication", "Missing or expired session.", null, "invalid_session");
  }
  return session;
}

/**
 * {@link requireSession} as an `onRequest` hook, so a missing session is
 * answered `401` before the body is parsed or validated: an anonymous caller
 * learns nothing about what a well-formed request looks like.
 */
export const sessionGate = (db: Db) => async (request: FastifyRequest) => {
  request.session = await requireSession(db, request);
};

/** The session {@link sessionGate} set. */
export function sessionOf(request: FastifyRequest): Session {
  if (request.session === null) throw new Error("route reads a session it does not gate on");
  return request.session;
}

/**
 * The registry id an operator address resolves to, or `0n`.
 *
 * The projection answers first because it is free, and **the chain settles it
 * whenever the projection says no**. That asymmetry is the whole point: a miss
 * is the only answer that costs somebody something (a `403` on the op door, a
 * refused provider handshake), and the projection is allowed to be behind — it
 * trails the head by design and by up to `READY_LAG_BLOCKS` even
 * while the node reports ready, so a provider that registered a minute ago is
 * legitimately absent from it. Confirming a miss against `idOf` costs one
 * `eth_call` on the failure path only and removes the entire class of "the node
 * says you are not registered because it has not caught up yet".
 *
 * A hit is never re-checked: `idOf` only ever moves an address from 0 to an id
 * (`register` refuses a duplicate operator, `setOperator` moves the mapping),
 * so a stale hit is a provider id that was true and is now someone else's
 * problem to prove — and the pre-relay simulate proves it, on chain, before any
 * gas is spent.
 */
export async function resolveProviderId(
  { db, config, chain }: RouteDeps,
  address: Buffer,
): Promise<bigint> {
  const { rows } = await db.query<{ provider_id: bigint }>(
    "SELECT provider_id FROM providers WHERE operator = $1",
    [address],
  );
  const projected = rows[0]?.provider_id;
  if (projected !== undefined && projected !== 0n) return projected;

  if (chain === undefined) return 0n;
  // R77, on the request path of three doors (`POST /evm/ops`, `PUT /evm/asks`,
  // the provider handshake). This `eth_call` was bare: a dead endpoint answered
  // `500 internal_error, retryable=false` on all three, and on `PUT /evm/asks`
  // the route's own catch handed a reverting read to `sendFailure(…, "relayer")`,
  // whose relayer branch calls a revert a verdict — `400 invalid_request` for a
  // read that is not the caller's transaction. The wrapper lives here rather than
  // at the three call sites so a fourth caller cannot be written without it.
  const onChain = await viewRead("provider_id_read", () =>
    chain.publicClient.readContract({
      address: config.addresses.providerRegistry,
      abi: providerRegistryAbi,
      functionName: "idOf",
      args: [addressOf(address)],
    }),
  );
  return BigInt(onChain);
}
