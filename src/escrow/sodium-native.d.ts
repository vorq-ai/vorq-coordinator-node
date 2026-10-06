/**
 * `sodium-native@5` ships no type declarations, so this is the ambient surface
 * for the five calls this repo makes — and nothing else.
 *
 * Deliberately narrow. A `declare module "sodium-native"` returning `any` would
 * type-check a transposed argument list, and every function here writes into a
 * caller-supplied buffer: `crypto_box_seal(out, message, publicKey)` with the
 * first two swapped is a silent corruption, not a compile error. Declaring the
 * exact arity and the exact `Buffer` positions is the only thing that makes the
 * TypeScript gate mean anything over a native addon.
 */
declare module "sodium-native" {
  /** 48 — `crypto_box_SEALBYTES`, the ephemeral public key plus the MAC. */
  export const crypto_box_SEALBYTES: number;
  /** 32 — an X25519 public key. */
  export const crypto_box_PUBLICKEYBYTES: number;
  /** 32 — an X25519 secret key. */
  export const crypto_box_SECRETKEYBYTES: number;

  /** Fills `publicKey` and `secretKey` with a fresh X25519 pair. */
  export function crypto_box_keypair(publicKey: Buffer, secretKey: Buffer): void;

  /**
   * Writes the X25519 public half of `secretKey` into `publicKey`.
   *
   * The other direction from {@link crypto_box_keypair}: a pair whose secret
   * half was derived rather than drawn still needs its public half, and this
   * reproduces exactly what `crypto_box_keypair` would have written for that
   * secret.
   */
  export function crypto_scalarmult_base(publicKey: Buffer, secretKey: Buffer): void;

  /** Writes an anonymous sealed box of `message` for `publicKey` into `ciphertext`. */
  export function crypto_box_seal(
    ciphertext: Buffer,
    message: Buffer,
    publicKey: Buffer,
  ): void;

  /** Opens a sealed box into `message`. Returns `false` on any authentication failure. */
  export function crypto_box_seal_open(
    message: Buffer,
    ciphertext: Buffer,
    publicKey: Buffer,
    secretKey: Buffer,
  ): boolean;

  /** Overwrites the buffer with zeroes in a way the optimiser may not elide. */
  export function sodium_memzero(buffer: Buffer): void;
}
