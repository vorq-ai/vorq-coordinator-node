import { describe, expect, it } from "vitest";
import { DEK_BYTES, sealDek } from "../src/escrow/container.js";
import {
  ESCROW_KEY_RETENTION_MS,
  ESCROW_SWEEP_INTERVAL_MS,
  KEY_CACHE_TTL_MS,
  KeyManager,
  MAX_EXPIRY_MS,
  MAX_SLA_MS,
  SoundnessError,
  soundness,
} from "../src/escrow/keys.js";

/**
 * The escrow key manager: generations in memory, decay on a deadline, and the
 * one inequality that says a key may only be forgotten once no live order can
 * still name it.
 *
 * Everything here runs on an injected clock. Time is the subject of this module
 * — a retention window measured in days is not testable against `Date.now`, and
 * a test that slept would be testing the scheduler.
 */

const HOUR_MS = 3_600_000;

/** A clock the test drives by hand. */
const stopwatch = (start = 1_700_000_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const dek = (fill: number) => Buffer.alloc(DEK_BYTES, fill);
const hex = (b: Buffer) => b.toString("hex");

describe("the constants, and why retention is 72 h", () => {
  it("carries the SLA term the plan's inequality omitted (P3)", () => {
    // grace (3 h) + MAX_EXPIRY (24 h) + maxSla (24 h) = 51 h. The plan's 48 h
    // retention sits *below* that, so a decayed key could still back a live
    // claimed order. 72 h clears it with deliberate margin, because `allowedSla`
    // is curation-mutable and a constant derived to sit exactly at the bound
    // goes unsound the first time curation allows a longer SLA.
    expect(KEY_CACHE_TTL_MS).toBe(3 * HOUR_MS);
    expect(MAX_EXPIRY_MS).toBe(24 * HOUR_MS);
    expect(MAX_SLA_MS).toBe(24 * HOUR_MS);
    expect(ESCROW_KEY_RETENTION_MS).toBe(72 * HOUR_MS);
    expect(KEY_CACHE_TTL_MS + MAX_EXPIRY_MS + MAX_SLA_MS).toBe(51 * HOUR_MS);
  });

  it("sweeps often enough that a deadline is honoured promptly (P20)", () => {
    expect(ESCROW_SWEEP_INTERVAL_MS).toBeGreaterThan(0);
    expect(ESCROW_SWEEP_INTERVAL_MS).toBeLessThan(ESCROW_KEY_RETENTION_MS);
  });
});

describe("soundness — a pure predicate over four windows (P12)", () => {
  it("passes for the shipped constants", () => {
    expect(() =>
      soundness(KEY_CACHE_TTL_MS, MAX_EXPIRY_MS, MAX_SLA_MS, ESCROW_KEY_RETENTION_MS),
    ).not.toThrow();
  });

  it("throws for the plan's own 48 h retention, which is the tuple P3 rejects", () => {
    expect(() => soundness(3 * HOUR_MS, 24 * HOUR_MS, 24 * HOUR_MS, 48 * HOUR_MS)).toThrow(
      SoundnessError,
    );
  });

  it("throws when curation widens the SLA past the margin", () => {
    // The live-values case Task 3 wires: nothing in this repo changed, the chain
    // did. A no-argument `soundness()` could not express this at all.
    expect(() =>
      soundness(KEY_CACHE_TTL_MS, MAX_EXPIRY_MS, 48 * HOUR_MS, ESCROW_KEY_RETENTION_MS),
    ).toThrow(SoundnessError);
  });

  it("throws at equality, not only past it", () => {
    // The bound is strict: retention equal to the worst case leaves a key
    // erased in the same instant an order may still name it.
    expect(() => soundness(1 * HOUR_MS, 1 * HOUR_MS, 1 * HOUR_MS, 3 * HOUR_MS)).toThrow(
      SoundnessError,
    );
    expect(() => soundness(1 * HOUR_MS, 1 * HOUR_MS, 1 * HOUR_MS, 3 * HOUR_MS + 1)).not.toThrow();
  });

  it("refuses a window that is not a finite non-negative number of milliseconds", () => {
    expect(() => soundness(-1, MAX_EXPIRY_MS, MAX_SLA_MS, ESCROW_KEY_RETENTION_MS)).toThrow();
    expect(() =>
      soundness(KEY_CACHE_TTL_MS, Number.NaN, MAX_SLA_MS, ESCROW_KEY_RETENTION_MS),
    ).toThrow();
  });
});

describe("boot and mint", () => {
  it("mints the current generation in memory", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const minted = keys.boot();

    expect(minted).not.toBeNull();
    expect(minted?.publicKey.length).toBe(32);
    expect(keys.current()?.publicKey.equals(minted!.publicKey)).toBe(true);

    const held = keys.heldKeys();
    expect(held.length).toBe(1);
    expect(held[0]!.decayAt).toBeNull();
    expect(held[0]!.secretKey.length).toBe(32);
  });

  it("defers the mint when asked, so a join can adopt first", () => {
    // The handover join flow adopts the holder's generations and mints after.
    // An unconditional mint at boot strands an orphan generation nobody has.
    const keys = new KeyManager(stopwatch().now);
    expect(keys.boot({ mint: false })).toBeNull();
    expect(keys.current()).toBeNull();
    expect(keys.heldKeys()).toEqual([]);

    const minted = keys.mint();
    expect(keys.current()?.publicKey.equals(minted.publicKey)).toBe(true);
    expect(keys.heldKeys().length).toBe(1);
  });

  it("mints a distinct key every time", () => {
    const keys = new KeyManager(stopwatch().now);
    const first = keys.mint();
    const second = keys.mint();
    expect(hex(first.publicKey)).not.toBe(hex(second.publicKey));
    // Minting supersedes: the previous current retires rather than lingering
    // as a second never-swept key.
    expect(keys.current()?.publicKey.equals(second.publicKey)).toBe(true);
    expect(keys.heldKeys().length).toBe(2);
    const superseded = keys.heldKeys().find((k) => k.publicKey.equals(first.publicKey));
    expect(superseded?.decayAt).not.toBeNull();
  });

  /**
   * **Rotation, and the property that makes it safe to run on a timer.**
   *
   * `main.ts` calls `mint()` every `ESCROW_ROTATE_INTERVAL_MS`. That is only
   * tolerable because rotation **retires and keeps** rather than replacing: every
   * wrap already sealed to the outgoing generation still opens for a full
   * retention window, and only its use for *new* work ends. A rotation that
   * erased would strand every open order in flight, once a day, silently.
   */
  it("rotation retires the outgoing generation and keeps it releasing", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const outgoing = keys.boot()!;
    const wrap = sealDek(dek(7), outgoing.publicKey);

    // Still openable before the rotation, obviously.
    expect(keys.tryUnseal(wrap)).not.toBeNull();

    const incoming = keys.mint();
    expect(keys.current()!.publicKey.equals(incoming.publicKey)).toBe(true);

    // The one that matters: the pre-rotation wrap still opens, and reports the
    // generation that actually matched rather than the current one.
    const opened = keys.tryUnseal(wrap);
    expect(opened).not.toBeNull();
    expect(opened!.publicKey.equals(outgoing.publicKey)).toBe(true);

    // It is retired, not erased: a deadline a full retention window out.
    const retired = keys.heldKeys().find((k) => k.publicKey.equals(outgoing.publicKey));
    expect(retired!.decayAt).toBe(clock.now() + ESCROW_KEY_RETENTION_MS);
  });

  /**
   * Rotation on a timer would otherwise grow the held set without bound — every
   * generation ever minted, trial-unsealed on every release. The sweep is what
   * bounds it, and the two are only in agreement because rotation stamps a real
   * deadline rather than a sentinel.
   */
  it("rotations erase in order once their deadlines pass", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const first = keys.boot()!;
    clock.advance(ESCROW_KEY_RETENTION_MS / 2);
    // Retirement stamps `now + retention`, so the first generation's deadline is
    // half a window *after* this rotation, not at the window from boot.
    const second = keys.mint();
    clock.advance(ESCROW_KEY_RETENTION_MS + 1);

    // The first generation's window has closed; the second is still current.
    expect(keys.sweep()).toBe(1);
    const held = keys.heldKeys();
    expect(held.some((k) => k.publicKey.equals(first.publicKey))).toBe(false);
    expect(held.some((k) => k.publicKey.equals(second.publicKey))).toBe(true);
    expect(keys.current()).not.toBeNull();
  });
});

describe("retireCurrent — no argument, because the plan's was dead (M1)", () => {
  it("stamps clock() + retention and keeps the key held", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const minted = keys.boot()!;
    const at = clock.now();

    keys.retireCurrent();

    expect(keys.current()).toBeNull();
    const held = keys.heldKeys();
    expect(held.length).toBe(1);
    expect(held[0]!.publicKey.equals(minted.publicKey)).toBe(true);
    expect(held[0]!.decayAt).toBe(at + ESCROW_KEY_RETENTION_MS);
  });

  it("leaves an already-retiring key on its earlier deadline", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const first = keys.boot()!;
    keys.retireCurrent();
    const stamped = keys.heldKeys()[0]!.decayAt;

    clock.advance(5 * HOUR_MS);
    keys.retireCurrent(); // no current key — nothing to stamp
    keys.mint();
    keys.retireCurrent(); // stamps the new one, must not push the old one out

    const older = keys.heldKeys().find((k) => k.publicKey.equals(first.publicKey));
    expect(older?.decayAt).toBe(stamped);
  });

  it("is a no-op when there is no current key", () => {
    const keys = new KeyManager(stopwatch().now);
    keys.boot({ mint: false });
    expect(() => keys.retireCurrent()).not.toThrow();
    expect(keys.heldKeys()).toEqual([]);
  });
});

describe("adoptKeys — identity is the public key, and a deadline is mandatory", () => {
  /** A generation minted by some other instance — the material, as it would arrive. */
  const foreign = () => {
    const other = new KeyManager(stopwatch().now);
    other.boot();
    const held = other.heldKeys()[0]!;
    return { publicKey: held.publicKey, secretKey: held.secretKey };
  };

  it("refuses a key with no deadline (P11 made enforceable)", () => {
    // `decayAt: null` means "current, never swept". Adopting one silently mints
    // a key that never decays, which is how keys accumulate on every upgrade.
    const keys = new KeyManager(stopwatch().now);
    keys.boot();
    const donor = foreign();

    expect(() =>
      keys.adoptKeys([
        { publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: null as never },
      ]),
    ).toThrow();
    expect(keys.heldKeys().length).toBe(1);
  });

  it("adopts with the deadline it was handed, when that deadline clears the floor", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    const donor = foreign();
    const deadline = clock.now() + ESCROW_KEY_RETENTION_MS + 10 * HOUR_MS;

    keys.adoptKeys([
      { publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: deadline },
    ]);

    const adopted = keys.heldKeys().find((k) => k.publicKey.equals(donor.publicKey));
    expect(adopted?.decayAt).toBe(deadline);
    // Adoption never makes a key current — the current key is the one this
    // instance minted.
    expect(keys.current()?.publicKey.equals(donor.publicKey)).toBe(false);
  });

  /**
   * **S2 — a peer may extend a key's life, never shorten it.**
   *
   * The deadline arrives over a link the design concedes is MITM-able, so it is
   * an attacker-controlled number. Under the previous `min(local, peer's)` rule,
   * `decayAt: 1` on a *retained* generation had this node erase, on its next
   * sweep, the key backing a live claimed order — `/release` then answers
   * `unseal_failed` and the client's data is gone. It does not even need an
   * attacker: a peer whose clock lags by 21 h silently shortens this node's
   * retention below the window `assertEscrowSoundness` proved at boot.
   *
   * The floor is `now + ESCROW_KEY_RETENTION_MS` — this node's own window, the
   * one the boot proof covers — because a key adopted at time T may back an
   * order posted against it right up to the moment it arrived.
   */
  it("floors an adopted deadline at this node's own retention window (S2)", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    const donor = foreign();

    // The hostile value: erase it on the next sweep.
    keys.adoptKeys([{ publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: 1 }]);

    const adopted = keys.heldKeys().find((k) => k.publicKey.equals(donor.publicKey));
    expect(adopted?.decayAt).toBe(clock.now() + ESCROW_KEY_RETENTION_MS);

    // And the consequence that matters: the key is still here to release with.
    expect(keys.sweep()).toBe(0);
    clock.advance(ESCROW_KEY_RETENTION_MS - 1);
    expect(keys.sweep()).toBe(0);
    expect(keys.heldKeys().some((k) => k.publicKey.equals(donor.publicKey))).toBe(true);

    // It is a floor, not a suspension of decay: past the window it goes.
    clock.advance(2);
    expect(keys.sweep()).toBe(1);
    expect(keys.heldKeys().some((k) => k.publicKey.equals(donor.publicKey))).toBe(false);
  });

  it("caps an adopted deadline, so a peer cannot pin key material for ever (S2)", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const donor = foreign();

    keys.adoptKeys([
      { publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: Number.MAX_SAFE_INTEGER },
    ]);
    expect(keys.heldKeys()[0]!.decayAt).toBe(clock.now() + 2 * ESCROW_KEY_RETENTION_MS);

    clock.advance(2 * ESCROW_KEY_RETENTION_MS + 1);
    expect(keys.sweep()).toBe(1);
    expect(keys.heldKeys()).toEqual([]);
  });

  it("refuses to let a peer retire the generation this node mints under (S2)", () => {
    // The joiner filters its own current key out before `adoptKeys` sees it, so
    // this is the second lock on the same door: accepting a deadline here would
    // clear the current pointer and take `GET /key` off the air permanently.
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const own = keys.boot()!;

    expect(() =>
      keys.adoptKeys([
        { publicKey: own.publicKey, secretKey: Buffer.alloc(32, 7), decayAt: 1 },
      ]),
    ).toThrow(SoundnessError);

    expect(keys.current()?.publicKey.equals(own.publicKey)).toBe(true);
    expect(keys.heldKeys()[0]!.decayAt).toBeNull();
  });

  it("dedupes by public key, not by any per-instance ordinal", () => {
    // Two instances each mint their own "generation 1", so a numeric ordinal
    // collides the moment they exchange keys. The stable global identity of a
    // key is the key.
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    const donor = foreign();
    const deadline = clock.now() + 10 * HOUR_MS;

    keys.adoptKeys([
      { publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: deadline },
    ]);
    keys.adoptKeys([
      { publicKey: donor.publicKey, secretKey: donor.secretKey, decayAt: deadline },
    ]);

    expect(keys.heldKeys().filter((k) => k.publicKey.equals(donor.publicKey)).length).toBe(1);
    expect(keys.heldKeys().length).toBe(2);
  });

  it("keeps the deadline it stamped, whatever a later sync says (S2)", () => {
    // Replica sync calls this repeatedly, so re-adoption must be a no-op — and
    // it must be a no-op in **both** directions. A later deadline winning would
    // let one lagging replica extend retention without bound; an earlier one
    // winning is the S2 attack, and it reaches every retained generation this
    // node holds, including the ones backing live claimed orders.
    const clock = stopwatch();
    const stamped = clock.now() + ESCROW_KEY_RETENTION_MS;
    const early = clock.now() + 4 * HOUR_MS;
    const late = clock.now() + 400 * HOUR_MS;

    const shortenedSecond = new KeyManager(clock.now);
    const a = foreign();
    shortenedSecond.adoptKeys([{ publicKey: a.publicKey, secretKey: a.secretKey, decayAt: stamped }]);
    shortenedSecond.adoptKeys([{ publicKey: a.publicKey, secretKey: a.secretKey, decayAt: early }]);
    expect(shortenedSecond.heldKeys()[0]!.decayAt).toBe(stamped);

    const extendedSecond = new KeyManager(clock.now);
    const b = foreign();
    extendedSecond.adoptKeys([{ publicKey: b.publicKey, secretKey: b.secretKey, decayAt: stamped }]);
    extendedSecond.adoptKeys([{ publicKey: b.publicKey, secretKey: b.secretKey, decayAt: late }]);
    expect(extendedSecond.heldKeys()[0]!.decayAt).toBe(stamped);

    // And the same holds when the clock has moved on between syncs: the second
    // adoption re-floors nothing, so retention cannot ratchet forward tick by
    // tick either.
    clock.advance(10 * HOUR_MS);
    extendedSecond.adoptKeys([{ publicKey: b.publicKey, secretKey: b.secretKey, decayAt: late }]);
    expect(extendedSecond.heldKeys()[0]!.decayAt).toBe(stamped);
  });

  /**
   * **The floor is measured on real time, not on the key-lifecycle clock.**
   *
   * The two are the same function everywhere the config loader allows an offset
   * of 0, which is every deployment outside `mode: "mock"` (P22). They separate
   * only under the mock offset, and they have to: that knob exists so 73 h of
   * retention can pass in a devnet scenario, and a floor that moved forward with
   * it would move by exactly as much as the sweep does, cancel the knob, and make
   * an adopted generation's decay unobservable. Measured — this is what took
   * `test/devnet/escrow-decay.test.ts` from green to a 60 s timeout when the
   * floor was first written against `this.#clock()`.
   */
  it("floors on real time, so the mock clock offset still erases what it adopts", () => {
    const wall = stopwatch();
    // The key-lifecycle clock, 73 h ahead: `ESCROW_CLOCK_OFFSET_MS`.
    const keyClock = () => wall.now() + ESCROW_KEY_RETENTION_MS + HOUR_MS;
    const keys = new KeyManager(keyClock, wall.now);
    const donor = foreign();

    // What a predecessor on a real clock stamps when it retires a generation.
    keys.adoptKeys([
      {
        publicKey: donor.publicKey,
        secretKey: donor.secretKey,
        decayAt: wall.now() + ESCROW_KEY_RETENTION_MS,
      },
    ]);

    // Floored to the same value — real time plus the window — and the sweep,
    // running an hour past it on the offset clock, erases it at once.
    expect(keys.heldKeys()[0]!.decayAt).toBe(wall.now() + ESCROW_KEY_RETENTION_MS);
    expect(keys.sweep()).toBe(1);
    expect(keys.heldKeys()).toEqual([]);
  });

  /**
   * The other half of the seam, and the half nothing was pinning.
   *
   * `adoptKeys` floors on **real** time (the test above). `retireCurrent` stamps
   * on the **key-lifecycle** clock, and it must: that clock is what `sweep`
   * compares against, so a retirement stamped on real time on a node running the
   * mock offset would sit 73 h behind the sweep and be erased on the very next
   * tick — a generation this node minted, gone the moment it stopped being
   * current, with every order still naming it. That is the opposite failure to
   * S2's and just as quiet.
   *
   * Swapping `#lifecycleClock` for `#wallClock` at that one line left the whole
   * unit suite green before this test existed.
   */
  it("stamps its OWN retirement on the key-lifecycle clock, not on real time", () => {
    const wall = stopwatch();
    // The key-lifecycle clock, 73 h ahead: `ESCROW_CLOCK_OFFSET_MS`.
    const keyClock = () => wall.now() + ESCROW_KEY_RETENTION_MS + HOUR_MS;
    const keys = new KeyManager(keyClock, wall.now);

    keys.boot();
    keys.mint(); // retires the booted generation and mints a fresh current

    const retired = keys.heldKeys().filter((k) => k.decayAt !== null);
    expect(retired).toHaveLength(1);
    expect(retired[0]!.decayAt).toBe(keyClock() + ESCROW_KEY_RETENTION_MS);
    // Not the real-time stamp, which the sweep — running on the offset clock —
    // would find already past and erase immediately.
    expect(retired[0]!.decayAt).not.toBe(wall.now() + ESCROW_KEY_RETENTION_MS);
    expect(keys.sweep()).toBe(0);
  });

  it("refuses a key whose material is the wrong width", () => {
    const keys = new KeyManager(stopwatch().now);
    const donor = foreign();
    expect(() =>
      keys.adoptKeys([
        {
          publicKey: donor.publicKey.subarray(0, 31),
          secretKey: donor.secretKey,
          decayAt: 1,
        },
      ]),
    ).toThrow();
  });
});

describe("tryUnseal — trial-unseal across held generations, reporting which key matched", () => {
  it("opens under the current key and names it by public key", () => {
    const keys = new KeyManager(stopwatch().now);
    const minted = keys.boot()!;
    const payload = dek(0x11);

    const hit = keys.tryUnseal(sealDek(payload, minted.publicKey));
    expect(hit).not.toBeNull();
    expect(hit!.seed.equals(payload)).toBe(true);
    expect(hit!.publicKey.equals(minted.publicKey)).toBe(true);
  });

  it("opens under an adopted generation, which is the point of holding several", () => {
    const clock = stopwatch();
    const holder = new KeyManager(clock.now);
    const holderKey = holder.boot()!;
    const payload = dek(0x22);
    const wrap = sealDek(payload, holderKey.publicKey);

    // P11: the holder stamps deadlines *before* serialising, and this asserts
    // the successor's view — the side the plan's own test never looked at.
    holder.retireCurrent();
    const successor = new KeyManager(clock.now);
    successor.boot();
    successor.adoptKeys(
      holder.heldKeys().map((k) => ({
        publicKey: k.publicKey,
        secretKey: k.secretKey,
        decayAt: k.decayAt as number,
      })),
    );

    const hit = successor.tryUnseal(wrap);
    expect(hit).not.toBeNull();
    expect(hit!.seed.equals(payload)).toBe(true);
    expect(hit!.publicKey.equals(holderKey.publicKey)).toBe(true);
  });

  it("returns null for a wrap no held key opens", () => {
    const keys = new KeyManager(stopwatch().now);
    keys.boot();
    const stranger = new KeyManager(stopwatch().now).boot()!;
    expect(keys.tryUnseal(sealDek(dek(0x33), stranger.publicKey))).toBeNull();
  });

  it("returns null for junk rather than throwing", () => {
    // `/release` is an open door: a griefer's wrap must classify, not crash.
    const keys = new KeyManager(stopwatch().now);
    keys.boot();
    expect(keys.tryUnseal(Buffer.alloc(80))).toBeNull();
    expect(keys.tryUnseal(Buffer.alloc(7))).toBeNull();
    expect(keys.tryUnseal(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when nothing is held at all", () => {
    const keys = new KeyManager(stopwatch().now);
    keys.boot({ mint: false });
    const stranger = new KeyManager(stopwatch().now).boot()!;
    expect(keys.tryUnseal(sealDek(dek(0x44), stranger.publicKey))).toBeNull();
  });
});

describe("sweep — erasure, and the exact generation it erases", () => {
  it("erases only the key past its deadline, and tryUnseal stops matching it", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const doomed = keys.boot()!;
    const doomedWrap = sealDek(dek(0x55), doomed.publicKey);
    keys.retireCurrent();

    clock.advance(1 * HOUR_MS);
    const survivor = keys.mint();
    const survivorWrap = sealDek(dek(0x66), survivor.publicKey);
    keys.retireCurrent();
    const survivorDeadline = keys.heldKeys().find((k) =>
      k.publicKey.equals(survivor.publicKey),
    )!.decayAt!;

    // Both still open, one hour in.
    expect(keys.tryUnseal(doomedWrap)).not.toBeNull();
    expect(keys.tryUnseal(survivorWrap)).not.toBeNull();

    // Park the clock exactly on the first deadline, an hour short of the second.
    clock.advance(ESCROW_KEY_RETENTION_MS - 1 * HOUR_MS);
    expect(clock.now()).toBeLessThan(survivorDeadline);

    expect(keys.sweep()).toBe(1);
    expect(keys.heldKeys().length).toBe(1);
    expect(keys.heldKeys()[0]!.publicKey.equals(survivor.publicKey)).toBe(true);
    expect(keys.tryUnseal(doomedWrap)).toBeNull();
    expect(keys.tryUnseal(survivorWrap)).not.toBeNull();
  });

  it("zeroes the secret buffer rather than only dropping the reference", () => {
    // The whole memory-only premise: after a sweep the bytes are gone from this
    // process, not merely unreachable through this object.
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    keys.retireCurrent();
    const secret = keys.heldKeys()[0]!.secretKey;
    expect(secret.equals(Buffer.alloc(32))).toBe(false);

    clock.advance(ESCROW_KEY_RETENTION_MS + 1);
    keys.sweep();

    expect(secret.equals(Buffer.alloc(32))).toBe(true);
  });

  it("never touches the current key, which carries no deadline", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    const minted = keys.boot()!;
    clock.advance(ESCROW_KEY_RETENTION_MS * 10);

    expect(keys.sweep()).toBe(0);
    expect(keys.current()?.publicKey.equals(minted.publicKey)).toBe(true);
    expect(keys.tryUnseal(sealDek(dek(0x77), minted.publicKey))).not.toBeNull();
  });

  it("erases exactly at the deadline, not a tick later", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    keys.retireCurrent();
    const deadline = keys.heldKeys()[0]!.decayAt!;

    clock.advance(deadline - clock.now() - 1);
    expect(keys.sweep()).toBe(0);
    clock.advance(1);
    expect(keys.sweep()).toBe(1);
    expect(keys.heldKeys()).toEqual([]);
  });

  it("is idempotent", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    keys.retireCurrent();
    clock.advance(ESCROW_KEY_RETENTION_MS + 1);
    expect(keys.sweep()).toBe(1);
    expect(keys.sweep()).toBe(0);
  });
});

describe("heldKeys — a structural snapshot over live key material", () => {
  it("gives records a caller cannot write back through", () => {
    const keys = new KeyManager(stopwatch().now);
    const minted = keys.boot()!;
    const snapshot = keys.heldKeys();
    snapshot[0]!.decayAt = 1;
    snapshot.pop();

    expect(keys.heldKeys().length).toBe(1);
    expect(keys.heldKeys()[0]!.decayAt).toBeNull();
    expect(keys.tryUnseal(sealDek(dek(0x88), minted.publicKey))).not.toBeNull();
  });

  it("hands out the live buffers, so a sweep erases what a caller still holds", () => {
    // Deliberate: handover serialises key material out of here, and copying
    // every secret on every call would scatter copies the sweep cannot reach.
    // Erasure that misses a copy is not erasure.
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    keys.retireCurrent();
    const escaped = keys.heldKeys()[0]!.secretKey;

    clock.advance(ESCROW_KEY_RETENTION_MS + 1);
    keys.sweep();

    expect(escaped.equals(Buffer.alloc(32))).toBe(true);
  });

  it("lists the current generation first", () => {
    const clock = stopwatch();
    const keys = new KeyManager(clock.now);
    keys.boot();
    keys.retireCurrent();
    const current = keys.mint();

    expect(keys.heldKeys()[0]!.publicKey.equals(current.publicKey)).toBe(true);
    expect(keys.heldKeys()[0]!.decayAt).toBeNull();
  });
});
