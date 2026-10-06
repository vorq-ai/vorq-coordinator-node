import { hexToBytes, keccak256, type Hex } from "viem";
import type { Address } from "../config.js";

/**
 * Whether a block's `logsBloom` may carry a log from any of `addresses`.
 *
 * The Yellow Paper's M3:2048 filter: each address sets three bits, taken from
 * the first three byte pairs of its keccak. `false` is exact — no log from those
 * addresses is in the block — and `true` may be a false positive, which costs one
 * `eth_getLogs` that comes back empty.
 */
export function bloomHasAny(bloom: Hex, addresses: readonly Address[]): boolean {
  const filter = hexToBytes(bloom);
  return addresses.some((address) => {
    const hash = hexToBytes(keccak256(address));
    for (const i of [0, 2, 4]) {
      const bit = ((hash[i]! << 8) | hash[i + 1]!) & 2047;
      if ((filter[255 - (bit >> 3)]! & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  });
}
