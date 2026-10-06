import { Type } from "typebox";
import { recoverTypedDataAddress } from "viem";
import { ApiError, badRequest } from "../errors.js";
import { addressOf, resolveProviderId, type App, type RouteDeps } from "../deps.js";
import { Address, errors } from "../schemas/common.js";
import { consumeNonce, createSession, issueNonce, type Role } from "../sessions.js";

/**
 * The session handshake, unchanged from the emulator so the provider SDK's
 * `_handshake()` keeps working byte for byte: `GET /auth/nonce?address=` then
 * `POST /auth/session {address, nonce, signature, role?}`.
 *
 * **The signing domain here is deliberately not the chain's.**
 * `{name:"VORQ", version:"1", chainId:1}` is an off-chain auth artifact — it
 * proves control of a key to *this node* and nothing else. Signing the chain's
 * domain instead would make a session signature and an on-chain op signature
 * live in the same namespace, and a captured handshake would then be worth more
 * than a login.
 *
 * Registered **outside** the readiness gate. The handshake is the door to
 * everything else; 503-ing it while the index catches up would lock out a
 * provider that only wants to relay a claim, which reads no index at all.
 */

/**
 * The session handshake's domain — **pinned**, and deliberately not the chain's.
 *
 * A session is an off-chain auth artifact: it is never submitted anywhere, and
 * this node verifies it against a nonce minted in its own database, which is
 * what prevents replay. A real chain id would buy nothing here and could not
 * tell two coordinators on one chain apart. If per-environment separation is
 * ever wanted the lever is the domain NAME or a salt, not `chainId`.
 *
 * Version `1` against the ops' `2`, with no `verifyingContract` at all, keeps it
 * in a namespace the chain will never accept: a captured login cannot be
 * replayed as an op.
 */
/**
 * The off-chain session domain, bound to the deployment's chain.
 *
 * Version `1` against the contracts' `2` and no `verifyingContract` keep a login
 * in a namespace the chain will never accept. `chainId` is the deployment's and
 * `GET /auth/nonce` announces it as `chain_id`: it used to be pinned at 1, and a
 * browser wallet refuses to sign a typed-data domain whose chain is not the one
 * it is on (MetaMask, 2026-09-24), which locked every real wallet out.
 */
export function sessionDomain(chainId: number) {
  return { name: "VORQ Session", version: "1", chainId } as const;
}

export const SESSION_TYPES = {
  VorqSession: [
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/**
 * The longest nonce this node will look up.
 *
 * It mints 32 hex characters; anything longer than 128 cannot be one of ours, so
 * refusing it early keeps an arbitrarily long string out of a primary-key lookup.
 */
const MAX_NONCE_LENGTH = 128;

const NonceQuery = Type.Object({ address: Address({ description: "The wallet that will sign." }) });

const NonceResponse = Type.Object({
  nonce: Type.String(),
  expires_at: Type.Integer({ description: "Unix seconds; the nonce is single-use until then." }),
  chain_id: Type.Integer({ description: "The chain id the `VorqSession` domain is bound to." }),
});

const SessionBody = Type.Object({
  address: Address(),
  nonce: Type.String({
    maxLength: MAX_NONCE_LENGTH,
    "x-vorq-error": { message: "is not a nonce this node issued" },
  }),
  signature: Type.String({
    description: "EIP-712 `VorqSession {address, nonce}` over `{name: \"VORQ Session\", version: \"1\", chainId}`.",
  }),
  role: Type.Optional(
    Type.Enum(["client", "provider"], { default: "client" }),
  ),
});

const SessionResponse = Type.Object({
  token: Type.String({ description: "`vorq_sess_…`, sent as `Authorization: Bearer`." }),
  expires_at: Type.Integer({ description: "Unix seconds." }),
  provider_id: Type.Optional(
    Type.Integer({ description: "The registry id bound to a provider session; absent for a client." }),
  ),
});

export function authRoutes(app: App, deps: RouteDeps): void {
  const { db } = deps;

  app.get(
    "/auth/nonce",
    {
      schema: {
        tags: ["auth"],
        summary: "Issue a login nonce",
        description: "Step one of the session handshake. The nonce is burned on first use.",
        querystring: NonceQuery,
        response: { 200: NonceResponse, ...errors(400) },
      },
    },
    async (request) => {
    const address = Buffer.from(request.query.address.slice(2), "hex");

    const { nonce, expiresAt } = await issueNonce(db, address);
    // No `as_of_block` (R28): nothing here was read from the index.
    return { nonce, expires_at: expiresAt, chain_id: deps.config.addresses.chainId };
    },
  );

  app.post(
    "/auth/session",
    {
      schema: {
        tags: ["auth"],
        summary: "Open a session",
        description:
          "Step two: the signed nonce buys a bearer token. `role: provider` binds the wallet's " +
          "registry id to the session and is refused `403 not_registered` for an unregistered wallet.",
        body: SessionBody,
        response: { 200: SessionResponse, ...errors(400, 401, 403) },
      },
    },
    async (request, reply) => {
    const { nonce, signature } = request.body;
    const claimed = Buffer.from(request.body.address.slice(2), "hex");
    const role: Role = request.body.role ?? "client";

    // Burned before anything else can fail. The nonce's job is done the moment
    // it is looked up: leaving it alive through the signature check would let a
    // captured (address, nonce, signature) triple be replayed for the rest of
    // its 300 s TTL — and, worse, a `not_registered` refusal below would leave a
    // fully-signed provider handshake replayable as a *client* handshake.
    const issuedTo = await consumeNonce(db, nonce);
    if (issuedTo === null) throw badRequest("Unknown or expired nonce.", "nonce");

    // EVM addresses are case-insensitive identifiers — checksum casing is
    // display-only — and both sides are compared as bytes, which sidesteps the
    // question entirely.
    if (!issuedTo.equals(claimed)) {
      throw new ApiError(
        401,
        "authentication",
        "Claimed address does not match the address the nonce was issued to.",
        null,
        "invalid_signature",
      );
    }

    let signer: string;
    try {
      signer = await recoverTypedDataAddress({
        domain: sessionDomain(deps.config.addresses.chainId),
        types: SESSION_TYPES,
        primaryType: "VorqSession",
        message: { address: addressOf(claimed), nonce },
        signature: signature as `0x${string}`,
      });
    } catch {
      throw new ApiError(
        401,
        "authentication",
        "Malformed session signature.",
        null,
        "invalid_signature",
      );
    }
    if (signer.toLowerCase() !== addressOf(claimed).toLowerCase()) {
      throw new ApiError(
        401,
        "authentication",
        "Session signature was not produced by the claimed address.",
        null,
        "invalid_signature",
      );
    }

    // A provider session binds the registry id, so a provider never transmits
    // its own id afterwards — identity is ambient from the token (R14). The id
    // is resolved through the projection with the chain settling a miss, so a
    // provider that registered inside the indexer's lag is not told it does not
    // exist.
    let providerId: bigint | null = null;
    if (role === "provider") {
      const resolved = await resolveProviderId(deps, claimed);
      if (resolved === 0n) {
        throw new ApiError(
          403,
          "authentication",
          "Wallet is not registered as a provider.",
          null,
          "not_registered",
        );
      }
      providerId = resolved;
    }

    const session = await createSession(db, claimed, role, providerId);

    // `provider_id` is present only for a provider session.
    const expiresAt = session.expiresAt;
    return reply.code(200).send(
      providerId === null
        ? { token: session.token, expires_at: expiresAt }
        : { token: session.token, expires_at: expiresAt, provider_id: providerId },
    );
    },
  );
}
