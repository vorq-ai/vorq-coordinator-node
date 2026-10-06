import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

import {
  CONTAINER_TAG,
  CONTAINER_VERSION,
  SEED_WRAP_BYTES,
  MIN_CONTAINER_BYTES,
  commitmentOf,
} from "../src/container.js";
import { SEED_BYTES } from "../src/escrow/container.js";
import { DEK_HKDF_SALT, DEK_INFO_PREFIX, deriveDek } from "../src/escrow/release.js";
import { jobIdOf } from "../src/orders.js";

/**
 * Regenerates `test/vectors/container-v1.json` — the cross-repo container
 * contract the client SDK and the provider SDK carry byte-identical copies of.
 *
 * **Everything here except `scripts/vectors-inputs.json` is derived.** That file
 * holds the seven random wraps and the seven ciphertexts, which have no source
 * but a coin; every commitment, every job id, every refusal container and every
 * constant below is computed from them and from `src/container.ts`. So a format
 * change is one edit in `src/` plus one run of this script, and the file cannot
 * be half-updated by hand.
 *
 * Run: `npm run gen:vectors`. Set `VECTORS_OUT` to write elsewhere —
 * `test/vectors-generator.test.ts` uses that to compare against the committed
 * file without overwriting it.
 */

const INPUTS_PATH = fileURLToPath(new URL("./vectors-inputs.json", import.meta.url));
const OUT_PATH =
  process.env.VECTORS_OUT ??
  fileURLToPath(new URL("../test/vectors/container-v1.json", import.meta.url));

const inputs = JSON.parse(readFileSync(INPUTS_PATH, "utf8"));

const buf = (hex) => Buffer.from(hex.slice(2), "hex");
const hex = (bytes) => `0x${bytes.toString("hex")}`;

/**
 * The cases, in file order. The lengths are the point: an empty ciphertext, the
 * first byte past the split, both sides of a 32-byte block, and both sides of
 * keccak-256's 136-byte rate.
 */
const CASES = [
  {
    name: "empty-ciphertext",
    why: "the shortest well-formed container: the version byte and wrap, nothing else. keccak256(\"\") is a real hash and this case pins it",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
  {
    name: "one-byte-ciphertext",
    why: "one byte past the split point — the first case where the subarray boundary matters",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
  {
    name: "thirty-one-byte-ciphertext",
    why: "one byte short of a keccak rate boundary",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
  {
    name: "thirty-two-byte-ciphertext",
    why: "exactly one 32-byte block",
    owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  },
  {
    name: "thirty-three-byte-ciphertext",
    why: "one byte past it: an implementation that pads or truncates at the block edge fails here and nowhere else",
    owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  },
  {
    name: "one-thirty-six-byte-ciphertext",
    why: "past keccak-256's 136-byte rate, so the sponge absorbs twice",
    owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  },
  {
    name: "long-ciphertext",
    why: "a realistic sealed envelope",
    owner: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  },
];

/**
 * The KDF vector. Its seed is a constant fill and not one of the sealed wraps
 * above, deliberately: the wraps are sealed boxes whose plaintext this file
 * never carries, and a cross-language KDF check needs the *unsealed* input.
 */
const KDF_SEED = Buffer.alloc(SEED_BYTES, 0x5a);
const KDF_OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const built = CASES.map((entry) => {
  const source = inputs[entry.name];
  if (source === undefined) throw new Error(`scripts/vectors-inputs.json has no ${entry.name}`);
  const wrap = buf(source.wrap);
  const ciphertext = buf(source.ciphertext);
  const container = Buffer.concat([CONTAINER_TAG, wrap, ciphertext]);
  const c = commitmentOf(container);
  return {
    name: entry.name,
    why: entry.why,
    seed_wrap: hex(wrap),
    ciphertext: hex(ciphertext),
    container: hex(container),
    ct_hash: keccak256(ciphertext),
    c,
    owner: entry.owner,
    job_id: jobIdOf(entry.owner, c),
  };
});

const named = (name) => {
  const found = built.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no case named ${name}`);
  return found;
};

// The lifted-wrap property: one case's wrap over another's ciphertext.
const SWAP_CIPHERTEXT_FROM = "thirty-two-byte-ciphertext";
const SWAP_WRAP_FROM = "thirty-three-byte-ciphertext";
const swapped = Buffer.concat([
  CONTAINER_TAG,
  buf(named(SWAP_WRAP_FROM).seed_wrap),
  buf(named(SWAP_CIPHERTEXT_FROM).ciphertext),
]);

// One byte short of the split, whatever the split currently is.
const shortOfSplit = Buffer.concat([
  CONTAINER_TAG,
  Buffer.alloc(MIN_CONTAINER_BYTES - CONTAINER_TAG.length - 1),
]);

// A version byte this format does not define, over an otherwise perfect
// container. With the ASCII magic gone, byte 0 is the whole discriminant, so
// "right magic, wrong version" and "wrong magic" collapse into this one case:
// every byte that is not 0x01 fails the same equality (R8).
const wrongVersion = buf(named("one-byte-ciphertext").container);
wrongVersion[0] = 0x02;

// One flipped bit in the first byte of the bulk, which only the digest catches.
const altered = buf(named(SWAP_CIPHERTEXT_FROM).container);
altered[CONTAINER_TAG.length + SEED_WRAP_BYTES] ^= 0x01;

const vectors = {
  format: "vorq-container-v1",
  generated_by: "vorq-coordinator-node/src/container.ts",
  purpose:
    "The cross-repo contract for container v1. The coordinator, the client SDK and the provider SDK each split and commit these bytes independently; this file is what makes their agreement checkable rather than coincidental. Regenerate it only from the shipped implementation.",
  constants: {
    version: CONTAINER_VERSION,
    version_byte: hex(CONTAINER_TAG),
    wrap_bytes: SEED_WRAP_BYTES,
    min_container_bytes: MIN_CONTAINER_BYTES,
    version_meaning:
      "the one-byte container version, 0x01. There is no ASCII magic: byte 0 is the whole discriminant, and it is inside c",
  },
  rules: {
    layout: "container = version ‖ seed_wrap ‖ ciphertext, with the version byte and seed_wrap at fixed offsets",
    commitment: "c = keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))",
    kdf: "dek = HKDF-SHA256(ikm = seed, salt = \"\", info = utf8(info_prefix) ‖ owner20, L = 32)",
    job_id: "job_id = keccak256(owner ‖ c), 20 raw address bytes then the 32-byte word, packed",
    note: `the ciphertext enters the commitment through its digest and never directly, so the preimage is always exactly 1 + wrap_bytes + 32 = ${MIN_CONTAINER_BYTES + 32} bytes`,
  },
  kdf: {
    why: "the working key is derived from the sealed seed and the job's chain-read owner, never taken from the box directly. Three implementations have to reach the same 32 bytes from the same inputs, so the inputs and the answer travel together in this file rather than as a constant pasted into three test bodies",
    info_prefix: DEK_INFO_PREFIX.toString("utf8"),
    salt: hex(DEK_HKDF_SALT),
    seed: hex(KDF_SEED),
    owner: KDF_OWNER,
    dek: hex(deriveDek(KDF_SEED, KDF_OWNER)),
  },
  cases: built,
  wrap_swap: {
    why: "the property that justifies hashing the wrap into c rather than only the ciphertext: a wrap lifted from another order, over identical ciphertext, must produce a different c and therefore a different job_id",
    ciphertext_from: SWAP_CIPHERTEXT_FROM,
    seed_wrap_from: SWAP_WRAP_FROM,
    container: hex(swapped),
    c: commitmentOf(swapped),
    differs_from: named(SWAP_CIPHERTEXT_FROM).c,
  },
  refusals: [
    {
      name: "shorter than the version byte + seed_wrap",
      fault: "too_short",
      why: "there is nothing to split; a forgiving reader would hash a slice of garbage into a plausible c",
      container: hex(shortOfSplit),
    },
    {
      name: "a version byte this format does not define",
      fault: "bad_version",
      why: "byte 0 is the whole discriminant and it is inside the commitment, so a v2 container must never be read as a v1 one — and a reader that treated an unknown byte as v1 would split at an offset the sender never used",
      container: hex(wrongVersion),
    },
    {
      name: "seed_wrap lifted from another order",
      fault: "commitment_mismatch",
      why: "the container is well formed and reproduces some other order's commitment, never this one",
      container: hex(swapped),
      c: named(SWAP_CIPHERTEXT_FROM).c,
    },
    {
      name: "ciphertext altered in flight",
      fault: "commitment_mismatch",
      why: "one flipped bit in the bulk, which only the digest inside the commitment catches",
      container: hex(altered),
      c: named(SWAP_CIPHERTEXT_FROM).c,
    },
  ],
};

const serialized = `${JSON.stringify(vectors, null, 2)}\n`;
writeFileSync(OUT_PATH, serialized);
console.log(`gen-vectors: wrote ${OUT_PATH} (${Buffer.byteLength(serialized)} bytes)`);
