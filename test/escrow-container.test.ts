import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  CONTAINER_TAG,
  ContainerError,
  SEED_WRAP_BYTES,
  MIN_CONTAINER_BYTES,
  commitmentOf,
  type ContainerFault,
} from "../src/container.js";
import {
  DEK_BYTES,
  SEALED_PAYLOAD_BYTES,
  SealError,
  commitment,
  jobIdFor,
  newRecipientKeypair,
  openDek,
  sealDek,
  splitContainer,
} from "../src/escrow/container.js";

/**
 * The escrow's half of container v1, driven by the **same** cross-repo vectors
 * the post door is driven by — `test/vectors/container-v1.json`, read here and
 * never written.
 *
 * The thing under test is an agreement, not an algorithm. `/release` is handed a
 * wrap and a ciphertext hash and never the payload, so it reaches `c` from two
 * pieces while the post door reaches it from a whole buffer. If those two ever
 * disagree the node authorises releases against a commitment no client signed —
 * and nothing else in the system would notice, because each half is
 * self-consistent. So the agreement is asserted on **every** positive vector
 * rather than on one, and every expected value below is read out of the file
 * instead of recomputed on this page: a test that re-derives the answer the same
 * way the code does proves only that the page is consistent with itself.
 */

interface Vectors {
  constants: {
    version: number;
    version_byte: Hex;
    wrap_bytes: number;
    min_container_bytes: number;
  };
  cases: {
    name: string;
    seed_wrap: Hex;
    ciphertext: Hex;
    container: Hex;
    ct_hash: Hex;
    c: Hex;
    owner: Hex;
    job_id: Hex;
  }[];
  wrap_swap: {
    ciphertext_from: string;
    seed_wrap_from: string;
    container: Hex;
    c: Hex;
    differs_from: Hex;
  };
  refusals: { name: string; fault: ContainerFault; container: Hex; c?: Hex }[];
}

const VECTORS_PATH = fileURLToPath(new URL("./vectors/container-v1.json", import.meta.url));
const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

const buf = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const caseNamed = (name: string) => {
  const found = vectors.cases.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`the vectors carry no case named ${name}`);
  return found;
};

describe("commitment from the two pieces /release actually receives", () => {
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    "%s — reproduces the vector's c and agrees with the whole-buffer form",
    (_name, entry) => {
      const reached = commitment(buf(entry.seed_wrap), buf(entry.ct_hash));

      // The vector's own answer, not one this file computed.
      expect(reached).toBe(entry.c);
      // And the post door's answer over the same case. This is the whole point
      // of the module: two routes to one commitment, on every shipped vector.
      expect(reached).toBe(commitmentOf(buf(entry.container)));
    },
  );

  it("reaches a distinct commitment for every case, so the agreement is not vacuous", () => {
    const reached = vectors.cases.map((entry) => commitment(buf(entry.seed_wrap), buf(entry.ct_hash)));
    expect(new Set(reached).size).toBe(vectors.cases.length);
  });

  it("refuses a wrap that is not exactly the format's width", () => {
    const entry = caseNamed("one-byte-ciphertext");
    const wrap = buf(entry.seed_wrap);
    expect(() => commitment(wrap.subarray(0, SEED_WRAP_BYTES - 1), buf(entry.ct_hash))).toThrow();
    expect(() =>
      commitment(Buffer.concat([wrap, Buffer.alloc(1)]), buf(entry.ct_hash)),
    ).toThrow();
  });

  it("refuses a ciphertext hash that is not a 32-byte digest", () => {
    // The preimage is fixed at 113 bytes. A short hash would still concatenate
    // into a plausible-looking buffer and hash to something, which is exactly
    // the failure a length check is cheap enough to make impossible.
    const entry = caseNamed("one-byte-ciphertext");
    expect(() => commitment(buf(entry.seed_wrap), buf(entry.ct_hash).subarray(0, 31))).toThrow();
  });
});

describe("jobIdFor — the commitment as it stands, with no inner hash", () => {
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    "%s — reproduces the vector's job_id",
    (_name, entry) => {
      expect(jobIdFor(entry.owner as `0x${string}`, entry.c)).toBe(entry.job_id);
    },
  );

  it("the weld: another order's wrap over identical ciphertext lands on a different job", () => {
    // The property P4 leans on. The swap case reuses one vector's ciphertext
    // under another's wrap; if `c` did not cover the wrap, the lifted bytes
    // would land on the *same* job id and a wrap could be re-pinned under an
    // attacker's order.
    const { wrap_swap: swap } = vectors;
    const source = caseNamed(swap.ciphertext_from);
    const owner = source.owner as `0x${string}`;

    expect(commitmentOf(buf(swap.container))).toBe(swap.c);
    expect(swap.differs_from).toBe(source.c);
    expect(jobIdFor(owner, swap.c)).not.toBe(jobIdFor(owner, swap.differs_from));
    expect(jobIdFor(owner, swap.differs_from)).toBe(source.job_id);
  });

  it("the same commitment under a different owner is a different job", () => {
    const entry = caseNamed("one-byte-ciphertext");
    const other = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
    expect(jobIdFor(other, entry.c)).not.toBe(entry.job_id);
  });
});

describe("splitContainer — the split, exposed for the paths that need the pieces", () => {
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    "%s — yields the vector's own wrap and ciphertext",
    (_name, entry) => {
      const { seedWrap, ciphertext } = splitContainer(buf(entry.container));
      expect(`0x${seedWrap.toString("hex")}`).toBe(entry.seed_wrap);
      expect(`0x${ciphertext.toString("hex")}`).toBe(entry.ciphertext);
      expect(seedWrap.length).toBe(SEED_WRAP_BYTES);
      // Round trip: the pieces the split produced reach the vector's `c`.
      expect(commitment(seedWrap, buf(entry.ct_hash))).toBe(entry.c);
    },
  );

  it("splits the 81-byte empty-ciphertext container cleanly", () => {
    // The boundary case: exactly `MIN_CONTAINER_BYTES`, an empty ciphertext, and
    // `Buffer.subarray` clamping rather than throwing is what makes an off-by-one
    // here silent instead of loud.
    const entry = caseNamed("empty-ciphertext");
    const container = buf(entry.container);
    expect(container.length).toBe(MIN_CONTAINER_BYTES);
    expect(container.length).toBe(vectors.constants.min_container_bytes);

    const { seedWrap, ciphertext } = splitContainer(container);
    expect(seedWrap.length).toBe(SEED_WRAP_BYTES);
    expect(ciphertext.length).toBe(0);
    expect(commitment(seedWrap, buf(entry.ct_hash))).toBe(entry.c);
  });

  it.each(
    vectors.refusals
      .filter((entry) => entry.fault !== "commitment_mismatch")
      .map((entry) => [entry.name, entry] as const),
  )("%s — refuses with its own labelled fault and no other", (_name, entry) => {
    let thrown: unknown;
    try {
      splitContainer(buf(entry.container));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerError);
    expect((thrown as ContainerError).fault).toBe(entry.fault);
  });

  it("checks the length and the tag before it slices", () => {
    const short = vectors.refusals.find((entry) => entry.fault === "too_short");
    expect(short).toBeDefined();
    const bytes = buf((short as { container: Hex }).container);
    // One byte short of the split, so a clamped subarray would hand back a
    // 79-byte "wrap" and a commitment computed over garbage.
    expect(bytes.length).toBe(MIN_CONTAINER_BYTES - 1);
    expect(() => splitContainer(bytes)).toThrow(ContainerError);
  });

  it("splits the commitment-mismatch refusals fine — they are well-formed, just not committed to", () => {
    // Fault isolation, in the direction that is easy to get wrong: these bytes
    // are a valid container. The split has no opinion about them; only the
    // commitment does, and it disagrees.
    for (const entry of vectors.refusals.filter((r) => r.fault === "commitment_mismatch")) {
      const container = buf(entry.container);
      const { seedWrap, ciphertext } = splitContainer(container);
      expect(seedWrap.length).toBe(SEED_WRAP_BYTES);
      expect(seedWrap.length + ciphertext.length + CONTAINER_TAG.length).toBe(container.length);
      expect(commitmentOf(container)).not.toBe(entry.c);
    }
  });
});

describe("the sealed box — the wrap's two ends, of which this node holds one", () => {
  // The vectors carry no recipient keypair, deliberately: they pin the format,
  // not a secret. So the round trip is proved against a freshly generated pair.
  const dek = Buffer.alloc(DEK_BYTES, 0xab);

  it("seals to exactly the width the format declares", () => {
    const { publicKey } = newRecipientKeypair();
    const wrap = sealDek(dek, publicKey);
    expect(wrap.length).toBe(SEED_WRAP_BYTES);
    expect(wrap.length).toBe(vectors.constants.wrap_bytes);
  });

  it("round-trips a DEK through seal and open", () => {
    const { publicKey, secretKey } = newRecipientKeypair();
    const opened = openDek(sealDek(dek, publicKey), publicKey, secretKey);
    expect(opened.length).toBe(DEK_BYTES);
    expect(opened.equals(dek)).toBe(true);
  });

  it("is anonymous: two seals of the same DEK to the same key differ", () => {
    // `crypto_box_seal` mints an ephemeral sender pair per call. A deterministic
    // wrap would let an observer test a guessed DEK against a posted container.
    const { publicKey } = newRecipientKeypair();
    expect(sealDek(dek, publicKey).equals(sealDek(dek, publicKey))).toBe(false);
  });

  it("refuses to open under the wrong recipient", () => {
    const mine = newRecipientKeypair();
    const theirs = newRecipientKeypair();
    const wrap = sealDek(dek, theirs.publicKey);
    expect(() => openDek(wrap, mine.publicKey, mine.secretKey)).toThrow(SealError);
  });

  it("refuses a tampered wrap", () => {
    const { publicKey, secretKey } = newRecipientKeypair();
    const wrap = sealDek(dek, publicKey);
    wrap[SEED_WRAP_BYTES - 1] ^= 0x01;
    expect(() => openDek(wrap, publicKey, secretKey)).toThrow(SealError);
  });

  it("refuses a wrap of the wrong width rather than reading out of bounds", () => {
    const { publicKey, secretKey } = newRecipientKeypair();
    const wrap = sealDek(dek, publicKey);
    expect(() => openDek(wrap.subarray(0, SEED_WRAP_BYTES - 1), publicKey, secretKey)).toThrow();
  });

  it("refuses to seal anything that is not a 32-byte sealed-box payload", () => {
    const { publicKey } = newRecipientKeypair();
    expect(() => sealDek(Buffer.alloc(SEALED_PAYLOAD_BYTES - 1), publicKey)).toThrow();
    expect(() => sealDek(dek, publicKey.subarray(0, 31))).toThrow();
  });

  it("a freshly sealed wrap is a container wrap: both routes still agree over it", () => {
    // Ties the two halves of this file together — the seal end produces bytes
    // the post door's whole-buffer form and the escrow's two-piece form both
    // commit to identically.
    const entry = caseNamed("thirty-two-byte-ciphertext");
    const { publicKey } = newRecipientKeypair();
    const wrap = sealDek(dek, publicKey);
    const container = Buffer.concat([CONTAINER_TAG, wrap, buf(entry.ciphertext)]);

    expect(commitment(wrap, buf(entry.ct_hash))).toBe(commitmentOf(container));
    expect(splitContainer(container).seedWrap.equals(wrap)).toBe(true);
  });
});
