import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.js";
import { JOB_RATE_WINDOW_MS, jobLimiter } from "../src/api/rate-limit.js";

const WALLET = "0xAbCd000000000000000000000000000000000001";

describe("jobLimiter", () => {
  it("refuses the post past the limit, per wallet and per model", () => {
    const limiter = jobLimiter(2, () => 0);
    limiter.take(WALLET, 1n);
    limiter.take(WALLET.toLowerCase(), 1n);

    expect(() => limiter.take(WALLET, 1n)).toThrow(ApiError);
    expect(() => limiter.check(WALLET, 1n)).toThrow(/next slot opens at 1970-01-02T00:00:00.000Z/);
    // Another model, and another wallet, each have their own count.
    limiter.take(WALLET, 2n);
    limiter.take("0x0000000000000000000000000000000000000002", 1n);
  });

  it("opens a slot when the oldest post leaves the window", () => {
    let now = 0;
    const limiter = jobLimiter(1, () => now);
    limiter.take(WALLET, 1n);

    now = JOB_RATE_WINDOW_MS - 1;
    expect(() => limiter.take(WALLET, 1n)).toThrow(ApiError);
    now = JOB_RATE_WINDOW_MS;
    limiter.take(WALLET, 1n);
  });

  it("gives a released slot back, and check takes none", () => {
    const limiter = jobLimiter(1, () => 0);
    limiter.check(WALLET, 1n);
    limiter.check(WALLET, 1n);
    const release = limiter.take(WALLET, 1n);
    release();
    limiter.take(WALLET, 1n);
  });

  it("never refuses at 0", () => {
    const limiter = jobLimiter(0);
    for (let i = 0; i < 100; i++) limiter.take(WALLET, 1n);
    limiter.check(WALLET, 1n);
  });
});
