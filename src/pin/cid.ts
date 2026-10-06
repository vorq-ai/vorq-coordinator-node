import { createHash } from "node:crypto";

/**
 * Raw-block CIDv1 naming, identical to the emulator's `cid.ts` and to the
 * Global Constraints line that freezes it:
 *
 *     "b" + base32lower( 0x01 [cidv1] 0x55 [raw] 0x12 [sha2-256] 0x20 [len]
 *                        ‖ sha256(bytes) )
 *
 * No IPFS library: a single raw block's name is fully determined by its bytes,
 * so this is sha256 plus four bytes of multiformat prefix. The name is a
 * cross-repo contract — the client and the provider SDK mirror it — which is why
 * the tests pin known-answer vectors derived outside this codebase rather than
 * recomputing them here.
 *
 * **Minting is naming, not challenging.** Nothing recomputes a CID from bytes it
 * fetched: with the object-storage pinner the name is whatever the pinning
 * service minted, and the node records it verbatim.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** CIDv1, raw codec, sha2-256, 32-byte digest. */
const PREFIX = Buffer.from([0x01, 0x55, 0x12, 0x20]);

/** 4 prefix bytes + a 32-byte digest, base32-encoded, plus the multibase "b". */
const CID_LENGTH = 59;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The CID these bytes are named by. */
export function cidForBytes(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  return `b${base32Encode(Buffer.concat([PREFIX, digest]))}`;
}

/**
 * The sha256 hex a CID was minted from, or `null` if the string is not a
 * CIDv1/raw/sha2-256 name.
 *
 * This is the object-storage read path and the reason it can exist at all: the
 * key is the content hash and the CID *carries* that hash under four bytes of
 * prefix, so a fetch needs no cid→key table to consult. It is a decode of a
 * name, never a re-derivation from bytes — a fetched object is still never
 * re-named.
 *
 * A name minted by some other scheme decodes to `null` and reads as a miss,
 * which is the honest answer: this node has no record that maps it to an object.
 */
export function contentHashOfCid(cid: string): string | null {
  if (cid.length !== CID_LENGTH || !cid.startsWith("b")) return null;

  const bytes = Buffer.alloc(36);
  let bits = 0;
  let value = 0;
  let written = 0;
  for (let i = 1; i < cid.length; i += 1) {
    const index = ALPHABET.indexOf(cid[i] as string);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes[written] = (value >>> (bits - 8)) & 0xff;
      written += 1;
      bits -= 8;
    }
  }
  // 58 base32 characters carry 290 bits; the two beyond the 36 bytes are
  // padding and a name that sets them is not one this scheme ever minted.
  if (written !== 36 || (value & ((1 << bits) - 1)) !== 0) return null;
  if (!bytes.subarray(0, PREFIX.length).equals(PREFIX)) return null;

  return bytes.subarray(PREFIX.length).toString("hex");
}
