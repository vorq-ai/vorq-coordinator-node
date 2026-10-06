import sodium from "sodium-native";
import { recoverTypedDataAddress, type Hex } from "viem";
import { allowlistStatus, type Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import { Type, type Static } from "typebox";
import { ApiError } from "../api/errors.js";
import { base64Bytes } from "../api/params.js";
import { HexBare32, SafeUint, Sig65 } from "../api/schemas/common.js";
import {
  CHANNEL_SERVICE_ID,
  MOCK_EVIDENCE_TYPE,
  allowlistKeyFor,
  mockEvidence,
  reportData,
  type MeasuredEvidence,
} from "./attest.js";
import { operatorAddressOf } from "./operator.js";
import {
  CHANNEL_PUBLIC_KEY_BYTES,
  newChannelKeypair,
  openPayload,
  sealPayload,
} from "./channel.js";
import { ESCROW_PUBLIC_KEY_BYTES, ESCROW_SECRET_KEY_BYTES } from "./container.js";
import { ESCROW_KEY_RETENTION_MS, KeyManager, type AdoptableKey } from "./keys.js";
import { RELEASE_SKEW_SECONDS, releaseDomain, type KeyEpochStart } from "./release.js";

/**
 * `POST /handover` — attested key transfer, as a pull that changes nothing here.
 *
 * ## What the door does, in one paragraph
 *
 * A caller presents **its own** fresh evidence, bound to a channel public key it
 * has just minted, plus a signature from the network operator's key. This node
 * verifies every rung of the ladder before releasing a byte. On a pass, the whole
 * held key set plus this node's `keyEpochStart` is serialised **with deadlines
 * already stamped** (P11), sealed to the attested channel key, and returned.
 *
 * **Nothing local moves — ever.** There is no mode, no retirement, no drained
 * state. That is the single most important property of this file, and it is what
 * makes every other guarantee here cheap to state: the worst a caller can do,
 * having passed the ladder, is obtain a copy of what this node already holds.
 *
 * ## Why the holder does not stand down, and what replaces that
 *
 * An earlier design had a `takeover` mode: the successor's request retired the
 * holder's current generation and latched it into a permanent `410`. That put an
 * unrecoverable state change on the far side of a network call. If the successor
 * died between the retirement and its own `listen()` — a crash, a bad image, an
 * OOM — nothing on the network advertised an escrow key, and the only repair was
 * to restart the holder, which *erases the memory-only key set* and orphans every
 * open order. A crashed joiner turned a routine upgrade into total key loss.
 *
 * So cutover belongs to the orchestrator, not to the protocol. Both instances
 * stay live and serving; traffic moves to the successor once it is healthy; the
 * predecessor is then killed, and because keys live only in memory, **SIGTERM is
 * the drain**. One property of the boot path makes this work with no new
 * endpoint: `bootEscrow` is awaited before `app.listen`, and a failed join is a
 * failed boot — so an open socket already means "I hold the inherited keys."
 *
 * The cost, stated rather than discovered: an instance left running after a
 * botched cutover keeps its current generation with no deadline on it, and holds
 * that material for as long as the process lives. Nothing here erases it. Killing
 * superseded instances is an operational obligation, not a protocol guarantee.
 *
 * ## The topology is symmetric, and it has to be (P6)
 *
 * `/handover` is a **pure pull**: the caller sends no key material, and only an
 * instance configured with a peer URL ever learns anything. With one peer URL,
 * *"a generation minted on B reaches A"* and *"either instance serves any
 * release"* are false by construction, because nothing ever travels B → A.
 *
 * The exchange is made symmetric **by configuration** rather than by adding a
 * push: both instances carry the other's `PEER_URL`, and each pulls on its
 * own timer. B → A propagation is then A pulling from B, which is the same code
 * path as A → B and needs no second protocol direction to review.
 *
 * ## The current generation, and how it crosses without a null deadline
 *
 * `adoptKeys` refuses a key with no deadline (the enforceable half of P11), and a
 * holder's current generation carries `decayAt: null`. So serialisation
 * **projects** a deadline of `now + ESCROW_KEY_RETENTION_MS` onto any key that
 * has none: the peer's *copy* ages out even though the holder's original stays
 * current. Re-adoption can only move a deadline earlier (deliberately — a lagging
 * peer re-announcing a stale window must not extend every key it touches), so a
 * copy is retained 72 h from **first adoption**. An instance advertising one
 * generation for longer than that outlives its peer's copy of it, which is why
 * generation rotation exists.
 *
 * ## What authenticates whom
 *
 * Two independent gates run against the caller: the attestation evidence proves
 * *what code* is asking, and the operator signature proves *whose deployment* is
 * asking. Neither implies the other — configuration is not measured, so a genuine
 * image on a stranger's host, pointed at a chain that stranger controls, would
 * otherwise pass every evidence rung and then release every DEK through its own
 * `/release`.
 *
 * In the other direction nothing authenticates the **holder** to the joiner: the
 * channel is anonymous by construction and the response carries no signature, so
 * whoever controls a peer URL can stand in the middle. Peer URLs must sit on an
 * authenticated transport. `README.md` says so where an operator sets them.
 */

// ---------------------------------------------------------------------------
// Constants and the frozen refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * How far `issued_at` may sit from this node's clock, in seconds, inclusive (I7).
 *
 * Shared with `/release` rather than re-chosen: it is the same physical quantity
 * — a bound on clock skew between two hosts — and two numbers for one quantity is
 * how they drift. Without it a captured `/handover` body replays forever; with it
 * a capture is useful for ten minutes, and only to whoever also holds the channel
 * secret key the payload comes back sealed to.
 */
export const HANDOVER_SKEW_SECONDS = RELEASE_SKEW_SECONDS;

/** The widest legitimate body is ~700 characters of evidence JSON. */
export const HANDOVER_BODY_LIMIT_BYTES = 4096;

/** The largest sealed payload a joiner will accept: ~450 generations. */
export const HANDOVER_MAX_PAYLOAD_BYTES = 32_768;

/** The minimum platform security version this node will release keys to. */
export const MIN_TCB_SVN = 1;

/** Curation's three answers to `allowlistStatus`. */
const ALLOWLIST_ACTIVE = 1;
const ALLOWLIST_TOMBSTONED = 2;

const staleIssuedAt = (detail: string) =>
  new ApiError(400, "invalid_request", detail, "issued_at", "stale_issued_at");

/**
 * The evidence does not bind this exchange.
 *
 * Covers a `report_data` that does not reproduce **and** an evidence `type` this
 * mode cannot verify, on purpose: both are the same statement — *the artifact you
 * presented is not a binding this node can check against the key you named* — and
 * splitting them tells a caller which half of a forgery it got right.
 */
const badBinding = (detail: string) =>
  new ApiError(403, "authentication", detail, "evidence", "bad_binding");

const debugEvidence = (detail: string) =>
  new ApiError(403, "authentication", detail, "evidence", "debug_evidence");

/**
 * The caller is behind: a lower release ordinal, or a rolled-back TCB.
 *
 * The TCB version lands here rather than under `debug_evidence` because it is
 * the *same* statement as the ordinal check — the platform or the image this
 * caller runs has been superseded, and keys do not migrate backwards (M3). It is
 * enforced, not advisory: under mock evidence it is not security-bearing, because
 * mock evidence is forgeable, but the refusal is real and it is tested.
 */
const staleRelease = (detail: string) =>
  new ApiError(403, "authentication", detail, "evidence", "stale_release");

const notAllowlisted = (detail: string) =>
  new ApiError(403, "authentication", detail, "evidence", "not_allowlisted");

const tombstoned = (detail: string) =>
  new ApiError(403, "authentication", detail, "evidence", "tombstoned");

/** The signature is not one, or recovers nothing. Shape only — never identity. */
const badOperatorSignature = (detail: string) =>
  new ApiError(403, "authentication", detail, "operator_signature", "bad_operator_signature");

/**
 * The signature recovered an address that is not this network's operator.
 *
 * This is also where a **forged or cross-wired** signature lands, and
 * deliberately so: `ecrecover` does not fail on a wrong signature, it returns a
 * stranger. A signature over some other channel key, or lifted from another
 * exchange, is exactly "an address that is not authorised" and has no business
 * being told which of those two things it got wrong.
 */
const operatorNotAuthorized = (detail: string) =>
  new ApiError(403, "authentication", detail, "operator_signature", "operator_not_authorized");

/**
 * `HandoverAuth` — the operator's authorization for one pull.
 *
 * The escrow domain, beside `Release`, and pinned by the `handover-auth` case in
 * `vectors/signing-v3.json`: no contract verifies this, so the vector is the only
 * thing keeping the signer and the verifier in agreement across a release. Both
 * ends are coordinator instances, which makes a divergence show up at the worst
 * possible moment — two of our own processes refusing each other mid-upgrade.
 *
 * Every member is already in the body, so the signature covers the whole request.
 */
export const HANDOVER_AUTH_TYPES = {
  HandoverAuth: [
    { name: "channelPubkey", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;


// ---------------------------------------------------------------------------
// HANDOVER-PAYLOAD-V1 — the sealed plaintext, byte for byte
// ---------------------------------------------------------------------------

/**
 * The magic. Eight bytes of UTF-8, so a payload that is not one fails on the
 * first read rather than as a nonsensical key count.
 */
export const HANDOVER_MAGIC = Buffer.from("VORQHOV1", "utf8");

/**
 * `HANDOVER-PAYLOAD-V1`, the plaintext sealed to the channel key.
 *
 * ```
 * off  size  field
 *   0     8  magic             utf8 "VORQHOV1"
 *   8     2  release_ordinal   uint16 BE — the HOLDER's ordinal
 *  10    32  channel_pubkey    the caller's key, echoed byte for byte
 *  42     1  epoch_present     0x00 absent | 0x01 present
 * [43     8  epoch_time_ms     uint64 BE, unix milliseconds ] only if present
 * [51     8  epoch_block       uint64 BE                    ] only if present
 *   *     2  key_count         uint16 BE
 *   *    72  × key_count:  public_key(32) ‖ secret_key(32) ‖ decay_at(uint64 BE, ms)
 * ```
 *
 * Big-endian throughout and fixed-width everywhere: there is no varint, no
 * optional field outside the one flag, and no trailing slack, so a decoder that
 * disagrees about a length disagrees loudly.
 *
 * **The first 42 bytes are the authenticated binding B4 asks for.** XSalsa20-
 * Poly1305 has no AAD field, so they live inside the plaintext instead — where
 * they are confidential as well as authenticated. The joiner checks the echoed
 * `channel_pubkey` against what it sent, so a response cross-wired from another
 * exchange is a refusal rather than an adoption.
 *
 * **No `decayAt` may be null** (P11). The encoder refuses one rather than writing
 * a sentinel, because a sentinel is a value some decoder eventually maps back to
 * "current, never swept" — the key that accumulates on every upgrade and is
 * erased by nothing.
 */
export interface HandoverPayload {
  releaseOrdinal: number;
  channelPublicKey: Buffer;
  keyEpochStart: KeyEpochStart | null;
  keys: AdoptableKey[];
}

const KEY_RECORD_BYTES = ESCROW_PUBLIC_KEY_BYTES + ESCROW_SECRET_KEY_BYTES + 8;

export function encodeHandoverPayload(payload: HandoverPayload): Buffer {
  if (payload.channelPublicKey.length !== CHANNEL_PUBLIC_KEY_BYTES) {
    throw new Error(
      `a channel public key is ${CHANNEL_PUBLIC_KEY_BYTES} bytes, and this one is ` +
        `${payload.channelPublicKey.length}`,
    );
  }
  if (!Number.isInteger(payload.releaseOrdinal) || payload.releaseOrdinal < 0 || payload.releaseOrdinal > 0xffff) {
    throw new Error(`a release ordinal is a uint16, not ${payload.releaseOrdinal}`);
  }
  if (payload.keys.length > 0xffff) throw new Error("a handover carries at most 65535 generations");

  const epoch = payload.keyEpochStart;
  const header = Buffer.alloc(43 + (epoch === null ? 0 : 16) + 2);
  HANDOVER_MAGIC.copy(header, 0);
  header.writeUInt16BE(payload.releaseOrdinal, 8);
  payload.channelPublicKey.copy(header, 10);
  header[42] = epoch === null ? 0x00 : 0x01;
  let cursor = 43;
  if (epoch !== null) {
    header.writeBigUInt64BE(BigInt(epoch.time), cursor);
    header.writeBigUInt64BE(epoch.block, cursor + 8);
    cursor += 16;
  }
  header.writeUInt16BE(payload.keys.length, cursor);

  const records = payload.keys.map((key) => {
    // P11's wall, at the wire rather than only at `adoptKeys`: the holder stamps
    // deadlines *before* it serialises, and a payload that could express "no
    // deadline" is a payload that eventually carries one.
    if (typeof key.decayAt !== "number" || !Number.isFinite(key.decayAt)) {
      throw new Error(
        "every serialised escrow key must carry a deadline (P11): a null decayAt means " +
          "'current, never swept', and adopting one creates a key erased by nothing",
      );
    }
    if (
      key.publicKey.length !== ESCROW_PUBLIC_KEY_BYTES ||
      key.secretKey.length !== ESCROW_SECRET_KEY_BYTES
    ) {
      throw new Error("an escrow key is a 32-byte public key and a 32-byte secret key");
    }
    const record = Buffer.alloc(KEY_RECORD_BYTES);
    key.publicKey.copy(record, 0);
    key.secretKey.copy(record, ESCROW_PUBLIC_KEY_BYTES);
    record.writeBigUInt64BE(BigInt(Math.trunc(key.decayAt)), ESCROW_PUBLIC_KEY_BYTES + ESCROW_SECRET_KEY_BYTES);
    return record;
  });

  return Buffer.concat([header, ...records]);
}

export function decodeHandoverPayload(bytes: Buffer): HandoverPayload {
  if (bytes.length < 45) throw new Error("a handover payload is at least 45 bytes");
  if (!bytes.subarray(0, 8).equals(HANDOVER_MAGIC)) {
    throw new Error("these bytes carry no HANDOVER-PAYLOAD-V1 magic");
  }

  const releaseOrdinal = bytes.readUInt16BE(8);
  const channelPublicKey = Buffer.from(bytes.subarray(10, 42));

  const present = bytes[42];
  if (present !== 0x00 && present !== 0x01) throw new Error("the epoch flag is 0x00 or 0x01");
  let cursor = 43;
  let keyEpochStart: KeyEpochStart | null = null;
  if (present === 0x01) {
    if (bytes.length < 61) throw new Error("a handover payload with an epoch is at least 61 bytes");
    keyEpochStart = {
      time: Number(bytes.readBigUInt64BE(cursor)),
      block: bytes.readBigUInt64BE(cursor + 8),
    };
    cursor += 16;
  }

  const count = bytes.readUInt16BE(cursor);
  cursor += 2;
  if (bytes.length !== cursor + count * KEY_RECORD_BYTES) {
    throw new Error(
      `a handover payload of ${count} generations is ${cursor + count * KEY_RECORD_BYTES} bytes, ` +
        `and this one is ${bytes.length}`,
    );
  }

  const keys: AdoptableKey[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = cursor + index * KEY_RECORD_BYTES;
    keys.push({
      publicKey: Buffer.from(bytes.subarray(at, at + ESCROW_PUBLIC_KEY_BYTES)),
      secretKey: Buffer.from(
        bytes.subarray(at + ESCROW_PUBLIC_KEY_BYTES, at + ESCROW_PUBLIC_KEY_BYTES + ESCROW_SECRET_KEY_BYTES),
      ),
      decayAt: Number(bytes.readBigUInt64BE(at + ESCROW_PUBLIC_KEY_BYTES + ESCROW_SECRET_KEY_BYTES)),
    });
  }

  return { releaseOrdinal, channelPublicKey, keyEpochStart, keys };
}

// ---------------------------------------------------------------------------
// The key epoch start marker (I8/P)
// ---------------------------------------------------------------------------

/**
 * `min()` over two epoch markers: **the minimum of the epoch-start timestamps,
 * ties resolved to the lower ordinal** (P21).
 *
 * Defined here, in the task that produces, serialises and adopts the marker —
 * Task 6 owns only the book filter that reads `block`. The plan had Task 5
 * depending on a Task 6 definition while Task 6 listed Task 5 as a prerequisite,
 * which is a deadlock under task-by-task execution.
 *
 * The union of two instances' keys is custodied from the **earlier** of their two
 * epochs, so the earlier one is what bounds orphanhood: a job that predates the
 * earliest custody is the only job whose key can be provably gone. `null` is *no
 * information*, never zero — an absent marker means "cannot say", and taking it
 * as the minimum would declare every job an orphan.
 *
 * The tie-break is real rather than decorative: two instances booting inside the
 * same millisecond is exactly what a rolling restart does, and without a rule the
 * result would depend on argument order.
 */
export function minKeyEpochStart(
  a: KeyEpochStart | null,
  b: KeyEpochStart | null,
): KeyEpochStart | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.time !== b.time) return a.time < b.time ? a : b;
  return a.block <= b.block ? a : b;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface HandoverRequest {
  evidence: MeasuredEvidence;
  channelPublicKey: Buffer;
  issuedAt: bigint;
  /** The operator's `HandoverAuth` signature over the two fields above. */
  operatorSignature: Hex;
}

const BareHex32 = (message: string) => HexBare32({ error: { message } });

/**
 * The `/handover` body, by shape. A body with no signature at all is a
 * malformed request, not a failed authorization: answering `403` to one would
 * tell a prober the field is optional somewhere.
 */
export const HandoverBody = Type.Object({
  channel_pubkey: BareHex32("must be 64 hex characters — a 32-byte X25519 public key, no 0x prefix"),
  operator_signature: Sig65({
    description: "The operator's EIP-712 `HandoverAuth` over the channel key and `issued_at`.",
    error: { message: "must be 0x followed by 130 hex characters — a 65-byte secp256k1 signature" },
  }),
  issued_at: SafeUint({ description: "Unix seconds, within the handover skew." }),
  evidence: Type.Object({
    type: Type.String(),
    measurement: BareHex32("must be 64 hex characters, no 0x prefix"),
    report_data: BareHex32("must be 64 hex characters, no 0x prefix"),
    debug: Type.Boolean(),
    tcb: Type.Object({ svn: Type.Integer() }),
    release: Type.Integer({ minimum: 0 }),
    quote: Type.Optional(Type.String({ description: "Base64; opaque to all but a platform verifier." })),
  }),
});
export type HandoverBody = Static<typeof HandoverBody>;

/**
 * The body, by shape, plus the one rung that needs nothing but a clock.
 *
 * The parse order is the check order and it is part of the contract: the freshness
 * bound costs a clock read, the evidence checks cost a sha256, and the chain read
 * comes last — so a griefer cannot make this node spend an `eth_call` with a body
 * that was never going to verify.
 */
export function parseHandover(fields: HandoverBody, nowSeconds: number): HandoverRequest {
  const issuedAt = BigInt(fields.issued_at);
  const skew = Number(issuedAt) - nowSeconds;
  if (Math.abs(skew) > HANDOVER_SKEW_SECONDS) {
    throw staleIssuedAt(
      `issued_at is ${Math.abs(skew)} s from this node's clock, and a handover request is ` +
        `accepted within ${HANDOVER_SKEW_SECONDS} s either way`,
    );
  }

  const { evidence } = fields;
  return {
    evidence: {
      type: evidence.type,
      measurement: evidence.measurement.toLowerCase(),
      report_data: evidence.report_data.toLowerCase(),
      debug: evidence.debug,
      tcb: { svn: evidence.tcb.svn },
      release: evidence.release,
      quote: evidence.quote ?? "",
    },
    channelPublicKey: Buffer.from(fields.channel_pubkey.toLowerCase(), "hex"),
    issuedAt,
    operatorSignature: fields.operator_signature as Hex,
  };
}

// ---------------------------------------------------------------------------
// The holder's side
// ---------------------------------------------------------------------------

export interface HandoverDeps {
  keys: KeyManager;
  chain: Chain;
  config: Config;
  /** This node's clock, in milliseconds. Injected so the ±600 s bound is testable. */
  nowMs: number;
  /** This node's marker, or `null`. Serialised so the peer filters the same book. */
  keyEpochStart: KeyEpochStart | null;
}

/** `{ "keys_sealed": "<b64>", "key_count": n, "holder_release": n }`. */
export interface HandoverResponse {
  keys_sealed: string;
  /**
   * How many generations the blob carries. **Not** a substitute for opening it —
   * the joiner counts what it decoded — but it lets an operator read a log line
   * and see that a handover moved something.
   */
  key_count: number;
  /** This node's own release ordinal, so a joiner can see what it took keys from. */
  holder_release: number;
}

/**
 * The verification ladder, then the read. Rungs run in order, cheapest first, so
 * a griefer cannot make this node spend an `eth_call` on a body that was never
 * going to verify.
 *
 * "A tombstoned measurement leaves the holder completely unchanged" is now true
 * of *every* outcome, refusal and success alike: this function has no branch that
 * writes to the key manager. The state-unchanged assertions in the tests are a
 * regression guard on that property, not a description of one path through it.
 */
export async function handover(deps: HandoverDeps, body: HandoverBody): Promise<HandoverResponse> {
  const { keys, chain, config } = deps;
  const request = parseHandover(body, Math.floor(deps.nowMs / 1000));

  // 1. The evidence type this mode can verify. A production verifier rejects mock
  //    categorically; mock mode accepts exactly one tag, and deliberately not the
  //    provider mock's — that is a different trust domain holding different keys.
  if (request.evidence.type !== MOCK_EVIDENCE_TYPE) {
    throw badBinding(
      `this node verifies "${MOCK_EVIDENCE_TYPE}" evidence and was given ` +
        `"${request.evidence.type}"`,
    );
  }

  // 2. A debug-enabled guest is one an operator can single-step.
  if (request.evidence.debug) {
    throw debugEvidence(
      "this evidence describes a debug-enabled guest, whose memory an operator can read; no " +
        "escrow key material is released to one",
    );
  }
  if (request.evidence.tcb.svn < MIN_TCB_SVN) {
    throw staleRelease(
      `this evidence reports TCB svn ${request.evidence.tcb.svn}, below the minimum of ` +
        `${MIN_TCB_SVN}: keys do not migrate onto a rolled-back platform`,
    );
  }

  // 3. The binding, under the **channel** service id (I7). A `GET /key` response
  //    replayed here fails exactly at this rung.
  const expected = reportData(request.channelPublicKey, CHANNEL_SERVICE_ID);
  if (request.evidence.report_data !== expected) {
    throw badBinding(
      "evidence.report_data does not reproduce sha256(channel_pubkey ‖ " +
        `utf8("${CHANNEL_SERVICE_ID}")): this evidence is not about this channel key`,
    );
  }

  // 4. Anti-rollback, **before** the chain read because it costs nothing (M3).
  //    Enforced rather than advisory: under mock evidence it is not
  //    security-bearing, since the ordinal is forgeable, but the refusal is real.
  if (request.evidence.release < config.escrow.releaseOrdinal) {
    throw staleRelease(
      `this caller reports release ordinal ${request.evidence.release} and this node is at ` +
        `${config.escrow.releaseOrdinal}: escrow keys never migrate to a superseded image`,
    );
  }

  // 5. The operator's signature, recovered **before** any chain read because
  //    `ecrecover` is local and an `eth_call` is not. Every field the caller sent
  //    is covered: `channelPubkey` binds the signature to this one exchange, and
  //    `issuedAt` to the same ±600 s window rung 0 already enforced.
  //
  //    A malformed signature and an unauthorised one are different codes because
  //    they are different operator problems — a truncated header versus a key
  //    curation has not listed — and neither reveals anything a caller that
  //    produced it does not already know.
  let operator: string;
  try {
    operator = await recoverTypedDataAddress({
      domain: releaseDomain(config.addresses.chainId),
      types: HANDOVER_AUTH_TYPES,
      primaryType: "HandoverAuth",
      message: {
        channelPubkey: `0x${request.channelPublicKey.toString("hex")}` as Hex,
        issuedAt: request.issuedAt,
      },
      signature: request.operatorSignature,
    });
  } catch {
    throw badOperatorSignature(
      "operator_signature is not a recoverable secp256k1 signature over this HandoverAuth",
    );
  }

  // 6. **Whose deployment is asking**, and the answer is a shared secret rather
  //    than chain state: the signature has to recover to the address of the key
  //    this node itself holds. The escrow fleet shares `OPERATOR_KEY`, so
  //    "signed by our operator" and "signed by a key I have" are one statement.
  //
  //    This rung exists because no evidence rung can carry it. A measurement
  //    covers the image, the image is a published reproducible build, and a
  //    node's chain endpoint and registry addresses come from its environment
  //    where no measurement reaches. So the genuine, allowlisted image on a
  //    stranger's host, pointed at a chain they control, clears every attestation
  //    check ever written and then releases every DEK it pulled through its own
  //    `/release`. Attested code is not on its own a reason to hand over keys.
  //
  //    Local, so it goes **before** the chain read: an unauthorised caller costs
  //    this node no RPC at all. It leaks nothing in exchange — a caller without
  //    the key learns only what they already knew.
  //
  //    **Every** configured key is accepted, not only the one this node signs
  //    with. That is what makes a key change possible at all: a node reads its
  //    keys once at boot and a restart would erase the key set, so a successor
  //    carrying a new key can only join a predecessor that still accepts the old
  //    one. Rotation is `K_old` → `K_old,K_new` → `K_new`, two ordinary cutovers.
  if (config.escrow.operatorKeys.length === 0) {
    // Unreachable through `loadConfig`, which refuses this at any mode that holds
    // keys. Kept as a refusal rather than an assertion because the alternative to
    // answering here is verifying against nothing.
    throw operatorNotAuthorized(
      "this node holds no operator key and therefore cannot authenticate any handover",
    );
  }
  const accepted = config.escrow.operatorKeys.map((key) => operatorAddressOf(key).toLowerCase());
  if (!accepted.includes(operator.toLowerCase())) {
    throw operatorNotAuthorized(
      `operator_signature recovers ${operator}, which is not this network's operator key. ` +
        "Attested code is not on its own a reason to release keys: the deployment running it " +
        "must be one this network stood up.",
    );
  }

  // 7. Curation, **on chain and not from the projection**: the one place where
  //    being a minute behind means handing key material to an image curation has
  //    just withdrawn. Answers *is this code curated*, which the rung above
  //    cannot — a shared secret says nothing about what binary is holding it.
  const imageStatus = await allowlistStatus(
    chain,
    config.addresses.providerRegistry,
    allowlistKeyFor(request.evidence.measurement),
  );
  if (imageStatus === ALLOWLIST_TOMBSTONED) {
    throw tombstoned(
      `curation has tombstoned measurement ${request.evidence.measurement}: this image is ` +
        "withdrawn and no key material is released to it",
    );
  }
  if (imageStatus !== ALLOWLIST_ACTIVE) {
    throw notAllowlisted(
      `curation has no active allowlist entry for measurement ${request.evidence.measurement}`,
    );
  }

  // 8. Serialise. **Nothing local moves, here or anywhere in this function** —
  //    the holder keeps its current generation, keeps advertising it, and keeps
  //    serving releases for it. A caller's only effect on this node is the read.
  //
  // **The key manager's clock, not the route's** (S8). This is a key-lifecycle
  // deadline — the peer sweeps against it — and `deps.nowMs` is real time. The
  // two are the same number wherever `ESCROW_CLOCK_OFFSET_MS` is 0, which
  // the loader enforces outside `mode: "mock"`; where they differ, a projection
  // stamped from the route clock is a deadline measured on a clock that never
  // erases anything.
  const deadline = keys.now() + ESCROW_KEY_RETENTION_MS;
  const held = keys.heldKeys();
  const plaintext = encodeHandoverPayload({
    releaseOrdinal: config.escrow.releaseOrdinal,
    channelPublicKey: request.channelPublicKey,
    keyEpochStart: deps.keyEpochStart,
    keys: held.map((key) => ({
      publicKey: key.publicKey,
      secretKey: key.secretKey,
      // The holder's current generation carries `decayAt: null` and `adoptKeys`
      // refuses that, so the peer's *copy* takes a projected deadline while the
      // holder keeps serving the original as current. This is the only place a
      // deadline is invented, and it is invented for the copy alone.
      decayAt: key.decayAt ?? deadline,
    })),
  });

  const sealed = sealPayload(plaintext, request.channelPublicKey);
  // The blob is on its way out; the plaintext copy of every secret key in this
  // process is not something to leave for the garbage collector.
  sodium.sodium_memzero(plaintext);

  return {
    keys_sealed: sealed.toString("base64"),
    key_count: held.length,
    holder_release: config.escrow.releaseOrdinal,
  };
}

// ---------------------------------------------------------------------------
// The joiner's side
// ---------------------------------------------------------------------------

/** A peer refused, or answered something a joiner will not adopt. */
export class HandoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoverError";
  }
}

/** One HTTP exchange with a peer. Injected so the tests need no socket. */
export type PeerTransport = (
  url: string,
  init: { method: "GET" | "POST"; body?: string },
) => Promise<{ status: number; body: string }>;

/** `fetch`, in the shape above. The default in a booted node. */
const fetchTransport: PeerTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    ...(init.body === undefined
      ? {}
      : { body: init.body, headers: { "content-type": "application/json" } }),
  });
  return { status: response.status, body: await response.text() };
};

export interface JoinOptions {
  /** The peer's base URL. `/key` and `/handover` hang off it. */
  peerUrl: string;
  /** This instance's manager. Adopted into, never read from. */
  keys: KeyManager;
  /** This image's ordinal, which the joiner's own evidence carries. */
  releaseOrdinal: number;
  /**
   * Signs the `HandoverAuth` that proves this deployment is one the network
   * authorised. A function rather than a key, so nothing here ever holds the
   * secret and a test can sign with whatever account it likes.
   */
  signAuth: (message: { channelPubkey: Hex; issuedAt: bigint }) => Promise<Hex>;
  /** This instance's marker before the join; the result carries the merged one. */
  keyEpochStart: KeyEpochStart | null;
  transport?: PeerTransport;
  nowMs?: () => number;
}

export interface JoinResult {
  /** How many generations the peer served. */
  adopted: number;
  /** `min(own, peer's)` — P21. */
  keyEpochStart: KeyEpochStart | null;
  /** The peer's own release ordinal, for the log line. */
  peerRelease: number;
}

/**
 * The join: mint a channel, attest over it, pull, verify the echo, adopt.
 *
 * The `GET /key` step is a **liveness probe and nothing more**. Its status is
 * recorded and never gates: a peer still joining answers `503` and yet holds
 * every generation worth having. What the probe buys is a clear failure — "the
 * peer is not answering at all" — distinct from "the peer refused the handover",
 * which carries a code.
 *
 * The joiner then checks the payload's echoed `channel_pubkey`. That check is
 * what makes the 42-byte header a binding rather than decoration: a response
 * cross-wired from another exchange is a refusal instead of a silent adoption.
 */
export async function joinPeer(options: JoinOptions): Promise<JoinResult> {
  const transport = options.transport ?? fetchTransport;
  const now = options.nowMs ?? Date.now;
  const base = options.peerUrl.replace(/\/+$/, "");

  const channel = newChannelKeypair();
  // The evidence is regenerated **over the channel key**, under the channel
  // service id. Evidence about this node's own escrow generation would be
  // evidence about the wrong key, and (I7) is deliberately not interchangeable.
  const evidence = mockEvidence(channel.publicKey, options.releaseOrdinal, CHANNEL_SERVICE_ID);

  try {
    await transport(`${base}/key`, { method: "GET" });
  } catch (cause) {
    throw new HandoverError(
      `the escrow peer at ${base} is not answering: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const issuedAt = Math.floor(now() / 1000);
  const operatorSignature = await options.signAuth({
    channelPubkey: `0x${channel.publicKey.toString("hex")}` as Hex,
    issuedAt: BigInt(issuedAt),
  });

  const answer = await transport(`${base}/handover`, {
    method: "POST",
    body: JSON.stringify({
      evidence,
      channel_pubkey: channel.publicKey.toString("hex"),
      issued_at: issuedAt,
      operator_signature: operatorSignature,
    }),
  });

  if (answer.status !== 200) {
    let code = "unknown";
    try {
      code = (JSON.parse(answer.body) as { error?: { code?: string } }).error?.code ?? "unknown";
    } catch {
      // A peer that answered something other than this node's envelope. The
      // status is still the useful half.
    }
    throw new HandoverError(
      `the escrow peer at ${base} refused this handover: ${answer.status} ${code}`,
    );
  }

  const parsed = JSON.parse(answer.body) as { keys_sealed?: unknown; holder_release?: unknown };
  if (typeof parsed.keys_sealed !== "string") {
    throw new HandoverError(`the escrow peer at ${base} answered 200 with no keys_sealed`);
  }
  const sealed = base64Bytes(parsed.keys_sealed, "keys_sealed", HANDOVER_MAX_PAYLOAD_BYTES);

  const plaintext = openPayload(sealed, channel.publicKey, channel.secretKey);
  let payload: HandoverPayload;
  try {
    payload = decodeHandoverPayload(plaintext);
  } finally {
    sodium.sodium_memzero(plaintext);
  }

  if (!payload.channelPublicKey.equals(channel.publicKey)) {
    throw new HandoverError(
      `the escrow peer at ${base} echoed a channel key that is not the one this join minted`,
    );
  }
  /**
   * **A joiner never adopts its own current generation back** — and the symmetric
   * replica topology is exactly what makes this necessary rather than theoretical.
   *
   * A pulls from B and adopts B's current generation as a deadlined copy. On B's
   * next pull, A serialises everything it holds, *including that copy*, and B
   * would be adopting its own live key with a deadline on it. `adoptKeys` treats a
   * deadlined key it already holds as current by clearing the current pointer —
   * correctly, since a key cannot be both un-sweepable and scheduled for erasure —
   * so B would silently stop advertising a generation it is still minting under.
   * Measured: without this filter, one round of symmetric sync leaves `GET /key`
   * on B answering `503 escrow_key_unminted` forever.
   *
   * Task 2's comment calls this shape "not one the protocol produces". That was
   * true of a one-sided pull. It is not true of a symmetric one, and the fix
   * belongs here — the joiner is the only party that knows which key is its own.
   */
  const own = options.keys.current();
  const incoming =
    own === null
      ? payload.keys
      : payload.keys.filter((key) => !key.publicKey.equals(own.publicKey));

  options.keys.adoptKeys(incoming);
  for (const key of payload.keys) sodium.sodium_memzero(key.secretKey);

  return {
    adopted: incoming.length,
    // P21, in both flows: holding the union of two instances' keys means the
    // **earlier** epoch is what bounds orphanhood.
    keyEpochStart: minKeyEpochStart(options.keyEpochStart, payload.keyEpochStart),
    peerRelease: payload.releaseOrdinal,
  };
}

export interface SyncOptions extends Omit<JoinOptions, "keyEpochStart"> {
  intervalMs: number;
  /** Read fresh each tick: the marker may have moved since the last one. */
  keyEpochStart: () => KeyEpochStart | null;
  /** Where the merged marker goes. */
  onEpoch: (epoch: KeyEpochStart | null) => void;
  onSync?: (result: JoinResult) => void;
  onError?: (error: unknown) => void;
}

/**
 * The standing sync: a pull from the peer, every interval.
 *
 * **A dead peer only pauses sync; it never blocks serving.** Every tick's failure
 * is reported and swallowed, because the alternative — an unhandled rejection on
 * a timer — would take down a node that is still perfectly able to release every
 * key it holds.
 *
 * `tick()` is exposed so the exercises can drive propagation deterministically
 * rather than by waiting on a timer, and the timer is `unref`'d so a five-minute
 * interval cannot hold a process open through a SIGTERM.
 */
export function startPeerSync(options: SyncOptions): { tick(): Promise<void>; stop(): void } {
  let running = false;

  const tick = async (): Promise<void> => {
    // One in flight at a time: a peer slower than the interval would otherwise
    // accumulate overlapping joins, each adopting the same generations.
    if (running) return;
    running = true;
    try {
      const result = await joinPeer({ ...options, keyEpochStart: options.keyEpochStart() });
      options.onEpoch(result.keyEpochStart);
      options.onSync?.(result);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
