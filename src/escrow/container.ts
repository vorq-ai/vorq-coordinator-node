import { hkdfSync } from "node:crypto";
import sodium from "sodium-native";
import { keccak256, type Hex } from "viem";
import type { Address } from "../config.js";
import {
  CONTAINER_TAG,
  ContainerError,
  SEED_WRAP_BYTES,
  MIN_CONTAINER_BYTES,
} from "../container.js";
import { jobIdOf } from "../orders.js";

/**
 * The escrow's half of container v1: the commitment reached from **two pieces**,
 * the split exposed, and the sealed box whose opening end only this node holds.
 *
 * **Why this is not a second copy of `src/container.ts`.** The post door is
 * handed a whole container and hashes it end to end. `/release` never sees a
 * payload — it is handed a `seed_wrap` and a `ct_hash`, because the ciphertext
 * lives in object storage and may be gigabytes. So the escrow has to arrive at
 * the same `c` from the two pieces the request actually carries. Nothing here
 * re-states the format: the version byte, the wrap width and the minimum all
 * come from `src/container.ts`, which is the one definition in this repo, and
 * `test/escrow-container.test.ts` proves the two routes agree on **every**
 * vector rather than on one. That agreement is load-bearing in a way that hides
 * well: each half is internally consistent, so a drift between them would show
 * up only as releases authorised against a commitment no client ever signed.
 *
 * The seal end lives here too, because the wrap is part of the format and not a
 * separate protocol. `crypto_box_seal` over a 32-byte seed is exactly
 * `32 + crypto_box_SEALBYTES (48) = 80` bytes, which is `SEED_WRAP_BYTES` — the
 * format's fixed-width wrap is that arithmetic and {@link sealDek} asserts it
 * rather than trusting it.
 */

/**
 * The unsealed seed's width — the 32 bytes a client draws at random and seals.
 *
 * Split from {@link DEK_BYTES} (C5) because they are both 32 and conceptually
 * different: one constant for both means changing either silently changes the
 * other, on a boundary where the whole of P4's defence is that the sealed bytes
 * are *not* the key.
 */
export const SEED_BYTES = 32;

/** The HKDF **output** length: how many bytes of working key `deriveDek` asks for. */
export const DEK_BYTES = 32;

/**
 * The plaintext width {@link sealDek} accepts.
 *
 * A seed and a DEK are both 32 bytes; **this guard is about the sealed-box
 * payload width, not about which of the two it is.** `sealDek` is called with a
 * seed by every container builder and with a DEK by `src/escrow/release.ts`'s
 * response path, so a constant naming either role would be a false statement on
 * one side of the boundary (R5).
 */
export const SEALED_PAYLOAD_BYTES = 32;

/** An X25519 public key: the stable global identity of an escrow generation. */
export const ESCROW_PUBLIC_KEY_BYTES = sodium.crypto_box_PUBLICKEYBYTES;

/** An X25519 secret key. Never leaves memory, never reaches disk or a log. */
export const ESCROW_SECRET_KEY_BYTES = sodium.crypto_box_SECRETKEYBYTES;

/**
 * The 32-byte digest the commitment's preimage carries in place of the payload.
 * Named rather than spelled `32` twice, because it is `keccak256`'s width and
 * not a coincidence of the DEK's.
 */
const CT_HASH_BYTES = 32;

/**
 * The sealed box refused to open, or was never openable.
 *
 * Distinct from `ContainerError`: that type's faults map to a `400` at the post
 * door and describe *bytes that are not a container*. A wrap that will not open
 * is a well-formed container whose DEK this node cannot recover, which is a
 * different answer to a different caller (`/release`, Task 4).
 */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

const assertWidth = (name: string, value: Buffer, expected: number): void => {
  if (value.length !== expected) {
    throw new SealError(`${name} is ${expected} bytes, and this one is ${value.length}`);
  }
};

/**
 * `keccak256(version ‖ seed_wrap ‖ ct_hash)` — the same 113-byte preimage
 * `commitmentOf` hashes, reached from the two pieces `/release` receives.
 *
 * Both widths are checked first and this is not defensive noise. The preimage is
 * a concatenation, so a 79-byte wrap and a 33-byte hash produce a preimage of
 * exactly the right length and a completely plausible commitment — the class of
 * bug that has no symptom until two implementations disagree. `/release` takes
 * both values off the wire, so the caller chooses them.
 *
 * There is no `version` parameter. `/release` never sees a container, so it
 * cannot read byte 0 — but there is exactly one layout its two pieces could
 * belong to, and `CONTAINER_TAG` is it. The day a second one exists, this is
 * where the choice goes, with a real alternative to choose between.
 */
export function commitment(seedWrap: Buffer, ctHash: Buffer): Hex {
  assertWidth("a seed_wrap", seedWrap, SEED_WRAP_BYTES);
  assertWidth("a ciphertext hash", ctHash, CT_HASH_BYTES);
  return keccak256(
    Buffer.concat([CONTAINER_TAG, seedWrap, ctHash]) as unknown as Uint8Array,
  );
}

/**
 * `keccak256(owner ‖ c)` — 20 raw address bytes then the commitment word.
 *
 * Delegates to `jobIdOf`, which is written against `JobRegistry.sol`. A second
 * implementation of the id every provider re-derives is exactly the restatement
 * R32 exists to forbid; this is the escrow's name for it, not a second copy.
 *
 * The weld P4 leans on lives in this one line: `c` covers the wrap, so a wrap
 * lifted onto an attacker's own order lands on a different `jobId` and the
 * chain-read authorisation `/release` performs cannot be satisfied for it.
 */
export function jobIdFor(owner: Address, c: Hex): Hex {
  return jobIdOf(owner, c);
}

/**
 * The split `commitmentOf` performs inline, for the paths that need the pieces.
 *
 * Length and version are checked **before** the slice, for the reason
 * `src/container.ts` states and repeats here because it is the whole hazard:
 * `Buffer.subarray` clamps out of range instead of throwing, so an 80-byte
 * buffer would yield a 79-byte "wrap", an empty "ciphertext" and no error at
 * all. The faults are `src/container.ts`'s own — one vocabulary for one format.
 */
export function splitContainer(bytes: Buffer): { seedWrap: Buffer; ciphertext: Buffer } {
  if (bytes.length < MIN_CONTAINER_BYTES) {
    throw new ContainerError(
      "too_short",
      `a container is at least ${MIN_CONTAINER_BYTES} bytes — the version byte and an ` +
        `${SEED_WRAP_BYTES}-byte seed_wrap — and this one is ${bytes.length}`,
    );
  }
  if (!bytes.subarray(0, CONTAINER_TAG.length).equals(CONTAINER_TAG)) {
    throw new ContainerError(
      "bad_version",
      `a container v1 begins with the version byte 0x${CONTAINER_TAG.toString("hex")}, and this ` +
        `one begins with 0x${bytes.subarray(0, CONTAINER_TAG.length).toString("hex")}`,
    );
  }
  const split = CONTAINER_TAG.length + SEED_WRAP_BYTES;
  return {
    seedWrap: bytes.subarray(CONTAINER_TAG.length, split),
    ciphertext: bytes.subarray(split),
  };
}

/**
 * A fresh X25519 pair. The public half is published; the secret half never
 * leaves this process.
 *
 * Lives here rather than in the key manager because it is the sealed box's own
 * key type — the recipient end of {@link sealDek} — and a test of the wrap has
 * to be able to mint one without booting a key manager.
 */
export function newRecipientKeypair(): { publicKey: Buffer; secretKey: Buffer } {
  const publicKey = Buffer.alloc(ESCROW_PUBLIC_KEY_BYTES);
  const secretKey = Buffer.alloc(ESCROW_SECRET_KEY_BYTES);
  sodium.crypto_box_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

/** A secp256k1 private key's width — the input this derivation takes. */
const OPERATOR_KEY_BYTES = 32;

/**
 * 64 hex characters, `0x`/`0X` prefix already stripped.
 *
 * Anchored, unlike a length check on the *decoded* bytes: `Buffer.from(s, "hex")`
 * stops at the first character that is not a hex digit instead of throwing, so
 * `0x` + 64 valid hex chars + trailing garbage decodes to exactly 32 bytes and
 * would sail past a width check on the output. Checking the string's shape
 * before decoding is what makes that input a refusal instead of a silently
 * truncated key. Mirrors `src/escrow/operator.ts`'s `OPERATOR_KEY_HEX`, unanchored
 * to the `0x` prefix because this call accepts both spellings.
 */
const OPERATOR_KEY_HEX_BODY = /^[0-9a-fA-F]{64}$/;

/**
 * The escrow key derivation's salt: **explicitly zero-length**, exactly as
 * `deriveDek`'s is.
 *
 * RFC 5869 §2.2 substitutes `HashLen` zero bytes for an absent salt, so this is
 * the specified "no salt" case rather than an oversight, and the whole of the
 * domain separation lives in `info`. See `src/escrow/release.ts`'s
 * `DEK_HKDF_SALT` for the reasoning in full; it applies here unchanged.
 */
const ESCROW_KEY_HKDF_SALT = Buffer.alloc(0);

/**
 * The domain separator for the escrow key derivation.
 *
 * Distinct from the DEK's `"vorq-dek"` for the usual reason: two derivations
 * from two different secrets must not be able to collide into the same output
 * by construction, rather than by nobody having tried.
 */
export const ESCROW_KEY_HKDF_INFO = "vorq-escrow-x25519-v1";

/**
 * The escrow keypair a static-mode node derives from one `OPERATOR_KEY` entry.
 *
 * ```
 * escrow_sk = HKDF-SHA256(ikm = operator key bytes, salt = "", info = "vorq-escrow-x25519-v1", L = 32)
 * escrow_pk = crypto_scalarmult_base(escrow_sk)
 * ```
 *
 * **The HKDF is what keeps two primitives apart.** An `OPERATOR_KEY` entry is a
 * secp256k1 private key and this returns an X25519 pair. X25519 clamps any 32
 * bytes, so handing the raw operator key to `crypto_scalarmult_base` would work
 * — and that is exactly what makes it easy to do. One key, two curves, is a
 * cross-primitive reuse nothing downstream could detect.
 *
 * Deterministic and dependent on nothing but its argument, which is the property
 * the whole static mode rests on: every instance of a fleet, on every restart,
 * arrives at the same escrow key without exchanging a byte with any other.
 *
 * Lives beside {@link newRecipientKeypair} because it is the same key type
 * reached from the other direction. The refusal is **by shape** — checked
 * against the input string before it is decoded, not against the decoded
 * buffer's length, because `Buffer.from(s, "hex")` stops at the first
 * non-hex character rather than throwing: a string that is `0x` + 64 valid
 * hex chars + trailing garbage would otherwise decode to exactly 32 bytes and
 * pass a width check aimed at the output instead of the input. An operator
 * credential must never appear in an error message either way.
 */
export function escrowKeypairFromOperatorKey(operatorKeyHex: string): {
  publicKey: Buffer;
  secretKey: Buffer;
} {
  const hexBody = operatorKeyHex.replace(/^0x/i, "");
  if (!OPERATOR_KEY_HEX_BODY.test(hexBody)) {
    throw new SealError(
      `an operator key is ${OPERATOR_KEY_BYTES} bytes (64 hex characters), and this one is not`,
    );
  }
  const ikm = Buffer.from(hexBody, "hex");

  const secretKey = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      ESCROW_KEY_HKDF_SALT,
      Buffer.from(ESCROW_KEY_HKDF_INFO, "utf8"),
      ESCROW_SECRET_KEY_BYTES,
    ),
  );
  const publicKey = Buffer.alloc(ESCROW_PUBLIC_KEY_BYTES);
  sodium.crypto_scalarmult_base(publicKey, secretKey);
  return { publicKey, secretKey };
}

/**
 * Seals a 32-byte secret to a recipient's public key — the client's end of the
 * wrap, where that secret is a seed.
 *
 * Anonymous by construction: `crypto_box_seal` mints an ephemeral sender pair
 * per call, so the wrap carries no sender identity and two seals of the same
 * secret to the same recipient differ. That is what stops an observer from
 * testing a guessed seed against a posted container.
 *
 * Present in the coordinator for the wrap's *other* end to be testable and for
 * the handover flows to have one implementation of the box. **The node itself
 * never seals a container's wrap for production traffic** — it only ever opens
 * one; the seal it does perform in production is `/release` re-sealing the
 * derived DEK to the caller's response key.
 */
export function sealDek(dek: Buffer, recipientPk: Buffer): Buffer {
  assertWidth("a sealed-box payload", dek, SEALED_PAYLOAD_BYTES);
  assertWidth("a recipient public key", recipientPk, ESCROW_PUBLIC_KEY_BYTES);

  const wrap = Buffer.alloc(dek.length + sodium.crypto_box_SEALBYTES);
  if (wrap.length !== SEED_WRAP_BYTES) {
    // The format's fixed-width wrap *is* this arithmetic. If a libsodium build
    // ever changed `crypto_box_SEALBYTES`, every container this node produced
    // would be a different length and the split would land mid-ciphertext.
    throw new SealError(
      `a sealed ${SEALED_PAYLOAD_BYTES}-byte payload is ${wrap.length} bytes here, but container ` +
        `v1 fixes the seed_wrap at ${SEED_WRAP_BYTES}`,
    );
  }
  sodium.crypto_box_seal(wrap, dek, recipientPk);
  return wrap;
}

/**
 * Opens a wrap — the only end this node holds in production.
 *
 * Returns the sealed plaintext — a seed, on every container this node opens —
 * or throws; it never returns a partially-written buffer. The
 * width check is not optional: `crypto_box_seal_open` reads `SEALBYTES` of
 * header out of the input, and the output buffer is sized from the input's
 * length, so a short wrap would be a negative allocation rather than a refusal.
 * The trial-and-miss loop belongs to the key manager, which catches this.
 */
export function openDek(wrap: Buffer, publicKey: Buffer, secretKey: Buffer): Buffer {
  assertWidth("a seed_wrap", wrap, SEED_WRAP_BYTES);
  assertWidth("an escrow public key", publicKey, ESCROW_PUBLIC_KEY_BYTES);
  assertWidth("an escrow secret key", secretKey, ESCROW_SECRET_KEY_BYTES);

  const dek = Buffer.alloc(wrap.length - sodium.crypto_box_SEALBYTES);
  if (!sodium.crypto_box_seal_open(dek, wrap, publicKey, secretKey)) {
    // One message for "sealed to another key" and "tampered with", because the
    // box cannot tell them apart and neither should the answer: distinguishing
    // them would hand a griefer an oracle over which generations this node
    // still holds.
    throw new SealError("this seed_wrap does not open under this escrow key");
  }
  return dek;
}
