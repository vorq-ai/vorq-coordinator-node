import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ESCROW_KEY_HKDF_INFO,
  ESCROW_PUBLIC_KEY_BYTES,
  ESCROW_SECRET_KEY_BYTES,
  escrowKeypairFromOperatorKey,
  openDek,
  sealDek,
} from "../src/escrow/container.js";
import { SEED_WRAP_BYTES } from "../src/container.js";
import { StaticKeyManager } from "../src/escrow/static-keys.js";

/**
 * The static escrow: one HKDF from an operator credential to an X25519 pair,
 * and a key manager with no lifecycle at all.
 *
 * Nothing here has a clock. That is the whole difference from `keys.test.ts`:
 * a derived key set never rotates, never decays and is never swept, so there is
 * no time for a test to drive.
 */

/** Not credentials. No chain has ever used either of these. */
const OPERATOR_A = `0x${"11".repeat(32)}`;
const OPERATOR_B = `0x${"22".repeat(32)}`;

/**
 * **The pinned derivation.** Computed once, from the two published inputs, and
 * written down here so the derivation cannot change silently.
 *
 * A change to the `info` string, the salt, the hash or the output length moves
 * every deployed node's escrow key at the same instant and orphans every wrap
 * in flight — a failure that is invisible until a provider cannot release. This
 * vector is what makes that a red test instead.
 */
const DERIVED_A_PK = "5fa375171bb75a9c53039f1213e98c8e239c965b47cf6168b1867810fc68ff16";
const DERIVED_B_PK = "5dbb62f8d6978a06a720f2add0a6880939ef44d669ee36333024477184ad5c0d";

describe("escrowKeypairFromOperatorKey", () => {
  it("reproduces the pinned vector", () => {
    const pair = escrowKeypairFromOperatorKey(OPERATOR_A);
    expect(pair.publicKey.toString("hex")).toBe(DERIVED_A_PK);
    expect(pair.publicKey).toHaveLength(ESCROW_PUBLIC_KEY_BYTES);
    expect(pair.secretKey).toHaveLength(ESCROW_SECRET_KEY_BYTES);
  });

  it("is deterministic: the same operator key derives the same escrow key", () => {
    const first = escrowKeypairFromOperatorKey(OPERATOR_A);
    const second = escrowKeypairFromOperatorKey(OPERATOR_A);
    expect(second.publicKey).toEqual(first.publicKey);
    expect(second.secretKey).toEqual(first.secretKey);
  });

  it("separates two operator keys", () => {
    expect(escrowKeypairFromOperatorKey(OPERATOR_B).publicKey.toString("hex")).toBe(DERIVED_B_PK);
    expect(DERIVED_B_PK).not.toBe(DERIVED_A_PK);
  });

  it("accepts the key with or without its 0x prefix", () => {
    const prefixed = escrowKeypairFromOperatorKey(OPERATOR_A);
    const bare = escrowKeypairFromOperatorKey(OPERATOR_A.slice(2));
    expect(bare.publicKey).toEqual(prefixed.publicKey);
  });

  it("refuses anything that is not 32 bytes, by width and never by value", () => {
    expect(() => escrowKeypairFromOperatorKey(`0x${"11".repeat(31)}`)).toThrow(/32 bytes/);
    expect(() => escrowKeypairFromOperatorKey("0xnot-hex")).toThrow(/32 bytes/);
    // The refusal must not quote the credential it refused.
    try {
      escrowKeypairFromOperatorKey(`0x${"ab".repeat(31)}`);
      expect.fail("a 31-byte operator key must be refused, by shape, before it is ever used");
    } catch (error) {
      // Pins what the message *is* — by shape, not by value — not only what
      // it omits.
      expect((error as Error).message).toBe(
        "an operator key is 32 bytes (64 hex characters), and this one is not",
      );
      expect((error as Error).message).not.toContain("ab");
    }
  });

  /**
   * Node's hex decoder stops at the first invalid character instead of
   * throwing, so `0x` + 64 valid hex chars + trailing garbage decodes to
   * exactly 32 bytes: a width check over the *decoded* buffer would miss this
   * and derive a key from a malformed credential. The refusal has to look at
   * the string's shape, not the buffer's length.
   */
  it("refuses trailing garbage after a valid-length hex prefix", () => {
    const trailingGarbage = `0x${"11".repeat(32)}zz`;
    expect(() => escrowKeypairFromOperatorKey(trailingGarbage)).toThrow(/32 bytes/);
  });

  it("accepts uppercase hex and derives the same key as its lowercase spelling", () => {
    const upper = `0x${"AB".repeat(32)}`;
    const lower = `0x${"ab".repeat(32)}`;
    expect(escrowKeypairFromOperatorKey(upper).publicKey).toEqual(
      escrowKeypairFromOperatorKey(lower).publicKey,
    );
  });

  it("derives a real recipient: a wrap sealed to the public half opens with the secret half", () => {
    const { publicKey, secretKey } = escrowKeypairFromOperatorKey(OPERATOR_A);
    const seed = Buffer.alloc(32, 7);
    const wrap = sealDek(seed, publicKey);
    expect(openDek(wrap, publicKey, secretKey)).toEqual(seed);
  });

  it("uses a label distinct from the DEK's, so two derivations cannot collide", () => {
    expect(ESCROW_KEY_HKDF_INFO).toBe("vorq-escrow-x25519-v1");
    expect(ESCROW_KEY_HKDF_INFO).not.toContain("vorq-dek");
  });
});

describe("StaticKeyManager", () => {
  it("derives one held key per supplied entry, current first", () => {
    const keys = new StaticKeyManager([OPERATOR_A, OPERATOR_B]);
    const held = keys.heldKeys();

    expect(held).toHaveLength(2);
    expect(held[0].publicKey.toString("hex")).toBe(DERIVED_A_PK);
    expect(held[1].publicKey.toString("hex")).toBe(DERIVED_B_PK);
  });

  it("advertises the first entry, and never null", () => {
    const keys = new StaticKeyManager([OPERATOR_A, OPERATOR_B]);
    const current = keys.current();

    expect(current).not.toBeNull();
    expect(current?.publicKey.toString("hex")).toBe(DERIVED_A_PK);
    // Stable across calls: there is no mint, so there is no window in which the
    // answer could change.
    expect(keys.current()?.publicKey).toEqual(current?.publicKey);
  });

  it("holds every key with no deadline: nothing here ever decays", () => {
    const keys = new StaticKeyManager([OPERATOR_A, OPERATOR_B]);
    for (const record of keys.heldKeys()) expect(record.decayAt).toBeNull();
  });

  it("collapses duplicate entries to one record, first occurrence winning", () => {
    // Two identical OPERATOR_KEY entries are already legal, and harmless. What
    // must not happen is two held records claiming the same identity.
    const keys = new StaticKeyManager([OPERATOR_A, OPERATOR_A, OPERATOR_B]);
    const held = keys.heldKeys();

    expect(held).toHaveLength(2);
    expect(held[0].publicKey.toString("hex")).toBe(DERIVED_A_PK);
    expect(held[1].publicKey.toString("hex")).toBe(DERIVED_B_PK);
  });

  it("opens a wrap sealed to a non-current entry", () => {
    // The point of the list: an older entry still opens what was sealed to it,
    // which is what makes a rotation a two-step cutover rather than a loss.
    const keys = new StaticKeyManager([OPERATOR_A, OPERATOR_B]);
    const second = escrowKeypairFromOperatorKey(OPERATOR_B);
    const seed = randomBytes(32);

    const unsealed = keys.tryUnseal(sealDek(seed, second.publicKey));

    expect(unsealed).not.toBeNull();
    expect(unsealed?.seed).toEqual(seed);
    expect(unsealed?.publicKey.toString("hex")).toBe(DERIVED_B_PK);
  });

  it("returns null for junk and for a wrap of the wrong width, never throwing", () => {
    // `/release` is an open door: a griefer's bytes must classify, never throw.
    const keys = new StaticKeyManager([OPERATOR_A]);

    expect(keys.tryUnseal(randomBytes(SEED_WRAP_BYTES))).toBeNull();
    expect(keys.tryUnseal(randomBytes(SEED_WRAP_BYTES - 1))).toBeNull();
    expect(keys.tryUnseal(Buffer.alloc(0))).toBeNull();
  });

  it("refuses an empty key list rather than advertising nothing", () => {
    // The loader refuses an empty OPERATOR_KEY at every mode that holds keys, so
    // reaching this is a wiring defect. It must break loudly.
    expect(() => new StaticKeyManager([])).toThrow(/at least one/i);
  });

  it("hands out live buffers, so the trial-open reads the real secret", () => {
    // `toEqual` only compares values, so it would pass identically if
    // `heldKeys()` returned a defensive copy each time. Identity is the
    // actual claim here, and it can only be checked across two reads of the
    // manager — `escrowKeypairFromOperatorKey` itself allocates a fresh
    // `Buffer` on every call, so comparing against a freshly derived key
    // would be equal in value but never `===`, even when the manager is
    // genuinely handing out its own live buffer.
    const keys = new StaticKeyManager([OPERATOR_A]);
    expect(keys.heldKeys()[0].secretKey).toBe(keys.heldKeys()[0].secretKey);
  });
});
