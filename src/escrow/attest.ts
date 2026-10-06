import { createHash } from "node:crypto";
import { type Hex } from "viem";
import { ESCROW_PUBLIC_KEY_BYTES } from "./container.js";

/**
 * Mock attestation: the evidence a coordinator publishes about itself, and the
 * binding that makes it worth publishing.
 *
 * ## What is real here and what is not
 *
 * The **binding** is real and is the whole point: `report_data` commits to a
 * public key, so evidence and key travel together and neither can be swapped for
 * another. A real SNP report carries exactly this field, computed exactly this
 * way, so the verifier Plan 4 writes against mock evidence is the verifier that
 * will check a measured image later — only the signature check is added.
 *
 * The **quote is not real.** It is a labelled placeholder, and
 * {@link mockEvidence} is a pure function of its arguments, so **anybody can
 * compute this evidence for any key**. That is not a defect of the mock; it is
 * what a mock is.
 *
 * ## Therefore: mock mode is dev/CI only and must never be internet-exposed
 *
 * The consequence is sharper than "the attestation is weak". `POST /handover`
 * (Task 5) releases the node's **entire held key set** to a caller whose
 * evidence verifies — so on an internet-reachable node in mock mode, every DEK
 * this escrow holds is available to anyone who reads this file. The guarantee
 * the design makes is scoped to attested deployments; mock exists to exercise
 * the machinery end to end, never to host it. `ESCROW_MODE` defaults to
 * `off` for this reason and `src/config.ts` says so where an operator sets it.
 */

/**
 * The service this evidence is about — **UTF-8, unpadded** (P24).
 *
 * Stated as bytes in code and not only in prose, because this is a
 * cross-language contract: a Python verifier that padded it to 32 bytes, or
 * encoded it UTF-16, would compute a different digest and reject every honest
 * node. `Buffer.from(…, "utf8")` is the encoding, spelled out at the one place
 * the digest is taken.
 */
export const SERVICE_ID = "vorq-coordinator-escrow-v1";

/**
 * The service id for evidence about a **handover channel key**, and the reason
 * it is a different string (I7).
 *
 * `GET /key` is public, unauthenticated, and its response carries evidence built
 * by exactly the same construction. Under a single `service_id` that response
 * replays **verbatim** as a `POST /handover` body: the announced escrow public
 * key becomes the `channel_pubkey`, the announced evidence already binds it, and
 * `issued_at` is fresh.
 *
 * Two uses, two domains. Evidence minted for an announcement cannot be presented
 * as evidence about a channel, because the digest does not reproduce.
 *
 * The replay is harmless on both counts today — handover changes nothing on the
 * holder, and the payload comes back sealed to a key only the real node holds —
 * so this separation is defence in depth rather than the sole guard it once was.
 * It stays because the cost is one string and the property it preserves is that
 * evidence means exactly one thing: reusing an artifact across two protocol
 * positions is how a future rung acquires a hole nobody reviewed for.
 *
 * **UTF-8, unpadded** (P24), like its sibling: the suffix is ASCII so the byte
 * length is the character length, and a test asserts it.
 */
export const CHANNEL_SERVICE_ID = `${SERVICE_ID}:channel`;

const SERVICE_ID_BYTES = Buffer.from(SERVICE_ID, "utf8");

/** The image name this node's mock measurement is the digest of. */
export const MOCK_COORDINATOR_IMAGE = "vorq-mock-coordinator-image-v1";

/**
 * The type tag. Distinct from the provider mock's, on purpose: a verifier that
 * accepted either would accept a *provider's* evidence for a coordinator
 * handover, which is a different trust domain holding different keys.
 */
export const MOCK_EVIDENCE_TYPE = "mock-coordinator-v1";

/**
 * The TCB security version number this mock reports.
 *
 * `1` because Task 5's verifier refuses anything below 1, and a mock that
 * reported 0 would fail its own protocol. A real report reads this from the
 * platform.
 */
export const MOCK_TCB_SVN = 1;

/**
 * One attestation, in the shape the client verifier reads.
 *
 * **Three fields are optional, and their absence is a statement.** A measured
 * image, a platform TCB level and a quote are all claims about hardware; a node
 * whose escrow key is derived from an operator credential has none of them, and
 * evidence that filled them in with placeholders would be asserting exactly what
 * a verifier is there to check. What every kind of evidence carries is the
 * binding — see {@link reportData} — and that is the part that was ever doing
 * the work. {@link MeasuredEvidence} is the narrowing for the flows that do
 * require them.
 */
export interface Evidence {
  type: string;
  /** sha256 of the image identity, lowercase hex, no `0x`. Absent where there is no image. */
  measurement?: string;
  /** sha256 of the key binding — see {@link reportData}. Lowercase hex, no `0x`. */
  report_data: string;
  debug: boolean;
  /** The platform's security version. Absent where there is no platform. */
  tcb?: { svn: number };
  /** The image's release ordinal. The anti-rollback anchor (Task 5). */
  release: number;
  /** Base64. Opaque to everything but a platform verifier. Absent where there is no report. */
  quote?: string;
}

/**
 * Evidence that carries a measured image — what `POST /handover`'s ladder
 * requires and what its parser produces.
 *
 * The handover ladder reads a measurement onto the curation allowlist and
 * compares a TCB level, so it cannot be handed evidence that omits either. That
 * is the same fact as "a static node refuses handover", stated in the type
 * system: there is no measured image behind a key derived from an operator
 * credential, so there is nothing for that ladder to climb.
 */
export interface MeasuredEvidence extends Evidence {
  measurement: string;
  tcb: { svn: number };
  quote: string;
}

const sha256Hex = (...parts: readonly Buffer[]): string => {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
};

/** This node's mock measurement: `sha256(utf8(image name))`, lowercase hex. */
export const mockMeasurement = (): string => sha256Hex(Buffer.from(MOCK_COORDINATOR_IMAGE, "utf8"));

/**
 * The curation allowlist key a measurement lands on: the measurement itself,
 * `0x`-prefixed as `bytes32` (P9). No namespace prefix, no second hash — the key
 * IS the raw sha256 image digest, so the value a node reads on chain is the same
 * value it verified in the evidence, and there is no derivation left to drift
 * across repos. The entry's `kind` is `"cvm-image"` — what the devnet actually
 * seeds — but that is inside the entry JSON, which this node reads and never
 * writes.
 */
export const allowlistKeyFor = (measurement: string): Hex => `0x${measurement.toLowerCase()}`;

/**
 * The key binding: `sha256(boundKey ‖ utf8(serviceId))`, lowercase hex (P24).
 *
 * `boundKey` is **whatever key the flow is about**, not a global: `GET /key`
 * binds the escrow generation it is advertising, and the handover join binds the
 * *channel* key it is about to receive material over. Evidence that always bound
 * the current generation would be evidence about the wrong key in half the
 * protocol.
 *
 * `serviceId` is **which flow it is about**, and defaults to the announcement's.
 * The two are domain-separated because they are otherwise interchangeable on the
 * wire — see {@link CHANNEL_SERVICE_ID} for the replay this closes (I7).
 */
export function reportData(boundKey: Buffer, serviceId: string = SERVICE_ID): string {
  if (boundKey.length !== ESCROW_PUBLIC_KEY_BYTES) {
    throw new Error(
      `evidence binds a ${ESCROW_PUBLIC_KEY_BYTES}-byte key and this one is ${boundKey.length}: ` +
        "a short key would produce a well-formed binding no verifier could reproduce",
    );
  }
  const idBytes = serviceId === SERVICE_ID ? SERVICE_ID_BYTES : Buffer.from(serviceId, "utf8");
  return sha256Hex(boundKey, idBytes);
}

/**
 * Evidence for one key, at one release ordinal.
 *
 * Pure, deterministic, and computable by anyone — see the header. The `quote`
 * says so in the clear rather than being random-looking bytes: a placeholder
 * that reached a production verifier should be self-identifying, not merely
 * invalid.
 */
export function mockEvidence(
  boundKey: Buffer,
  releaseOrdinal: number,
  serviceId: string = SERVICE_ID,
): MeasuredEvidence {
  if (!Number.isSafeInteger(releaseOrdinal) || releaseOrdinal < 0) {
    throw new Error(`a release ordinal is a non-negative integer, not ${releaseOrdinal}`);
  }
  const report = reportData(boundKey, serviceId);
  return {
    type: MOCK_EVIDENCE_TYPE,
    measurement: mockMeasurement(),
    report_data: report,
    // Never true. A debug-enabled guest is one an operator can single-step, so
    // every verifier in this protocol refuses it — including for mock evidence,
    // so the refusal is exercised rather than dead.
    debug: false,
    tcb: { svn: MOCK_TCB_SVN },
    release: releaseOrdinal,
    quote: Buffer.from(
      `${MOCK_EVIDENCE_TYPE}:not-a-real-attestation-quote:${report}`,
      "utf8",
    ).toString("base64"),
  };
}

/**
 * The type tag for a node whose escrow key is **derived from its operator
 * credential** rather than minted in a measured guest.
 *
 * Distinct from {@link MOCK_EVIDENCE_TYPE}, and the distinction is the point.
 * The mock tag is refused by every client outside `mode="mock"` because mock
 * evidence is computable by anyone and a mock node hands its whole key set to
 * any caller; teaching clients to accept that tag by default would remove that
 * guard for every deployment there is. This tag says a different and true thing
 * — this fleet's escrow is operator-keyed — and leaves the mock guard exactly
 * where it stands.
 */
export const STATIC_EVIDENCE_TYPE = "static-coordinator-v1";

/**
 * Evidence for a derived escrow key, at one release ordinal.
 *
 * **The binding is identical to the mock's and to a real report's** —
 * `sha256(escrow_pk32 ‖ utf8(SERVICE_ID))`, under the same service id — so
 * evidence and key still travel together and neither can be swapped for the
 * other. That is the whole of what this claims, and all of it is true.
 *
 * It carries no `measurement`, no `tcb` and no `quote`. There is no image to
 * measure, no platform to report a security version, and no report to quote;
 * filling any of the three with a placeholder would be asserting the one thing
 * a verifier exists to check.
 */
export function staticEvidence(boundKey: Buffer, releaseOrdinal: number): Evidence {
  if (!Number.isSafeInteger(releaseOrdinal) || releaseOrdinal < 0) {
    throw new Error(`a release ordinal is a non-negative integer, not ${releaseOrdinal}`);
  }
  return {
    type: STATIC_EVIDENCE_TYPE,
    report_data: reportData(boundKey),
    // Never true, and checked by every verifier in this protocol: a
    // debug-enabled guest is one an operator can single-step.
    debug: false,
    release: releaseOrdinal,
  };
}
