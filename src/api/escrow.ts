import { Type } from "typebox";
import type { Chain } from "../chain/client.js";
import type { Config, EscrowMode } from "../config.js";
import { mockEvidence, staticEvidence, type Evidence } from "../escrow/attest.js";
import {
  HANDOVER_BODY_LIMIT_BYTES,
  handover,
  HandoverBody,
  type HandoverResponse,
} from "../escrow/handover.js";
import { KeyManager, type EscrowKeys } from "../escrow/keys.js";
import {
  RELEASE_BODY_LIMIT_BYTES,
  release,
  ReleaseBody,
  type KeyEpochStart,
  type ReleaseResponse,
} from "../escrow/release.js";
import { chainGate, requireChain } from "./chain-failure.js";
import type { App } from "./deps.js";
import { ApiError } from "./errors.js";
import { errors } from "./schemas/common.js";

const EvidenceOut = Type.Object({
  type: Type.String(),
  measurement: Type.Optional(Type.String()),
  report_data: Type.String(),
  debug: Type.Boolean(),
  tcb: Type.Optional(Type.Object({ svn: Type.Integer() })),
  release: Type.Integer(),
  quote: Type.Optional(Type.String()),
});

/**
 * The escrow doors: `GET /key`, `POST /release` and `POST /handover`.
 *
 * Two structural decisions shape this file, and both are rulings rather than
 * preferences.
 *
 * **The routes are registered outside the readiness gate** (P26). They are
 * wired from `buildApp`'s ungated section for the same reason `/evm/simulate/claim`
 * is: they read the chain and this node's own memory, never the index. A node
 * catching up on log replay still holds every key it held a second ago, and
 * gating these would make an ordinary restart look, to a provider trying to
 * release a DEK, exactly like key loss. The escape is by **scope**, not by an
 * exempt-path list: a list is a thing a later route forgets to join, and
 * `test/escrow-key.test.ts` asserts the property directly by serving `/key`
 * while the indexer reports not ready.
 *
 * **The routes are registered unconditionally and the mode gate is on the scope,
 * not on the handlers** (I2/P14, S7). Wiring the doors only when the mode is on
 * would answer `404` at mode `off` — and a `404` says *this node has no such
 * door*, which is a different and false statement about a build that simply holds
 * no keys. At `off` the door exists and refuses, with a code a client can branch
 * on.
 *
 * The gate itself is an `onRequest` hook inside this file's own encapsulated
 * `app.register`, for exactly the reason the readiness escape above is by scope:
 * it used to be three hand-written `requireEscrow(deps)` calls, one per handler,
 * and **a fourth door added tomorrow would have had to remember to make the
 * call, with nothing failing if it did not**. A guard fixed on one door and not
 * its siblings is this project's recurring defect; the only fix that survives a
 * careless author is one there is nothing to opt into. A nested plugin
 * registered from `buildApp`'s ungated section is still outside the readiness
 * gate, so this costs P26 nothing — and `test/escrow-key.test.ts` enumerates the
 * doors **from the app's own router** rather than from a literal, so a fourth
 * route is covered the day it exists.
 *
 * **There are two nested scopes, not one, and each refuses a different thing.**
 * The outer one — this file's own `app.register`, below — refuses every door at
 * mode `off` with `escrow_unavailable`: this node holds no key material at all.
 * `POST /handover` sits inside a second, inner `app.register` of its own
 * ({@link handoverDoors}), which refuses *that door alone* at mode `static` with
 * `escrow_handover_disabled`: the escrow works and `/key`/`/release` serve
 * normally, but a key set derived from `OPERATOR_KEY` is identical on every
 * instance of the fleet and there is nothing to hand over. Both hooks run on
 * `onRequest`, inherited by scope rather than opted into by a handler, and a
 * second handover route added tomorrow lands inside the inner scope and is
 * gated the day it exists.
 */

/** What the escrow doors are handed. */
export interface EscrowDeps {
  config: Config;
  /**
   * The held key set, or `null` on a node that hosts no escrow.
   *
   * `null` and `mode: "off"` mean the same thing to a caller and are answered
   * identically — this node holds no escrow keys — because they are the same
   * fact reached from two directions, and `main.ts` sets them together.
   *
   * {@link EscrowKeys} rather than `KeyManager`: `/key` and `/release` call two
   * methods between them, and both are on the interface. `/handover` needs the
   * whole manager and narrows for it — see {@link handoverManager}.
   */
  keys: EscrowKeys | null;
  /** `/release`'s authorisation reads. Absent answers `503 chain_unreachable`. */
  chain?: Chain;
  /** Injected so `issued_at` is testable. Milliseconds, as `Date.now`. */
  clock?: () => number;
  /**
   * When this node's custody of its key material began, or `null`.
   *
   * A **function**, not a value: the marker is minted at boot and may be replaced
   * by a handover adopting `min(own, peer's)` (Task 5/6), so a value captured at
   * route-registration time would be the wrong one for the rest of the process's
   * life. Absent is answered as "not orphaned" — a node that cannot say when its
   * keys began must never tell a provider a job's key is gone.
   */
  keyEpochStart?: () => KeyEpochStart | null;
}

/**
 * `escrow_unavailable` is a **`code`**, never a `type` (P13). The plan's
 * `{error:{type:"escrow_unavailable"}}` is wrong: Plan 4 keys on `error.code`
 * and this node has exactly one envelope.
 *
 * The type is `invalid_request`, which is the closest true statement in the
 * shipped vocabulary: the answer is not retryable, because the escrow is
 * compiled off on this node and the identical request cannot start working (R57).
 * It is deliberately **not** a `503`: a retryable answer would have a client
 * backing off forever against a node that is never going to hold a key.
 */
const escrowUnavailable = (detail: string): ApiError =>
  new ApiError(403, "invalid_request", detail, null, "escrow_unavailable");

/**
 * The refusal `POST /handover` gives on a node whose escrow key is derived.
 *
 * A `403 invalid_request` with its own code, not `escrow_unavailable`: this node
 * hosts an escrow and will serve `/key` and `/release` on the next request, so
 * borrowing the mode-off code would be a false statement about a working escrow.
 * Not retryable — the identical request cannot start working, because there is
 * nothing to hand over: every instance of this fleet already derives the same
 * key set from the same environment.
 */
const handoverDisabled = (): ApiError =>
  new ApiError(
    403,
    "invalid_request",
    "this node's escrow key is derived from its operator credential (ESCROW_MODE=static), so " +
      "every instance of the fleet already holds the same key set and there is nothing to hand " +
      "over. Handover exists for key material that lives only in one process.",
    null,
    "escrow_handover_disabled",
  );

/**
 * The full key manager, for the one handler that needs more than the two open
 * doors do.
 *
 * Handover reads `heldKeys()`, `now()` and `adoptKeys()` — the lifecycle surface
 * a derived key set does not have. The inner scope gate refuses every request to
 * that door at `mode: "static"` before a handler runs, so a `StaticKeyManager`
 * reaching here means the hook did not run: a `500` saying so, never the
 * caller-facing `403`. The same distinction {@link heldKeys} draws, and for the
 * same reason — a gate that is gone must break loudly rather than keep quietly
 * producing the right refusal for the wrong reason.
 */
function handoverManager(deps: EscrowDeps): KeyManager {
  const keys = heldKeys(deps);
  if (!(keys instanceof KeyManager)) {
    throw new ApiError(
      500,
      "internal",
      "the handover door ran on a node with no key lifecycle: its scope gate did not run, or " +
        "this route is registered outside the handover plugin",
    );
  }
  return keys;
}

/**
 * The one refusal every escrow door gives when this node holds no keys.
 *
 * Called from the scope's `onRequest` hook, once, for every route in the escrow
 * plugin — present and future. It is **not** called from the handlers: a check a
 * handler makes is a check the next handler can forget.
 */
function requireEscrow(deps: EscrowDeps): void {
  if (deps.config.escrow.mode === "off" || deps.keys === null) {
    throw escrowUnavailable(
      "this node hosts no escrow (ESCROW_MODE=off): it holds no key material and " +
        "will not proxy any. Fetch the key from a coordinator that does.",
    );
  }
}

/**
 * The held generations, for a handler the scope gate has already let through.
 *
 * The `null` is unreachable — {@link requireEscrow} refuses `keys === null` on
 * every request into this scope before a handler runs — so this is an invariant,
 * not a second gate, and it answers as one: a `500` saying the gate did not run,
 * never the caller-facing `403`. That distinction is deliberate. If the hook is
 * ever removed, these doors must not keep quietly producing the right refusal for
 * the wrong reason; they must break loudly, and the mode-off tests must go red.
 */
function heldKeys(deps: EscrowDeps): EscrowKeys {
  if (deps.keys === null) {
    throw new ApiError(
      500,
      "internal",
      "an escrow door ran without the mode gate: this route is registered outside the escrow " +
        "plugin, or its onRequest hook is gone",
    );
  }
  return deps.keys;
}

/** `GET /key`'s body. `escrow_public_key` is 64 lowercase hex, no `0x`. */
export interface KeyAnnouncement {
  escrow_public_key: string;
  evidence: Evidence;
  /** Unix seconds, the same unit `/release`'s `issued_at` is bounded in. */
  issued_at: number;
}

export function escrowRoutes(app: App, deps: EscrowDeps): void {
  // Everything below is inside one encapsulated plugin so the mode gate is
  // inherited by scope. **Nothing in this function may register a route on
  // `app`** — a route written on the outer instance is a route outside the gate,
  // which is precisely the mistake this shape exists to make impossible.
  app.register(async (escrow) => {
    escrowDoors(escrow, deps);
  });
}

/**
 * Which evidence builder a mode gets. Every mode gets an explicit arm, so a
 * new key-holding mode cannot fall through to forgeable mock evidence.
 */
function evidenceFor(mode: EscrowMode, publicKey: Buffer, releaseOrdinal: number): Evidence {
  switch (mode) {
    case "static":
      return staticEvidence(publicKey, releaseOrdinal);
    case "mock":
      return mockEvidence(publicKey, releaseOrdinal);
    default:
      throw new ApiError(500, "internal", `GET /key has no evidence builder for ESCROW_MODE=${mode}`);
  }
}

function escrowDoors(app: App, deps: EscrowDeps): void {
  const clock = deps.clock ?? Date.now;

  /**
   * The mode gate (P14), on the scope rather than on each handler (S7).
   *
   * `onRequest` is the earliest hook Fastify offers: it runs before the body is
   * parsed, so a node that hosts no escrow refuses a megabyte of `/handover`
   * without decoding a byte of it, and the refusal a client sees is the mode's
   * rather than a body limit's.
   */
  app.addHook("onRequest", async () => {
    requireEscrow(deps);
  });

  /**
   * The generation a client seals its seed to, and the evidence that binds it.
   *
   * The evidence is minted **per request over the key being announced**, not
   * cached alongside it. It is cheap (one sha256), and the alternative is a
   * cache that can be advertised beside a key it does not describe after a
   * rotation — the one failure that makes the binding worthless.
   */
  app.get(
    "/key",
    {
      schema: {
        tags: ["escrow"],
        summary: "The escrow's current key",
        description:
          "The X25519 key a client seals its seed to, with the evidence that binds it. " +
          "`403 escrow_unavailable` on a node that hosts no escrow.",
        response: {
          200: Type.Object({
            escrow_public_key: Type.String({ description: "64 lowercase hex, no 0x." }),
            evidence: EvidenceOut,
            issued_at: Type.Integer({ description: "Unix seconds." }),
          }),
          ...errors(403, 503),
        },
      },
    },
    async (): Promise<KeyAnnouncement> => {
    const keys = heldKeys(deps);
    const current = keys.current();
    if (current === null) {
      // A node joining with `PEER_REQUIRED` adopts its peer's keys before
      // minting its own, so there is a window at boot with no current
      // generation. Retryable, and honestly so: it closes on its own within a
      // boot, or the boot fails and nothing listens at all.
      throw new ApiError(
        503,
        "not_ready",
        "this escrow holds no current generation yet; it is still joining",
        null,
        "escrow_key_unminted",
      );
    }

    return {
      escrow_public_key: current.publicKey.toString("hex"),
      evidence: evidenceFor(
        deps.config.escrow.mode,
        current.publicKey,
        deps.config.escrow.releaseOrdinal,
      ),
      issued_at: Math.floor(clock() / 1000),
    };
    },
  );

  /**
   * The key oracle. The whole policy — and the reasoning behind the one part of
   * it that is not obvious — lives in `src/escrow/release.ts`; this is the door.
   *
   * Two gates run before a single byte of the body is parsed, in this order:
   *
   *   * the scope's {@link requireEscrow} hook — `403 escrow_unavailable`, the
   *     identical refusal `/key` gives, because "this node hosts no escrow" is
   *     one fact with one code however it is asked. It is not written here, and
   *     that is the point (S7): this door inherits it, and so does the next one;
   *   * `requireChain` — a node built without an RPC endpoint answers
   *     `503 chain_unreachable`, retryably. Every identity this door authorises
   *     against is read from the chain (P4), so without one there is no honest
   *     answer to give and certainly no key to hand over.
   *
   * `bodyLimit` is declared per route rather than inherited: this door needs no
   * session, so it is open to the internet, and its widest legitimate body is
   * ~550 characters.
   */
  app.post(
    "/release",
    {
      bodyLimit: RELEASE_BODY_LIMIT_BYTES,
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["escrow"],
        summary: "Release a job's DEK to its claimant",
        description:
          "The claimant proves the claim with its operator signature and the container's two " +
          "pieces; the DEK comes back sealed to `response_pubkey`. The ciphertext never transits. " +
          "`400 bad_container` / `stale_issued_at`, `403 wrong_wallet`.",
        body: ReleaseBody,
        response: {
          200: Type.Object({ dek_sealed: Type.String({ description: "Base64, 80 bytes." }) }),
          ...errors(400, 403, 404, 409, 410, 413, 503),
        },
      },
    },
    async (request): Promise<ReleaseResponse> => {
      const keys = heldKeys(deps);
      const chain = requireChain(deps.chain);
      return release(
        {
          keys,
          chain,
          config: deps.config,
          nowMs: clock(),
          keyEpochStart: deps.keyEpochStart?.() ?? null,
        },
        request.body,
      );
    },
  );

  /**
   * Handover, in a scope of its own, gated again (S7).
   *
   * The outer hook refuses every escrow door at `mode: "off"`; this one refuses
   * *this* door at `mode: "static"`, where the escrow works and handover has
   * nothing to do. Written as a second scope for the same reason the first one
   * is a scope at all: a check a handler makes is a check the next handler can
   * forget, and a second handover route added tomorrow lands inside this
   * register and is gated the day it exists.
   */
  app.register(async (handoverScope) => {
    handoverDoors(handoverScope, deps);
  });
}

function handoverDoors(app: App, deps: EscrowDeps): void {
  // Re-derived rather than closed over: this is a scope of its own now, and the
  // outer function's `clock` is not in it.
  const clock = deps.clock ?? Date.now;

  // `onRequest` is the earliest hook Fastify offers, so a static node refuses a
  // megabyte of handover body without decoding a byte of it — the same reason
  // the outer gate is on that hook.
  app.addHook("onRequest", async () => {
    if (deps.config.escrow.mode === "static") throw handoverDisabled();
  });

  /**
   * Attested key transfer, as a pull that leaves this node untouched.
   *
   * Three gates now, in this order: the outer scope's `requireEscrow` hook
   * (`escrow_unavailable` at mode `off`), this scope's own hook
   * (`escrow_handover_disabled` at mode `static`), and `requireChain`.
   *
   * The whole policy is `src/escrow/handover.ts`; this is the door, and it holds
   * no state of its own. It used to: a successful takeover latched this instance
   * into a permanent `410`, which put an unrecoverable state change on the far
   * side of a network call. Cutover belongs to the orchestrator now — both
   * instances keep serving, and the predecessor is killed once traffic has moved.
   */
  app.post(
    "/handover",
    {
      bodyLimit: HANDOVER_BODY_LIMIT_BYTES,
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["escrow"],
        summary: "Hand the key set to an attested peer",
        description:
          "A joining escrow instance pulls this node's generations over an attested channel. " +
          "Operator-signed; refused at `ESCROW_MODE=static`.",
        body: HandoverBody,
        response: {
          200: Type.Object({
            keys_sealed: Type.String(),
            key_count: Type.Integer(),
            holder_release: Type.Integer(),
          }),
          ...errors(400, 403, 409, 413, 503),
        },
      },
    },
    async (request): Promise<HandoverResponse> => {
      const keys = handoverManager(deps);
      const chain = requireChain(deps.chain);
      return handover(
        {
          keys,
          chain,
          config: deps.config,
          nowMs: clock(),
          keyEpochStart: deps.keyEpochStart?.() ?? null,
        },
        request.body,
      );
    },
  );
}
