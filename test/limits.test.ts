import { describe, expect, it } from "vitest";

import {
  ENVELOPE_RESERVE_BYTES,
  INLINE_MAX_BYTES,
  MAX_BODY_BYTES,
  base64Length,
} from "../src/api/limits.js";

/**
 * One ceiling, and the inline rule derived from it.
 *
 * The inline threshold used to be a second number, hand-set to 7 MiB in four
 * repos with nothing holding them together — the review that prompted this
 * found that editing one of them left every suite green. It is arithmetic, not
 * policy: base64 is what stops a caller inlining a whole body's worth of bytes,
 * so the body cap is the only thing anyone sets.
 */
describe("body limits", () => {
  it("never derives a threshold the body could not hold", () => {
    // The invariant that has to hold for *any* ceiling, which is what makes the
    // derivation safe rather than merely correct for today's numbers:
    // 4·ceil(floor(R/4)·3/3) = 4·floor(R/4) ≤ R.
    expect(base64Length(INLINE_MAX_BYTES) + ENVELOPE_RESERVE_BYTES).toBeLessThanOrEqual(
      MAX_BODY_BYTES,
    );
  });

  it("fills the body exactly at the current ceiling", () => {
    // The tighter property, true whenever the room left over divides by 4 — as
    // any MiB-multiple ceiling less a 64 KiB reserve does. Separated from the
    // invariant above so that choosing an awkward ceiling one day fails *this*
    // test, which is a note about slack, rather than the one that would mean
    // the derivation had become unsafe.
    expect(base64Length(INLINE_MAX_BYTES) + ENVELOPE_RESERVE_BYTES).toBe(MAX_BODY_BYTES);
  });

  it("leaves a container one byte over the threshold unable to fit", () => {
    expect(base64Length(INLINE_MAX_BYTES + 1) + ENVELOPE_RESERVE_BYTES).toBeGreaterThan(
      MAX_BODY_BYTES,
    );
  });

  it("pins the ceiling and what it derives", () => {
    // Spelled out so a change to either is a change to this line. The SDKs and
    // the daemon derive the same two numbers from the same formula; the
    // cross-language fixture holds them to it.
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024);
    expect(INLINE_MAX_BYTES).toBe(15_679_488);
  });

  it("reserves room the envelope cannot plausibly exceed", () => {
    // The order, the payment and a 65-byte signature come to well under a KiB.
    // 64 KiB is the reserve because being wrong here means refusing a payload
    // the client believed was inlineable, which is the one failure the shared
    // derivation exists to make impossible.
    expect(ENVELOPE_RESERVE_BYTES).toBe(64 * 1024);
  });

  it("counts base64 the way the encoder does", () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    for (const n of [1, 2, 3, 61, 1024, 7 * 1024 * 1024]) {
      expect(base64Length(n)).toBe(Buffer.alloc(n).toString("base64").length);
    }
  });
});
