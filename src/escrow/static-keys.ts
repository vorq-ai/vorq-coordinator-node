import { escrowKeypairFromOperatorKey } from "./container.js";
import { tryUnsealAcross, type EscrowKeys, type Generation, type HeldKey, type Unsealed } from "./keys.js";

/**
 * The escrow key set of a node at `ESCROW_MODE=static`: derived from
 * `OPERATOR_KEY`, held for the life of the process, and never anything else.
 *
 * **Not a flag on `KeyManager`.** That file is one sustained argument about the
 * inequality `grace + maxExpiry + maxSla < retention`, and every method in it is
 * a step in it. A mode branch inside `mint`, `retireCurrent`, `adoptKeys` and
 * `sweep` would give each of its stated invariants an exception that a reader
 * following the argument would not see. This class leaves that file alone.
 *
 * **There is no lifecycle here, and the missing methods are the statement.**
 * `mint`, `retireCurrent`, `adoptKeys`, `sweep` and `now` do not exist: there is
 * nothing to drive and no clock to read. A `sweep()` that returned 0 would be an
 * answer to a question that cannot be asked of this class, and `main.ts` narrows
 * to `KeyManager` before wiring a timer precisely so that the absence is a
 * compile error rather than a silent no-op.
 *
 * **Secrets are never zeroed here, and that is not an oversight.**
 * `KeyManager.sweep` calls `sodium_memzero` because erasure is the point of a
 * decaying generation. These keys are recomputable from this process's own
 * environment on the next boot, so zeroing one would destroy nothing an attacker
 * with process access could not derive again from `OPERATOR_KEY` — which is
 * sitting in the same process's environment.
 */
export class StaticKeyManager implements EscrowKeys {
  /** Keyed by public key hex — the same identity `KeyManager` keys on. */
  readonly #held = new Map<string, HeldKey>();

  /**
   * @param operatorKeys the `OPERATOR_KEY` list, in supplied order. **The first
   *   entry derives the current key**; every entry derives a key that still
   *   opens wraps sealed to it, which is what makes a rotation the same two-step
   *   cutover an operator already performs on this variable.
   *
   * Duplicate entries collapse, first occurrence winning: two identical entries
   * are already legal and harmless today, and deriving from both must not
   * produce two records claiming one identity.
   */
  constructor(operatorKeys: readonly string[]) {
    if (operatorKeys.length === 0) {
      // The loader refuses an empty OPERATOR_KEY at every mode that holds keys,
      // so reaching this is a wiring defect rather than a misconfiguration —
      // and a key set that advertised nothing would answer `escrow_key_unminted`
      // forever on a node whose keys are sitting in its environment.
      throw new Error(
        "a static escrow needs at least one OPERATOR_KEY entry to derive from, and the " +
          "loader should already have refused this configuration",
      );
    }

    for (const operatorKey of operatorKeys) {
      const { publicKey, secretKey } = escrowKeypairFromOperatorKey(operatorKey);
      const id = publicKey.toString("hex");
      if (this.#held.has(id)) continue;
      this.#held.set(id, {
        publicKey,
        secretKey,
        generation: this.#held.size + 1,
        // `null` means what it means in `KeyManager` — current, never swept —
        // and in this class every key carries it, because nothing decays.
        decayAt: null,
      });
    }
  }

  /**
   * The key this node advertises: the one derived from the first entry.
   *
   * Never `null` after construction. The constructor refuses an empty list, so
   * `GET /key` cannot answer `escrow_key_unminted` on a static node — there is
   * no join to wait for and no mint to defer.
   */
  current(): Generation | null {
    const [record] = this.#held.values();
    return record === undefined
      ? null
      : { publicKey: record.publicKey, generation: record.generation };
  }

  /**
   * Every derived key, current first — insertion order, which is supplied order.
   *
   * Fresh record objects with **live buffers**, the same contract
   * `KeyManager.heldKeys` documents, so one trial-open works over either.
   *
   * Deliberately not on {@link EscrowKeys}: this is read by the shared
   * trial-open, not by a door.
   */
  heldKeys(): HeldKey[] {
    return [...this.#held.values()].map((record) => ({ ...record }));
  }

  /** Trial-unseals across every derived key. The loop is shared; this is the order. */
  tryUnseal(wrap: Buffer): Unsealed | null {
    return tryUnsealAcross(this.heldKeys(), wrap);
  }
}
