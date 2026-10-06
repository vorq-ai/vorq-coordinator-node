import { custom, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { atFloor, makeChain, missingBlock } from "../src/chain/client.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * The node's block floor, and the reads pinned to it (`atFloor`).
 *
 * Measured on Base Sepolia through Infura, 2026-09-23: a claim's receipt came
 * from one node of the load-balanced endpoint and the `getJob` read 10 ms later
 * from another that did not have the block yet, so `/release` refused the DEK
 * for a job this node had just relayed. These are the two halves of the fix: the
 * floor rises with every receipt and head poll, and a pinned read waits out a
 * node that answers `block not found` rather than accepting a stale `latest`.
 */

/** One transport whose `latest`, receipt block and per-call answers the test controls. */
function transport(state: { latest: bigint; receiptBlock: bigint; callsAt: unknown[]; missing: number }) {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        switch (method) {
          case "eth_blockNumber":
            return numberToHex(state.latest);
          case "eth_getTransactionReceipt":
            return {
              transactionHash: (params as [string])[0],
              transactionIndex: "0x0",
              blockHash: `0x${"ab".repeat(32)}`,
              blockNumber: numberToHex(state.receiptBlock),
              from: `0x${"11".repeat(20)}`,
              to: `0x${"22".repeat(20)}`,
              cumulativeGasUsed: "0x1",
              gasUsed: "0x1",
              effectiveGasPrice: "0x1",
              contractAddress: null,
              logs: [],
              logsBloom: `0x${"00".repeat(256)}`,
              status: "0x1",
              type: "0x2",
            };
          case "eth_call": {
            state.callsAt.push((params as unknown[])[1]);
            if (state.missing > 0) {
              state.missing -= 1;
              throw { code: -32001, message: `block not found: ${String((params as unknown[])[1])}` };
            }
            return `0x${"00".repeat(31)}01`;
          }
          default:
            throw { code: -32601, message: method };
        }
      },
    },
    { retryCount: 0 },
  );
}

describe("the block floor", () => {
  it("starts at zero, and every head poll and receipt raises it — never lowers it", async () => {
    const state = { latest: 100n, receiptBlock: 105n, callsAt: [] as unknown[], missing: 0 };
    const chain = makeChain(testConfig(), transport(state));

    expect(chain.floor()).toBe(0n);
    await chain.headBlock();
    expect(chain.floor()).toBe(100n);
    const receipt = await chain.receipt(`0x${"cd".repeat(32)}`, 1_000);
    expect(receipt.blockNumber).toBe(105n);
    expect(chain.floor()).toBe(105n);
    // A head poll that lags the receipt (another node of the endpoint) cannot
    // pull the floor back.
    state.latest = 103n;
    await chain.headBlock();
    expect(chain.floor()).toBe(105n);
    chain.saw(90n);
    expect(chain.floor()).toBe(105n);
  });

  it("reads `latest` while there is no floor, and the floor's block once there is", async () => {
    const state = { latest: 100n, receiptBlock: 105n, callsAt: [] as unknown[], missing: 0 };
    const chain = makeChain(testConfig(), transport(state));
    const read = (at: Parameters<Parameters<typeof atFloor>[1]>[0]) =>
      chain.publicClient.call({ to: `0x${"22".repeat(20)}`, data: "0x", ...at });

    await atFloor(chain, read);
    expect(state.callsAt).toEqual(["latest"]);

    await chain.receipt(`0x${"cd".repeat(32)}`, 1_000);
    await atFloor(chain, read);
    expect(state.callsAt).toEqual(["latest", numberToHex(105n)]);
  });

  it("asks again when the endpoint does not have the pinned block yet, then gives up", async () => {
    const state = { latest: 100n, receiptBlock: 105n, callsAt: [] as unknown[], missing: 2 };
    const chain = makeChain(testConfig(), transport(state));
    await chain.receipt(`0x${"cd".repeat(32)}`, 1_000);

    const read = (at: Parameters<Parameters<typeof atFloor>[1]>[0]) =>
      chain.publicClient.call({ to: `0x${"22".repeat(20)}`, data: "0x", ...at });
    await expect(atFloor(chain, read)).resolves.toBeDefined();
    // Two refusals, then the answer: three reads, all at the floor.
    expect(state.callsAt).toEqual(Array(3).fill(numberToHex(105n)));

    // Past the retry budget the error is the caller's to classify, unchanged.
    state.missing = 100;
    state.callsAt.length = 0;
    await expect(atFloor(chain, read)).rejects.toSatisfy(missingBlock);
    expect(state.callsAt.length).toBe(6);
  }, 10_000);

  it("recognises a missing block by code or by wording, anywhere in the cause chain", () => {
    expect(missingBlock({ code: -32001, message: "x" })).toBe(true);
    expect(missingBlock(new Error("wrapped", { cause: { message: "header not found" } }))).toBe(true);
    expect(missingBlock({ code: -32000, message: "execution reverted" })).toBe(false);
    expect(missingBlock(new Error("nothing to do with blocks"))).toBe(false);
  });
});
