import { zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { bloomHasAny } from "../src/chain/bloom.js";

/** Base Sepolia jobRegistry, and block 47199368, which carries one of its logs. */
const JOB_REGISTRY = "0x87019B9305D80EBfDC87E2DD80C80F624E05e77d";
const BLOOM_47199368: Hex =
  "0x1001080244000010b5080202080000360001001020202300000000800c304800400a8002020880b0a0004200405c000040000802032401008280290a49340009022250521020a00204208128010022130000040400042110000208800300000c09e00000440046101040100004001c0080020012e00001008000001007010048000000140108002440000000010098508805088204000808440a0102000040000740003004014440508010006830041a0184029b840c00000004000b0400084000401002584c30402028020800027000315401008802000404004430000040042838a0254802046804c2405258a40220062804018800840186800a3000443408";
const EMPTY: Hex = `0x${"00".repeat(256)}`;

describe("bloomHasAny", () => {
  it("finds a contract in the bloom of a block that carries its log", () => {
    expect(bloomHasAny(BLOOM_47199368, [JOB_REGISTRY])).toBe(true);
    expect(bloomHasAny(BLOOM_47199368, [zeroAddress, JOB_REGISTRY])).toBe(true);
  });

  it("finds nothing in an empty bloom", () => {
    expect(bloomHasAny(EMPTY, [JOB_REGISTRY])).toBe(false);
  });

  it("rules out an address whose bits the block does not set", () => {
    expect(bloomHasAny(BLOOM_47199368, ["0x1111111111111111111111111111111111111111"])).toBe(false);
  });

  it("is false for no addresses", () => {
    expect(bloomHasAny(BLOOM_47199368, [])).toBe(false);
  });
});
