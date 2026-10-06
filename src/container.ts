import { keccak_256 } from "@noble/hashes/sha3";
import { keccak256, type Hex } from "viem";

/**
 * Container v1, and the one check that stands between a signed order and a job
 * nothing can ever work.
 *
 * ```
 * container = version ‖ seed_wrap ‖ ciphertext    version   = 0x01, 1 byte
 *                                                 seed_wrap = seal(recipient, seed), 80 bytes
 * c         = keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))
 * jobId     = keccak256(owner ‖ c)
 * ```
 *
 * **Why this is not optional, and why nothing downstream can stand in for it.**
 * The client signs `c` and this node no longer receives a `task_cid` it could
 * check by resolving — the CID does not exist yet, because this node is about to
 * mint it. So the container arriving with the order is checked against the
 * commitment the client signed, here, or it is never checked at all. Skip it and
 * the node happily pins bytes that do not reproduce `c`, posts a job naming
 * them, and **strands the job permanently**: every provider re-derives
 * `keccak256(owner ‖ c) == jobId` from the bytes it fetched (§00 of the design,
 * and the provider SDK's own claim gate), gets a different id, and refuses. The
 * escrow is committed, the relayer has paid, and nobody can work it.
 *
 * The two failure shapes this refuses are the ones the check exists for and they
 * are not hypothetical: a `seed_wrap` lifted from **another order** (the whole
 * point of hashing the wrap into `c` rather than only the ciphertext) and a
 * **ciphertext altered in flight**. Both change the commitment; neither changes
 * anything a length check or a version check would notice.
 *
 * The whole file is arithmetic over bytes. It reads no configuration, opens no
 * socket and asks nothing — so the refusal it produces costs one keccak of the
 * ciphertext plus one of 113 bytes, and happens before the node has spent a
 * database read, a chain call or a wei of gas. {@link commitmentOf} takes the
 * container whole (a batch line); {@link commitmentStream} takes it as it
 * streams through the post door, and the two must agree on every input —
 * `test/container.test.ts` holds them to it.
 */

/**
 * The container format's version, and the whole of its tag.
 *
 * **A discriminant, not a length.** `0x01` means `(sealed box, 80 bytes)`; a
 * future `0x02` would mean its own kind and its own width. The version
 * deliberately does not *encode* the length — a length in the bytes is
 * attacker-supplied data needing validation on every parse, and a width in the
 * code is a constant with nothing to lie about.
 *
 * **Downgrade attacks are structurally impossible, and that is why it lives
 * here rather than beside the container.** Byte 0 is inside `c`, so flipping it
 * changes the commitment and fails at the post door and at every provider's
 * claim gate — before a claim is spent. Formats carrying the version as
 * unauthenticated metadata have to defend that explicitly.
 */
export const CONTAINER_VERSION = 0x01;

/** The version byte as the bytes the commitment's preimage carries. */
export const CONTAINER_TAG = Buffer.from([CONTAINER_VERSION]);

/** A sealed-box wrap of the seed. Fixed width, which is what makes the split a split. */
export const SEED_WRAP_BYTES = 80;

/**
 * The shortest thing that is a container at all: the version byte and the wrap.
 *
 * The ciphertext may be empty and the format says so — `keccak256("")` is a
 * perfectly good hash and `test/vectors/container-v1.json` pins that case — so
 * this node does not invent a minimum payload the client SDK and the provider
 * SDK would not share. An empty ciphertext is a client committing to an empty
 * task with its own escrow behind it, which is its business; **a buffer too short
 * to split is not a container at all**, which is this node's.
 */
export const MIN_CONTAINER_BYTES = CONTAINER_TAG.length + SEED_WRAP_BYTES;

/** Why a buffer is not a container. Mapped to a `400` by the door, never swallowed. */
export type ContainerFault = "too_short" | "bad_version" | "commitment_mismatch";

export class ContainerError extends Error {
  constructor(
    readonly fault: ContainerFault,
    message: string,
  ) {
    super(message);
    this.name = "ContainerError";
  }
}

/**
 * `keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))` over these bytes.
 *
 * The length and the version are checked **before** the split, so a short or
 * mislabelled buffer is a clean refusal naming what is wrong rather than a
 * commitment computed over a slice of garbage — `Buffer.subarray` clamps out of
 * range instead of throwing, so without these two the 80-byte case would sail
 * through and produce a plausible-looking hash.
 */
export function commitmentOf(container: Buffer): Hex {
  if (container.length < MIN_CONTAINER_BYTES) {
    throw new ContainerError(
      "too_short",
      `a container is at least ${MIN_CONTAINER_BYTES} bytes — the version byte and an ` +
        `${SEED_WRAP_BYTES}-byte seed_wrap — and this one is ${container.length}`,
    );
  }
  if (!container.subarray(0, CONTAINER_TAG.length).equals(CONTAINER_TAG)) {
    throw new ContainerError(
      "bad_version",
      `a container v1 begins with the version byte 0x${CONTAINER_TAG.toString("hex")}, and this ` +
        `one begins with 0x${container.subarray(0, CONTAINER_TAG.length).toString("hex")}`,
    );
  }

  const head = container.subarray(0, CONTAINER_TAG.length + SEED_WRAP_BYTES);
  const ciphertext = container.subarray(CONTAINER_TAG.length + SEED_WRAP_BYTES);
  // `keccak256` of the ciphertext, then of the 113-byte preimage. Never one hash
  // over the whole file: the commitment covers the bulk through its digest, and
  // that shape is fixed by the client and the provider SDK alike.
  const ciphertextHash = keccak256(ciphertext as unknown as Uint8Array);
  return keccak256(
    Buffer.concat([head, Buffer.from(ciphertextHash.slice(2), "hex")]) as unknown as Uint8Array,
  );
}

/**
 * The same commitment, computed over a container that arrives in pieces.
 *
 * The head — version byte and seed_wrap — is gathered until it is whole, and
 * every byte after it goes into one running keccak of the ciphertext, so the
 * process holds 81 bytes of the container however large it is. The version is
 * checked on the first byte, so a mislabelled upload is refused before the rest
 * of it is read.
 */
export interface CommitmentStream {
  /** Take the next bytes of the container, in order. */
  update(chunk: Buffer): void;
  /** How many bytes have gone through. */
  readonly bytes: number;
  /** `c` over everything taken so far. Refuses a container too short to split. */
  digest(): Hex;
}

export function commitmentStream(): CommitmentStream {
  const head = Buffer.alloc(MIN_CONTAINER_BYTES);
  let headBytes = 0;
  const ciphertext = keccak_256.create();
  let bytes = 0;

  return {
    get bytes() {
      return bytes;
    },
    update(chunk: Buffer): void {
      bytes += chunk.length;
      let rest = chunk;
      if (headBytes < MIN_CONTAINER_BYTES) {
        const take = Math.min(MIN_CONTAINER_BYTES - headBytes, rest.length);
        rest.copy(head, headBytes, 0, take);
        headBytes += take;
        rest = rest.subarray(take);
        if (headBytes > 0 && head[0] !== CONTAINER_VERSION) {
          throw new ContainerError(
            "bad_version",
            `a container v1 begins with the version byte 0x${CONTAINER_TAG.toString("hex")}, and this ` +
              `one begins with 0x${head.subarray(0, 1).toString("hex")}`,
          );
        }
      }
      if (rest.length > 0) ciphertext.update(rest);
    },
    digest(): Hex {
      if (headBytes < MIN_CONTAINER_BYTES) {
        throw new ContainerError(
          "too_short",
          `a container is at least ${MIN_CONTAINER_BYTES} bytes — the version byte and an ` +
            `${SEED_WRAP_BYTES}-byte seed_wrap — and this one is ${bytes}`,
        );
      }
      return keccak256(
        Buffer.concat([head, Buffer.from(ciphertext.clone().digest())]) as unknown as Uint8Array,
      );
    },
  };
}

/** Throws unless `computed` is the `c` the order signed. See {@link assertCommitment}. */
export function assertSameCommitment(computed: Hex, c: Hex): void {
  // Compared lowercase because both sides are node-produced hex here, and a
  // case mismatch would be a refusal for a reason that is not the caller's.
  if (computed.toLowerCase() !== c.toLowerCase()) {
    throw new ContainerError(
      "commitment_mismatch",
      "the container does not reproduce c: keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext)) " +
        `is ${computed}. A job posted over bytes that miss their commitment is a job every ` +
        "provider refuses to claim, with the escrow already committed",
    );
  }
}

/** Throws unless these bytes are the container `c` commits to. */
export function assertCommitment(container: Buffer, c: Hex): void {
  assertSameCommitment(commitmentOf(container), c);
}
