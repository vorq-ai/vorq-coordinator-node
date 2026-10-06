import { describe, expect, it } from "vitest";
import { relayerBalanceTick, startRelayerBalanceWatch } from "../src/keepers/relayer-balance.js";
import { stubChain, testConfig } from "./support/stub-chain.js";

/**
 * The relayer's gas wallet, reported while it is low.
 */
/** 0.05 ETH, as gwei and as wei. */
const FLOOR_GWEI = 50_000_000;
const FLOOR_WEI = 50_000_000n * 10n ** 9n;

describe("the relayer balance watch", () => {
  it("reports a balance under the floor", async () => {
    const stub = stubChain(testConfig(), { balance: FLOOR_WEI - 1n });
    expect(await relayerBalanceTick(stub.chain, FLOOR_GWEI)).toEqual({
      balance: FLOOR_WEI - 1n,
      low: true,
    });
  });

  it("says nothing at the floor", async () => {
    const stub = stubChain(testConfig(), { balance: FLOOR_WEI });
    expect((await relayerBalanceTick(stub.chain, FLOOR_GWEI)).low).toBe(false);
  });

  it("hands a low balance to the reporter, and a failed read to the other one", async () => {
    const low: bigint[] = [];
    const failed: unknown[] = [];
    const watch = startRelayerBalanceWatch(
      stubChain(testConfig(), { balance: 1n }).chain,
      FLOOR_GWEI,
      (balance) => low.push(balance),
      (error) => failed.push(error),
    );
    await watch.tick();
    watch.stop();
    expect(low).toEqual([1n]);
    expect(failed).toEqual([]);
  });
});
