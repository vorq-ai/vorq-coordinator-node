import sodium from "sodium-native";

/**
 * The attested channel: the one-way confidential pipe a handover's key material
 * crosses.
 *
 * ## The wire contract, stated once and completely
 *
 * The plan named *"ephemeral X25519 ECDH → HKDF-SHA256 → XChaCha20-Poly1305"* and
 * stopped there — leaving the nonce, the KDF salt and info, the AAD and the
 * payload serialization undefined. An unspecified KDF is how two implementations
 * of one protocol silently disagree (P10), and a future real-attestation instance
 * has to interoperate byte for byte with what ships here. So the channel is
 * pinned to a construction that is already **specified elsewhere and implemented
 * in every libsodium binding**: `crypto_box_seal`.
 *
 * ```
 * seal(m, pk_r):
 *   (epk, esk) = crypto_box_keypair()                     fresh per message
 *   nonce      = BLAKE2b(epk ‖ pk_r, outlen = 24)         no key, no salt, no personal
 *   ikm        = X25519(esk, pk_r)                        32 bytes
 *   key        = HSalsa20(ikm, nonce = 0^16, sigma)       crypto_box_beforenm
 *   c          = XSalsa20-Poly1305(m, nonce, key)
 *   output     = epk ‖ c                                  |m| + 48 bytes
 * ```
 *
 * Read against the six things B4 asks to be stated:
 *
 * * **IKM** — the raw X25519 shared secret `X25519(esk, pk_r)`.
 * * **Salt** — none. The KDF is `crypto_core_hsalsa20` over the shared secret with
 *   a 16-byte zero nonce and the `sigma` constant `"expand 32-byte k"`; there is
 *   no salt input, and its absence is part of the specification rather than an
 *   omission here.
 * * **Info** — none, for the same reason. Domain separation for this channel is
 *   carried by the **evidence binding** instead: the recipient key `pk_r` is the
 *   one `report_data` commits to, under a `service_id` that is distinct from the
 *   one `GET /key` uses (`CHANNEL_SERVICE_ID`, I7). A key that is not the attested
 *   channel key cannot be a recipient of anything this protocol seals.
 * * **Nonce** — `BLAKE2b-24(epk ‖ pk_r)`, derived and never chosen. It is
 *   collision-free by construction because `epk` is fresh per message, and it
 *   **binds the recipient public key into the AEAD's nonce**: a blob resealed to
 *   another recipient does not authenticate.
 * * **AAD** — XSalsa20-Poly1305 has no associated-data field, so the bindings B4
 *   asks for live one place better: **inside the sealed plaintext**, where they
 *   are authenticated *and* confidential rather than merely authenticated. The
 *   handover payload's first 43 bytes are `magic ‖ mode ‖ release_ordinal ‖
 *   channel_pubkey`, and the joiner checks every one of them against what it
 *   asked for (`src/escrow/handover.ts`).
 * * **Payload encoding** — `HANDOVER-PAYLOAD-V1`, byte-exact, in
 *   `src/escrow/handover.ts`.
 *
 * ## Why this rather than a bespoke HKDF/XChaCha construction
 *
 * Three reasons, and the first is the one that decides it.
 *
 * 1. **A bespoke construction would buy no security here.** The plan's response
 *    shape (`holder_ephemeral_pk` beside the blob) implies the holder proves
 *    something by publishing an ephemeral key. It proves nothing: **nothing in
 *    this protocol authenticates the holder to the joiner** (I7), so an
 *    unauthenticated holder ephemeral key is exactly as meaningful as the
 *    ephemeral key already inside a sealed box — which is to say, it establishes
 *    confidentiality towards the attested channel key and no more. Writing 150
 *    lines of hand-rolled ECDH to arrive at the same guarantee would add a format
 *    to get wrong, not a property to rely on.
 * 2. **It is already the repo's one crypto path.** `crypto_box_seal` is what
 *    container v1's `seed_wrap` is, so there is one sealed-box implementation, one
 *    ambient declaration, and one set of tests behind both.
 * 3. **Cross-language parity is free.** `crypto_box_seal` exists in every
 *    libsodium binding under the same name, so a verifier or a successor written
 *    in another language interoperates without re-deriving a KDF from prose.
 *
 * The field `holder_ephemeral_pk` is therefore **not** in the response: it is the
 * first 32 bytes of `keys_sealed`, and a duplicated field is a field that can
 * drift from the bytes it describes.
 *
 * ## What this channel does not give you
 *
 * Confidentiality towards the holder of `channel_secret_key`, and nothing else.
 * It is anonymous — the recipient learns nothing about the sender — and it is
 * therefore **MITM-able by whoever controls the peer link**. Peer URLs must sit on
 * an authenticated transport; `README.md` says so where an operator configures
 * them.
 */

/** An X25519 public key — the channel identity the caller's evidence binds. */
export const CHANNEL_PUBLIC_KEY_BYTES = sodium.crypto_box_PUBLICKEYBYTES;

/** An X25519 secret key. Lives only in the joining process's memory. */
export const CHANNEL_SECRET_KEY_BYTES = sodium.crypto_box_SECRETKEYBYTES;

/**
 * `crypto_box_SEALBYTES` — 48: the 32-byte ephemeral public key plus the 16-byte
 * Poly1305 tag. A sealed payload is exactly `plaintext + 48` bytes.
 */
export const CHANNEL_SEAL_OVERHEAD_BYTES = sodium.crypto_box_SEALBYTES;

/**
 * The channel refused to open, or was handed something that is not a channel key.
 *
 * One message for "sealed to another key" and "tampered with", deliberately: a
 * caller that could tell the two apart holds an oracle over which channel keys a
 * blob was meant for.
 */
export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

/**
 * A fresh channel pair, minted by the **joiner** immediately before it generates
 * evidence over the public half.
 *
 * Per join, never reused and never persisted. Reuse would let one captured
 * `channel_secret_key` open every handover a node ever performed, and the whole
 * value of binding evidence to this key is that it is the key of *this* exchange.
 */
export function newChannelKeypair(): { publicKey: Buffer; secretKey: Buffer } {
  const publicKey = Buffer.alloc(CHANNEL_PUBLIC_KEY_BYTES);
  const secretKey = Buffer.alloc(CHANNEL_SECRET_KEY_BYTES);
  sodium.crypto_box_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

/** Seals a payload of any length to an attested channel public key. */
export function sealPayload(plaintext: Buffer, channelPublicKey: Buffer): Buffer {
  if (channelPublicKey.length !== CHANNEL_PUBLIC_KEY_BYTES) {
    throw new ChannelError(
      `a channel public key is ${CHANNEL_PUBLIC_KEY_BYTES} bytes, and this one is ` +
        `${channelPublicKey.length}`,
    );
  }
  const sealed = Buffer.alloc(plaintext.length + CHANNEL_SEAL_OVERHEAD_BYTES);
  sodium.crypto_box_seal(sealed, plaintext, channelPublicKey);
  return sealed;
}

/**
 * Opens a sealed payload, or throws.
 *
 * The public key is required as well as the secret one because `crypto_box_seal`
 * recomputes the nonce over `epk ‖ pk_r` — the recipient key is an *input* to the
 * authentication, which is the property that makes a blob unopenable under any
 * other recipient.
 */
export function openPayload(
  sealed: Buffer,
  channelPublicKey: Buffer,
  channelSecretKey: Buffer,
): Buffer {
  if (sealed.length < CHANNEL_SEAL_OVERHEAD_BYTES) {
    throw new ChannelError(
      `a sealed channel payload is at least ${CHANNEL_SEAL_OVERHEAD_BYTES} bytes, and this one ` +
        `is ${sealed.length}`,
    );
  }
  if (
    channelPublicKey.length !== CHANNEL_PUBLIC_KEY_BYTES ||
    channelSecretKey.length !== CHANNEL_SECRET_KEY_BYTES
  ) {
    throw new ChannelError("a channel key pair is two 32-byte X25519 keys");
  }

  const plaintext = Buffer.alloc(sealed.length - CHANNEL_SEAL_OVERHEAD_BYTES);
  const opened = sodium.crypto_box_seal_open(
    plaintext,
    sealed,
    channelPublicKey,
    channelSecretKey,
  );
  if (!opened) {
    throw new ChannelError(
      "this channel payload does not open: it was sealed to another channel key, or the bytes " +
        "were altered in transit",
    );
  }
  return plaintext;
}
