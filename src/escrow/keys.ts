import sodium from "sodium-native";
// Type-only, and it stays that way: this module holds the process's secrets and
// imports no chain client. `SlaFacts` is two functions returning numbers, so the
// boot assertion below can read the chain without this file knowing what a chain
// is. The import is erased at compile time.
import type { SlaFacts } from "../chain/client.js";
import { SEED_WRAP_BYTES } from "../container.js";
import {
  ESCROW_KEY_RETENTION_MS,
  ESCROW_SWEEP_INTERVAL_MS,
  KEY_CACHE_TTL_MS,
  MAX_EXPIRY_MS,
  MAX_SLA_MS,
} from "./windows.js";
import {
  ESCROW_PUBLIC_KEY_BYTES,
  ESCROW_SECRET_KEY_BYTES,
  newRecipientKeypair,
  openDek,
} from "./container.js";

/**
 * Escrow key generations — minted in memory, held for a bounded window, erased.
 *
 * Nothing here touches disk, Postgres or the chain. The premise of *this
 * module's* generations is that a DEK is recoverable only by a live process
 * holding a key that exists nowhere else, so persistence would not be an
 * optimisation, it would be the thing this module exists to avoid. The cost of
 * that premise is the decay rule below, and the cost of the decay rule is the
 * inequality {@link soundness} enforces. `static-keys.ts` derives instead.
 *
 * ## Retention is 72 h, and it is not a decay window (P3)
 *
 * The plan called this a `DECAY_WINDOW` of 48 h, derived from
 * `KEY_CACHE_TTL + MAX_EXPIRY < DECAY_WINDOW` → `3 h + 24 h < 48 h`. **That
 * inequality is missing a term and the constant it produced is unsound.** A key
 * has to outlive every order that could still name it, and an order's life does
 * not end at expiry: a provider claims inside the expiry window and then has the
 * SLA to deliver. The real worst case is
 *
 * ```
 * grace (KEY_CACHE_TTL, 3 h) + MAX_EXPIRY (24 h) + maxSla (24 h) = 51 h
 * ```
 *
 * which is *past* 48 h. At the plan's constant a swept key can back a live
 * claimed order: the provider delivers, the job settles, and the DEK the client
 * needs is gone — with `/release` reporting a miss that looks like a junk wrap.
 *
 * So the constant is **72 h**, and the margin over 51 h is deliberate rather
 * than rounding. `allowedSla` is curation-mutable: a value derived to sit
 * exactly at the bound would go silently unsound the first time curation allows
 * a longer SLA, with no code change anywhere to notice. 72 h absorbs the SLA
 * doubling to 48 h, and {@link soundness} refuses to start past that — because a
 * comment asserting soundness is not soundness. The name follows the meaning:
 * this is how long a key is **retained**, and "decay window" is dead.
 *
 * ## A generation's identity is its public key
 *
 * Not an ordinal. Two instances that exchange keys each minted their own
 * "generation 1", so a numeric identity collides on the first handover and the
 * collision resolves by silently dropping one instance's key. Adoption dedupes
 * by public key and {@link KeyManager.tryUnseal} reports the public key that
 * matched. The ordinal on each record exists for logs and nothing reads it to
 * make a decision.
 */

/** One hour, so the windows below read as the durations they are. */
const HOUR_MS = 3_600_000;

/**
 * The five windows, re-exported from {@link ./windows.js} where they are
 * written.
 *
 * They moved so that `src/config.ts` could read `ESCROW_SWEEP_INTERVAL_MS`
 * without pulling `sodium-native` in behind it, and they are re-exported here
 * because this module is where the inequality that ties them lives — the header
 * above argues about these numbers, and a reader who follows the argument here
 * must be able to import them here.
 */
export {
  ESCROW_KEY_RETENTION_MS,
  ESCROW_SWEEP_INTERVAL_MS,
  KEY_CACHE_TTL_MS,
  MAX_EXPIRY_MS,
  MAX_SLA_MS,
};

/** The soundness inequality does not hold for the windows it was given. */
export class SoundnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoundnessError";
  }
}

const assertWindow = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new SoundnessError(`${name} must be a finite non-negative number of ms, not ${value}`);
  }
};

/**
 * Throws unless a retained key outlives every order that could still name it.
 *
 * ```
 * grace + maxExpiry + maxSla < retention
 * ```
 *
 * **A pure function of four arguments, on purpose** (P12). A no-argument version
 * could only re-assert the constants this file already ships — it would pass by
 * construction, and the "a violating tuple throws" test would be untestable. The
 * arguments are what let Task 3 call it with the values it read off the chain
 * (`MAX_EXPIRY`, the largest allowed SLA) and refuse to boot when curation has
 * moved past this node's retention. All four are milliseconds.
 *
 * The comparison is strict. Retention *equal* to the worst case erases a key in
 * the same instant an order may still legitimately name it, which is the failure
 * and not the boundary of it.
 */
export function soundness(
  graceMs: number,
  maxExpiryMs: number,
  maxSlaMs: number,
  retentionMs: number,
): void {
  assertWindow("the client cache grace", graceMs);
  assertWindow("MAX_EXPIRY", maxExpiryMs);
  assertWindow("the maximum allowed SLA", maxSlaMs);
  assertWindow("the key retention window", retentionMs);

  const worstCase = graceMs + maxExpiryMs + maxSlaMs;
  if (worstCase >= retentionMs) {
    const h = (ms: number) => (ms / HOUR_MS).toFixed(2);
    throw new SoundnessError(
      `escrow keys would be erased while a live order could still name them: a client may cache ` +
        `this node's key for ${h(graceMs)} h, post an order that stays valid for a further ` +
        `${h(maxExpiryMs)} h, and a provider that claims it has ${h(maxSlaMs)} h to deliver — ` +
        `${h(worstCase)} h in the worst case, against a retention of only ${h(retentionMs)} h. ` +
        `A settled job would find its DEK gone.`,
    );
  }
}

/**
 * The largest SLA this retention window can tolerate, in **seconds**, exclusive.
 *
 * Rearranged straight out of {@link soundness}: `sla < retention − grace −
 * maxExpiry`. Any allowed SLA at or above this value is a configuration in which
 * a key can be erased while an order that names it is still live.
 */
const slaCeilingSeconds = (maxExpirySeconds: number): number =>
  (ESCROW_KEY_RETENTION_MS - KEY_CACHE_TTL_MS) / 1000 - maxExpirySeconds;

/** `allowedSla` is keyed by `uint32`; nothing above this can be set at all. */
const UINT32_MAX = 4_294_967_295;

/** Whole days a governance transaction plausibly carries. See {@link slaProbes}. */
const LADDER_DAYS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30, 60, 90, 180, 365] as const;

/** The last whole hour the hourly half of the ladder probes: one week. */
const LADDER_LAST_HOUR = 168;

/**
 * The SLA values this node asks the chain about at boot — every one of them a
 * value retention could **not** tolerate.
 *
 * `allowedSla` is a `mapping(uint32 => bool)` and Solidity mappings are not
 * enumerable, so "the maximum allowed SLA" is not a question the chain can be
 * asked. It can only be probed. The ladder is therefore explicit about what it
 * covers: the ceiling itself, **every whole hour from there to one week**, and
 * the whole days a human writing a governance transaction would actually type,
 * up to a year, plus the `uint32` ceiling. Around 140 reads, issued
 * concurrently, once per boot.
 *
 * The hourly half used to stop 24 hours past the ceiling, which the doc comment
 * called "a day past it" and which was in fact one hour short of that (S6). More
 * to the point, it left a 27-hour-wide band of whole hours — 69 h to 95 h, with
 * only 72 h covered by the day ladder — in which curation could set
 * `allowedSla[262800]` (73 h), boot this node cleanly, and leave a true worst
 * case of `3 + 24 + 73 = 100 h` against a 72 h retention. That is a key erased
 * under a live claimed order, which is the exact failure P3 exists to prevent.
 * A week of whole hours costs about a hundred extra `eth_call`s once, at boot.
 */
export function slaProbes(maxExpirySeconds: number): number[] {
  const ceiling = slaCeilingSeconds(maxExpirySeconds);
  const probes = new Set<number>([Math.ceil(ceiling), UINT32_MAX]);

  const firstHour = Math.ceil(ceiling / 3600);
  for (let hour = firstHour; hour <= LADDER_LAST_HOUR; hour += 1) probes.add(hour * 3600);
  for (const day of LADDER_DAYS) probes.add(day * 86_400);

  return [...probes]
    .filter((secs) => secs >= ceiling && secs >= 0 && secs <= UINT32_MAX)
    .sort((a, b) => a - b);
}

/**
 * Refuses to let this node boot unless its retention window is sound **against
 * the chain as it stands** (P3).
 *
 * Two checks, and they cover different halves of the risk:
 *
 *  1. `MAX_EXPIRY` is read from `JobRegistry` and fed to {@link soundness} with
 *     this node's own SLA ceiling. This half is complete: it is exactly the
 *     inequality, over the one term the plan omitted, with the live value rather
 *     than a constant that could drift from the deployed contract.
 *  2. The chain is asked whether it currently allows any SLA this retention
 *     cannot cover ({@link slaProbes}). This half is a probe, and it is worth
 *     being precise about its limits.
 *
 * **What this check can see:** a `MAX_EXPIRY` that has grown past what retention
 * covers; a curation-allowed SLA at or above the ceiling at any of the probed
 * values, at the instant of boot.
 *
 * **What it cannot see:** an allowed SLA that falls *between* the probes. Every
 * whole hour from the ceiling to one week is covered and every whole day from
 * there to a year, so what is left is a sub-hour value inside the first week
 * (say 46 h 30 m) or an odd number of hours past it (say 200 h) — and, more
 * importantly, **any `setSlaAllowed` that lands after this node booted**.
 * `allowedSla` is curation-mutable and not enumerable, so no boot check can
 * enumerate it and no boot check can be re-run by the chain. Curation raising
 * the allowed SLA past this node's retention is a governance event, and the
 * defence against it is the 21 h of deliberate margin in
 * {@link ESCROW_KEY_RETENTION_MS} plus an operator restarting nodes after a
 * governance change — not this function. Saying so here is the point: a check
 * that overstated its reach would be the same failure as the comment it
 * replaced.
 */
export async function assertEscrowSoundness(facts: SlaFacts): Promise<void> {
  const maxExpirySeconds = await facts.maxExpirySeconds();
  if (!Number.isSafeInteger(maxExpirySeconds) || maxExpirySeconds < 0) {
    throw new SoundnessError(
      `JobRegistry.MAX_EXPIRY read as ${maxExpirySeconds}, which is not a number of seconds`,
    );
  }

  // The complete half: this node's own ceiling against the chain's expiry.
  soundness(KEY_CACHE_TTL_MS, maxExpirySeconds * 1000, MAX_SLA_MS, ESCROW_KEY_RETENTION_MS);

  const probes = slaProbes(maxExpirySeconds);
  const answers = await Promise.all(
    probes.map(async (secs) => [secs, await facts.slaAllowed(secs)] as const),
  );
  const allowed = answers.filter(([, ok]) => ok).map(([secs]) => secs);
  if (allowed.length === 0) return;

  const ceiling = slaCeilingSeconds(maxExpirySeconds);
  throw new SoundnessError(
    `the chain allows an SLA this node's escrow retention cannot cover: allowedSla is true for ` +
      `${allowed.join(", ")} s, and with MAX_EXPIRY at ${maxExpirySeconds} s and a client cache ` +
      `grace of ${KEY_CACHE_TTL_MS / 1000} s, a retention of ${ESCROW_KEY_RETENTION_MS / 1000} s ` +
      `covers an SLA below ${ceiling} s only. An order posted at the last instant of a cached ` +
      `key's life could still be delivering when that key is erased, and its DEK would be gone. ` +
      `Raise ESCROW_KEY_RETENTION_MS or have curation withdraw the SLA.`,
  );
}

/** A generation, named the only way it can be named across instances. */
export interface Generation {
  publicKey: Buffer;
  /** Per-instance ordinal. **Logging only** — never an identity and never compared. */
  generation: number;
}

/**
 * A held generation, key material and all.
 *
 * `decayAt: null` means **current**: the one generation this node advertises,
 * and the one the sweep never touches. Every other held key carries a
 * deadline — under a minting manager. `StaticKeyManager` stamps `null` on
 * every record, so do not infer "at most one null" from this type.
 */
export interface HeldKey extends Generation {
  secretKey: Buffer;
  decayAt: number | null;
}

/**
 * A generation arriving from a peer or a predecessor.
 *
 * `decayAt` is **required and non-null**, which is the enforceable half of P11.
 * The holder stamps deadlines before serialising; a `null` arriving here would
 * mean "current, never swept", and adopting one creates a key that accumulates
 * across every upgrade and is erased by nothing. Refusing it is cheaper than a
 * convention nobody can check.
 */
export interface AdoptableKey {
  publicKey: Buffer;
  secretKey: Buffer;
  decayAt: number;
}

/**
 * What a successful trial-unseal recovered, and which key recovered it.
 *
 * **The field is `seed`, not `dek`, and the rename is the point** (P4c). Under
 * P4b the sealed-box plaintext is a 32-byte *seed*; the working key is
 * `HKDF-SHA256(seed, info = "vorq-dek" ‖ owner)`, derived in
 * `src/escrow/release.ts` from the job's **chain-read** owner. A field called
 * `dek` on a security boundary told every reader the bytes were already the key,
 * which is precisely the mistake that would reopen the wrap-lifting attack in a
 * second implementation.
 */
export interface Unsealed {
  seed: Buffer;
  /** The generation that opened it, by the identity that survives a handover. */
  publicKey: Buffer;
  /** Its ordinal on *this* instance. For the log line, not for the caller's logic. */
  generation: number;
}

const idOf = (publicKey: Buffer): string => publicKey.toString("hex");

/**
 * What the two **open** escrow doors need from a key set, and nothing more.
 *
 * `GET /key` calls {@link EscrowKeys.current} and `/release` calls
 * {@link EscrowKeys.tryUnseal}; nothing else on either path touches a manager.
 * That is why this is two methods rather than the manager's whole surface —
 * `heldKeys`, `now` and `adoptKeys` are handover's, and `mint` and `sweep` are
 * the lifecycle timers'. Keeping them off here is what lets `main.ts` narrow to
 * a {@link KeyManager} before wiring a timer: a lifecycle wired to a key set
 * that has none does not compile.
 */
export interface EscrowKeys {
  current(): Generation | null;
  tryUnseal(wrap: Buffer): Unsealed | null;
}

/**
 * Trial-unseals a wrap across a held set, in the order given.
 *
 * O(number of held keys), which is a handful. There is nothing in the wrap that
 * names its recipient — a sealed box is anonymous, which is the property that
 * keeps a posted container from advertising which key opens it — so trying each
 * is the only way, and it is why a held set has to stay small.
 *
 * Returns `null` for anything that does not open, including junk: `/release` is
 * an open door and a griefer's bytes must classify, never throw. The caller
 * decides what a miss means (`unseal_failed` / `escrow_key_lost`).
 *
 * **A free function, so there is one of it.** Both managers hold key material
 * the same way and miss the same way; a second copy is how the two would
 * eventually disagree about what a miss is, on the one door where that
 * disagreement is a wrong answer to a provider rather than a crash.
 */
export function tryUnsealAcross(held: readonly HeldKey[], wrap: Buffer): Unsealed | null {
  if (wrap.length !== SEED_WRAP_BYTES) return null;
  for (const record of held) {
    try {
      const seed = openDek(wrap, record.publicKey, record.secretKey);
      return { seed, publicKey: record.publicKey, generation: record.generation };
    } catch {
      // A miss, which is the expected outcome for all but one held key.
    }
  }
  return null;
}

/**
 * The generations this process holds, and the only place their secrets exist.
 *
 * The clock is injected because time is the subject: a 72 h retention is not
 * testable against `Date.now`, and a test that slept would measure the
 * scheduler.
 */
export class KeyManager implements EscrowKeys {
  readonly #lifecycleClock: () => number;
  readonly #wallClock: () => number;
  /** Keyed by public key hex — the identity that survives crossing instances. */
  readonly #held = new Map<string, HeldKey>();
  #currentId: string | null = null;
  #nextOrdinal = 1;

  /**
   * @param lifecycleClock the **key-lifecycle** clock: what stamps deadlines and what the
   *   sweep compares against. `main.ts` hands it `Date.now` plus
   *   `ESCROW_CLOCK_OFFSET_MS`, which is 0 in every deployment the config
   *   loader permits outside `mode: "mock"` (P22).
   * @param wallClock real time, used for **one** thing: the floor
   *   {@link adoptKeys} puts under a peer-supplied deadline (S2). It defaults to
   *   `lifecycleClock`, and passing anything else is what the mock offset is *for*.
   *
   *   The two are the same function in every real deployment, and separating
   *   them is not the split-clock mistake it resembles. The offset knob exists so
   *   that 73 h of key-lifecycle time can pass in a devnet scenario — its own boot
   *   warning says "retired generations are erased early". A floor measured on
   *   the *offset* clock moves forward by exactly as much as the sweep does, so
   *   it cancels the knob and no adopted generation can ever be observed decaying
   *   at all. Measured: `test/devnet/escrow-decay.test.ts` timed out waiting for
   *   an erasure that could no longer happen. The floor is a promise about how
   *   long this node will keep a key it just took on, and that promise is made in
   *   real time.
   *
   *   Both ends are pinned: `floors on real time, so the mock clock offset still
   *   erases what it adopts` holds the wall clock under {@link adoptKeys}, and
   *   `stamps its OWN retirement on the key-lifecycle clock, not on real time`
   *   holds the lifecycle clock under {@link retireCurrent}. Swapping either one
   *   for the other used to leave the whole unit suite green.
   */
  constructor(
    lifecycleClock: () => number = Date.now,
    wallClock: () => number = lifecycleClock,
  ) {
    this.#lifecycleClock = lifecycleClock;
    this.#wallClock = wallClock;
  }

  /**
   * Brings the manager up, minting the current generation unless told not to.
   *
   * `{ mint: false }` is not a convenience. The handover **join** flow adopts a
   * predecessor's generations and mints afterwards; a boot that always minted
   * would leave an orphan generation advertised for the moments before the join,
   * and any order posted against it names a key the successor never records as
   * current. The caller that defers is the caller that calls {@link mint}.
   */
  boot(options: { mint?: boolean } = {}): Generation | null {
    return options.mint === false ? null : this.mint();
  }

  /**
   * Mints a fresh generation and makes it current.
   *
   * The outgoing current generation **retires** rather than lingering: two keys
   * with `decayAt: null` would both be un-sweepable, which is the leak P11 is
   * about, arrived at from the local side instead of the handover side.
   */
  mint(): Generation {
    this.retireCurrent();

    const { publicKey, secretKey } = newRecipientKeypair();
    const record: HeldKey = {
      publicKey,
      secretKey,
      generation: this.#nextOrdinal++,
      decayAt: null,
    };
    const id = idOf(publicKey);
    this.#held.set(id, record);
    this.#currentId = id;
    return { publicKey, generation: record.generation };
  }

  /** The generation this node advertises, or `null` when the mint was deferred. */
  current(): Generation | null {
    const record = this.#currentId === null ? undefined : this.#held.get(this.#currentId);
    return record === undefined
      ? null
      : { publicKey: record.publicKey, generation: record.generation };
  }

  /**
   * Every held generation, current first.
   *
   * The records are fresh objects — a caller cannot rewrite a deadline through
   * this — but the **buffers are live**, deliberately. Handover serialises key
   * material out of here, and copying every secret on every call would scatter
   * copies across the heap that {@link sweep} will never reach. Erasure that
   * only erases one of several copies is not erasure.
   */
  heldKeys(): HeldKey[] {
    const records = [...this.#held.values()];
    records.sort((a, b) => Number(b.decayAt === null) - Number(a.decayAt === null));
    return records.map((record) => ({ ...record }));
  }

  /**
   * Retires the current generation: stamps `clock() + ESCROW_KEY_RETENTION_MS`
   * and keeps holding it, so orders already posted against it still release.
   *
   * **No argument** — the plan's `retireCurrentInto(deadline)` never read its
   * parameter (M1), and a deadline a caller could choose is a deadline a caller
   * could push past the soundness bound. An earlier deadline already on the
   * record wins, which makes this idempotent, and with no current generation it
   * does nothing at all.
   */
  retireCurrent(): void {
    if (this.#currentId === null) return;
    const record = this.#held.get(this.#currentId);
    this.#currentId = null;
    if (record === undefined) return;
    const deadline = this.#lifecycleClock() + ESCROW_KEY_RETENTION_MS;
    record.decayAt = Math.min(record.decayAt ?? Number.POSITIVE_INFINITY, deadline);
  }

  /**
   * Takes on a peer's or predecessor's generations, each with its deadline.
   *
   * **A peer may extend a key's life here; it may never shorten it** (S2). The
   * incoming `decayAt` is peer-supplied and therefore attacker-supplied — the
   * design already concedes the peer link is MITM-able — and the earlier version
   * of this method took `min(local, peer's)`, so a hostile or clock-lagging peer
   * could stamp `decayAt: 1` on a *retained* generation and have this node erase,
   * on its next sweep, the key backing a live claimed order. That is not a
   * confidentiality loss, which is the only consequence the threat model
   * described: it destroys a DEK a settled job still needs. The rule is therefore
   * directional:
   *
   *   * a key **this node already holds keeps its local deadline**, whatever the
   *     peer says — including `null`, which means "current, never swept";
   *   * a **newly** adopted key is floored at {@link ESCROW_KEY_RETENTION_MS} from
   *     now, so it survives at least the window boot proved sound
   *     ({@link assertEscrowSoundness}), and capped at twice that, so a peer
   *     cannot pin key material in this process for ever either.
   *
   * Idempotence — which replica sync depends on, calling this every tick — is
   * preserved and in fact strengthened: re-adopting a key changes **nothing**, in
   * either direction, so retention cannot drift and a lagging replica cannot
   * extend what it re-announces. The floor is the only place a peer's number is
   * allowed to lose, and it loses to *this* node's own window.
   *
   * An adopted key is never current. The current generation is the one this
   * instance minted and advertises; a key arriving from elsewhere is history.
   */
  adoptKeys(keys: readonly AdoptableKey[]): void {
    // Sampled once so a batch adopts coherently, and from **this node's** clock
    // — the peer's is exactly the input this method refuses to trust. Real time
    // rather than the key-lifecycle clock: see the constructor.
    const floor = this.#wallClock() + ESCROW_KEY_RETENTION_MS;
    const ceiling = floor + ESCROW_KEY_RETENTION_MS;

    for (const key of keys) {
      if (typeof key.decayAt !== "number" || !Number.isFinite(key.decayAt)) {
        throw new SoundnessError(
          "an adopted escrow key must arrive with a deadline: a null decayAt means 'current, " +
            "never swept', so adopting one creates a key that accumulates on every handover and " +
            "is erased by nothing. The holder stamps deadlines before it serialises (P11).",
        );
      }
      if (
        key.publicKey.length !== ESCROW_PUBLIC_KEY_BYTES ||
        key.secretKey.length !== ESCROW_SECRET_KEY_BYTES
      ) {
        throw new SoundnessError(
          `an escrow key is a ${ESCROW_PUBLIC_KEY_BYTES}-byte public key and a ` +
            `${ESCROW_SECRET_KEY_BYTES}-byte secret key, and this one is ` +
            `${key.publicKey.length}/${key.secretKey.length}`,
        );
      }

      const id = idOf(key.publicKey);
      const existing = this.#held.get(id);
      if (existing !== undefined) {
        if (this.#currentId === id) {
          // A peer offering back the generation this node is minting under is
          // not a shape the protocol produces — the joiner filters its own
          // current key out before it gets here — and it is the shape that would
          // let a peer take this node off the air: accepting a deadline would
          // clear the current pointer and `GET /key` would answer
          // `escrow_key_unminted` for ever. Refuse loudly instead of moving
          // state on a peer's say-so.
          throw new SoundnessError(
            "a peer offered back the generation this node is currently minting under. A key " +
              "cannot be both the advertised current generation and scheduled for erasure, and " +
              "no peer decides which of those this node's own key is.",
          );
        }
        // The local deadline stands. Re-adoption is a no-op, which is what makes
        // replica sync idempotent, and it is also what stops a peer reaching
        // into a retention window this node already committed to.
        continue;
      }

      // Copied in: the adopted material becomes this instance's to erase, and a
      // buffer still owned by the sender must not be zeroed by our sweep.
      this.#held.set(id, {
        publicKey: Buffer.from(key.publicKey),
        secretKey: Buffer.from(key.secretKey),
        generation: this.#nextOrdinal++,
        decayAt: Math.min(Math.max(key.decayAt, floor), ceiling),
      });
    }
  }

  /**
   * This node's **key-lifecycle** clock, in milliseconds.
   *
   * Exposed for one caller: `handover.ts`'s replica projection, which stamps a
   * deadline on the copy of a still-current generation crossing the wire. That
   * is a key-lifecycle deadline, so it has to be measured on the clock the sweep
   * compares against — the route's `nowMs` is real time and the two are the same
   * number only while the mock offset is 0 (S8). Nothing else should need it:
   * `/release`'s `issued_at` bound is a statement about the caller's clock, not
   * about key material, and it stays on real time (P22).
   */
  now(): number {
    return this.#lifecycleClock();
  }

  /**
   * Erases every generation past its deadline. Returns how many went.
   *
   * `sodium_memzero` rather than `fill(0)`: the point is that the bytes are gone
   * from this process, and a plain overwrite of a buffer nothing reads again is
   * exactly the store an optimiser is entitled to drop. The current generation
   * carries no deadline and is never swept.
   */
  sweep(): number {
    const now = this.#lifecycleClock();
    let erased = 0;
    for (const [id, record] of this.#held) {
      if (record.decayAt === null || record.decayAt > now) continue;
      sodium.sodium_memzero(record.secretKey);
      this.#held.delete(id);
      erased += 1;
    }
    return erased;
  }

  /**
   * Trial-unseals a wrap across every held generation.
   *
   * The loop itself is {@link tryUnsealAcross}, shared with the static manager
   * so both agree on what a miss is. This supplies the order: current first.
   *
   * Returns `null` for anything that does not open, including junk: `/release`
   * is an open door and a griefer's bytes must classify, never throw. The caller
   * decides what a miss means (Task 4's `unseal_failed` / `escrow_key_lost`).
   */
  tryUnseal(wrap: Buffer): Unsealed | null {
    return tryUnsealAcross(this.heldKeys(), wrap);
  }
}
