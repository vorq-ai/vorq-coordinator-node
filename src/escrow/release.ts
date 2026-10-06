import { hkdfSync } from "node:crypto";
import { recoverTypedDataAddress, type Hex } from "viem";
import { Type, type Static } from "typebox";
import { ApiError } from "../api/errors.js";
import { Base64, Hex32, HexBare32, SafeUint } from "../api/schemas/common.js";
import { getJob, idOf, type Chain, type JobView } from "../chain/client.js";
import type { Address, Config } from "../config.js";
import { SEED_WRAP_BYTES } from "../container.js";
import { DEK_BYTES, SEED_BYTES, commitment, jobIdFor, sealDek } from "./container.js";
import type { EscrowKeys } from "./keys.js";

/**
 * `POST /release` — the key oracle, and the one door in this system that hands
 * out key material.
 *
 * ## The finding that shapes this file (P4)
 *
 * The plan's "weld" — `keccak256(owner ‖ keccak256(version ‖ seed_wrap ‖ ct_hash)) ==
 * job_id` — proves only that the presented wrap belongs to the presented job id.
 * **It does not stop wrap lifting.** Containers are publicly fetchable by CID,
 * so anyone can obtain a victim's `seed_wrap` `W`. An attacker computes
 * `c' = keccak256(TAG ‖ W ‖ any_ct_hash)`, posts its **own** dust order (`cap =
 * 1`), which mints `job_id' = keccak256(attacker ‖ c')`, claims it with a
 * registered provider wallet, and calls here. Every check below passes, because
 * every field is honest and every identity is genuinely the attacker's own.
 *
 * The repairs that do **not** close it, each ruled out before this file was
 * written, and each stated here so nobody re-derives them:
 *
 *   * *reading `owner` from chain instead of from the body* — necessary, and done
 *     (P4 requires it); C1 has since removed the body field entirely, but the
 *     attacker's job genuinely has the attacker as its chain owner, so the
 *     comparison was always self-consistent and always passed;
 *   * *`c` uniqueness on chain* — the attacker picks a fresh `ct_hash`, so `c'` is
 *     a commitment nobody has spent;
 *   * *fetching the container from its CID rather than trusting the body* — the
 *     attacker pins `TAG ‖ W ‖ garbage` under its own name, and the fetched bytes
 *     still carry the victim's wrap;
 *   * *widening the wrap to seal `owner ‖ dek`* — this **does** close it, and it
 *     is forbidden: it moves `SEED_WRAP_BYTES` from 80 to 100 and
 *     `MIN_CONTAINER_BYTES` from 81 to 101, forking container v1 across four
 *     repos and forcing `test/vectors/container-v1.json` — a byte-identical
 *     cross-language contract — to be regenerated.
 *
 * The deeper reason none of the first three work: **the container is public, so
 * any authorisation predicate an attacker can read, an attacker can satisfy.**
 * A refusal cannot come from a check over public data. It has to come from the
 * derivation.
 *
 * ## The mechanism: the sealed 32 bytes are a seed, not the DEK
 *
 * ```
 * dek = HKDF-SHA256(ikm = seed, salt = "" (zero length), info = "vorq-dek" ‖ owner20, L = 32)
 * ```
 *
 * where `owner20` is the job's **chain-read** owner as 20 raw bytes and `seed` is
 * the 32 bytes recovered from the sealed box. See {@link deriveDek}, which states
 * every input.
 *
 * Under this rule the attacker's request is not refused — it succeeds, and hands
 * back `HKDF(seed, attacker)`, which is **not** the key the victim's ciphertext
 * was encrypted under. The attack fails at its objective rather than at the door,
 * which is the strongest place to fail it: there is no check to bypass. The rule
 * is universal and symmetric — whoever unseals a wrap derives with the job's
 * owner — so a designated job, whose wrap is sealed to a provider's TEE key and
 * never touches this node, is protected from the identical attack by the identical
 * rule.
 *
 * The cost is zero format change: the wrap is still 80 bytes, the container
 * layout is untouched, and `test/vectors/container-v1.json` pins `seed_wrap` as an
 * opaque blob and asserts nothing about its plaintext. The cost is instead a
 * **cross-repo obligation**, which is Plan 4's: `vorq-client-sdk-python` must seal a seed
 * and derive its encryption key this way, and `vorq-provider-sdk` must derive
 * after unsealing a designated wrap.
 *
 * ## What this door never reads (P7)
 *
 * **Postgres.** Claim state, provider identity and owner all come from `eth_call`
 * at `latest` (P18). A `Claimed` row forged directly in the projection must not
 * move this decision by a byte, and Task 7 has a test that forges one.
 */

/**
 * How far `issued_at` may sit from this node's clock, in seconds, inclusive.
 *
 * Symmetric, because clock skew is symmetric: a provider whose clock runs fast
 * is no more suspicious than one whose clock runs slow. The bound is what stops
 * a captured request being replayable forever; it is deliberately **not** a
 * nonce, because release-once is the chain's claim state and a replay inside the
 * window re-delivers to the original `response_pubkey` anyway.
 */
export const RELEASE_SKEW_SECONDS = 600;

/** `JobState.Claimed`. The one state in which a DEK is owed. */
const JOB_STATE_CLAIMED = 1;

/**
 * The KDF's domain label. `utf8`, unpadded, 8 bytes — stated because a second
 * implementation has to reproduce it byte for byte.
 *
 * **No version suffix** (C3). There used to be two version namespaces declaring
 * the same fact with nothing keeping them in sync — `0x01` in the container's
 * first byte and `v1` here. Byte 0 wins: it travels with the bytes it describes
 * and it is committed by `c`. The version does no work in `info` anyway, because
 * seeds are freshly random per job, so no seed ever appears under two format
 * versions and cross-version key confusion is impossible by construction. The
 * label's job is domain separation, which is orthogonal to container layout.
 */
export const DEK_INFO_PREFIX = Buffer.from("vorq-dek", "utf8");

/**
 * The HKDF salt: **explicitly zero-length**.
 *
 * RFC 5869 §2.2 substitutes `HashLen` zero bytes for an absent salt, so this is
 * the specified "no salt" case rather than an oversight. The whole of the domain
 * separation lives in `info`, where the owner binding also lives, so there is one
 * place a reader has to look to know what a derived key is bound to.
 */
export const DEK_HKDF_SALT = Buffer.alloc(0);

/**
 * The working DEK for a job, from the seed its container sealed and the job's
 * **chain-read** owner.
 *
 * ```
 * ikm  = seed                                   32 bytes, the sealed-box plaintext
 * salt = ""                                     zero length (RFC 5869 §2.2)
 * info = utf8("vorq-dek") ‖ owner               8 + 20 = 28 bytes, owner raw
 * L    = 32
 * hash = SHA-256
 * ```
 *
 * `node:crypto.hkdfSync` is the KDF because `sodium-native@5` ships no
 * HKDF-SHA256 (P10, probed rather than assumed).
 *
 * The owner enters as **20 raw bytes**, never as a hex string: checksum casing is
 * display-only, and a KDF that took the string would derive two different keys
 * for one address depending on how a caller happened to spell it — the exact
 * class of silent cross-implementation disagreement P10 exists to prevent.
 */
export function deriveDek(seed: Buffer, owner: Address): Buffer {
  if (seed.length !== SEED_BYTES) {
    throw new Error(`a DEK seed is ${SEED_BYTES} bytes, and this one is ${seed.length}`);
  }
  const ownerBytes = Buffer.from(owner.slice(2), "hex");
  if (ownerBytes.length !== 20) {
    throw new Error(`an owner is 20 bytes, and this one is ${ownerBytes.length}`);
  }
  const info = Buffer.concat([DEK_INFO_PREFIX, ownerBytes]);
  return Buffer.from(hkdfSync("sha256", seed, DEK_HKDF_SALT, info, DEK_BYTES));
}

/**
 * When this node's custody of its key material began.
 *
 * Minted by Task 5/6 — an instance booting with no inherited keys records
 * `{time: now, block: head}`; an instance joining by handover adopts
 * `min(own, holder's)`. It arrives here as an **injected, possibly absent**
 * dependency, and absent means "not orphaned": a node that cannot say when its
 * keys began must never claim a job predates them.
 */
export interface KeyEpochStart {
  /** Unix **milliseconds**, as `Date.now()`. */
  time: number;
  /** The head at that instant. Task 6's book filter uses this half. */
  block: bigint;
}

/**
 * Whether a job's wrap can only ever have named a key this node's custody never
 * covered — the per-job `escrow_key_lost` predicate (P7).
 *
 * **Chain-only and one-sided, by construction.** The plan routed this through
 * `posted_block`, which exists only in Postgres, and `/release` must not read
 * Postgres. `JobView` carries no posting block and no posting time either, so the
 * derivation has to come from something the chain does expose:
 *
 *   * `expiresAt` is **always later than the posting** — the registry refuses an
 *     order whose expiry is already past — so `expiresAt < keyEpochStart` proves
 *     the job was posted before the epoch. It is a *sufficient* condition, never
 *     a necessary one.
 *   * `designated == 0` means the escrow was in this job's path at all. A
 *     designated job's wrap is sealed to a provider's own key and this node never
 *     held it, so "lost" would be a false statement about a key that was never
 *     ours.
 *
 * The one-sidedness is the property that matters and it is deliberate: this can
 * never produce a **false** `escrow_key_lost`. Jobs in the ambiguous band —
 * posted before the epoch but expiring after it — classify as `unseal_failed`
 * instead, and the provider's escape is identical either way (`fail` inside
 * `FAIL_GRACE`, penalty-free). A misclassification costs a label; the opposite
 * error would tell a provider a live job's key is gone.
 *
 * The comparison is strict: an expiry landing exactly on the epoch instant proves
 * nothing about when the job was posted.
 */
export function isEscrowOrphan(view: JobView, epoch: KeyEpochStart | null): boolean {
  if (epoch === null) return false;
  if (Number(view.designated) !== 0) return false;
  return Number(view.expiresAt) * 1000 < epoch.time;
}

/**
 * The EIP-712 domain a release request is signed in.
 *
 * **Three namespaces, and none of them may overlap.** The session handshake signs
 * `{name:"VORQ", version:"1", chainId:1}`, an off-chain auth artifact; the two
 * registries verify `{name:"VORQ", version:"2", chainId, verifyingContract}`, an
 * on-chain order or op. This is a third thing again — an off-chain request to a
 * *specific node on a specific deployment*, asking for key material — so it takes
 * its own name and carries the real `chainId`.
 *
 * There is no `verifyingContract` because no contract verifies this: the escrow
 * is an API, not an address. Binding the chain id is what stops a release signed
 * against one deployment being replayed against another — the same provider
 * wallet is registered on both, and `job_id` is derivable on both, so without it
 * a captured request would be worth two keys.
 */
export const releaseDomain = (chainId: number) =>
  ({ name: "VORQ Escrow", version: "1", chainId }) as const;

/**
 * `Release(bytes32 jobId,bytes seedWrap,bytes32 ctHash,bytes32 responsePubkey,uint64 issuedAt)`
 *
 * **Every field of the body is signed, `responsePubkey` included**, which is what
 * makes a replay harmless rather than dangerous: a captured request can only ever
 * re-deliver to the recipient the original signer chose. Leave that field out and
 * a captured request becomes a bearer token for the DEK.
 *
 * **`owner` is not a member** (C1). `jobId = keccak256(owner ‖ c)` already commits
 * it and the authorisation reads it from `getJob`, so it was redundant even
 * inside the signature — and a signed field that decides nothing is a field a
 * second implementation will eventually be tempted to trust.
 */
export const RELEASE_TYPES = {
  Release: [
    { name: "jobId", type: "bytes32" },
    { name: "seedWrap", type: "bytes" },
    { name: "ctHash", type: "bytes32" },
    { name: "responsePubkey", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/**
 * The largest `/release` body this node accepts.
 *
 * The request is ~550 characters of JSON at its widest — a 66-character job id, a
 * 108-character wrap, a 132-character signature and four short fields. 2 KiB is
 * generous and still three orders of magnitude below the app default, which
 * matters on a door that needs no session and is therefore open to the internet.
 */
export const RELEASE_BODY_LIMIT_BYTES = 2048;


/** The escrow's refusals, each one of P13's nine frozen codes, in one table. */
const staleIssuedAt = (detail: string) =>
  new ApiError(400, "invalid_request", detail, "issued_at", "stale_issued_at");

const badContainer = (detail: string, param: string) =>
  new ApiError(400, "invalid_request", detail, param, "bad_container");

const wrapMismatch = (detail: string) =>
  new ApiError(400, "invalid_request", detail, "seed_wrap", "wrap_mismatch");

/**
 * One answer for "your signature does not recover" and "the wallet it recovers to
 * is not the claimant", deliberately.
 *
 * Splitting them would tell an unauthorised caller which half it got right, and
 * the half it got right is the half that names the provider holding the claim.
 */
const wrongWallet = (detail: string) =>
  new ApiError(403, "authentication", detail, "signature", "wrong_wallet");

export interface ReleaseRequest {
  jobId: Hex;
  seedWrap: Buffer;
  ctHash: Buffer;
  responsePubkey: Buffer;
  issuedAt: bigint;
  signature: Hex;
}

/**
 * The first three rungs of the ladder, in order, plus the shape checks the
 * signature recovery needs.
 *
 * **The parse order is the check order, and that is part of the contract.** The
 * cheap checks run first so a griefer costs this node one keccak rather than two
 * `eth_call`s, and — the half that is a security property rather than a cost one —
 * *nothing that touches the chain runs before the signature verifies*, so no
 * caller can use this door as an oracle for whether a job exists or who holds its
 * claim.
 */
/**
 * The `/release` body, by shape. The codes are the contract a provider daemon
 * branches on: a malformed container piece is `bad_container`, and a signature
 * that cannot even be parsed is answered as one that does not recover —
 * `403 wrong_wallet` — for the reason {@link wrongWallet} gives.
 */
export const ReleaseBody = Type.Object({
  job_id: Hex32(),
  // No payload bytes: the ciphertext lives in object storage and may be
  // gigabytes; the commitment only ever sees its digest.
  seed_wrap: Base64(SEED_WRAP_BYTES, {
    minLength: 4 * Math.ceil(SEED_WRAP_BYTES / 3),
    description: `The container's ${SEED_WRAP_BYTES}-byte seed wrap, base64.`,
    error: {
      code: "bad_container",
      message: `must be canonical padded base64 of exactly ${SEED_WRAP_BYTES} bytes`,
    },
  }),
  ct_hash: Hex32({
    description: "keccak256 of the ciphertext.",
    error: { code: "bad_container", message: "must be a 0x-prefixed 32-byte keccak256 digest" },
  }),
  response_pubkey: HexBare32({
    description: "The X25519 key the DEK is sealed back to.",
    error: { message: "must be 64 hex characters — a 32-byte X25519 public key, no 0x prefix" },
  }),
  issued_at: SafeUint({ description: "Unix seconds, within ±600 s of this node's clock." }),
  signature: Type.String({
    pattern: "^0x([0-9a-fA-F]{2})*$",
    description: "The claimant's EIP-712 `Release` signature.",
    "x-vorq-error": {
      status: 403,
      type: "authentication",
      code: "wrong_wallet",
      message: "must be 0x-prefixed hex",
    },
  }),
});
export type ReleaseBody = Static<typeof ReleaseBody>;

export function parseRelease(fields: ReleaseBody, nowSeconds: number): ReleaseRequest {
  // 1. `issued_at`, ±600 s. First because it needs nothing but a clock.
  const issuedAt = BigInt(fields.issued_at);
  const skew = Number(issuedAt) - nowSeconds;
  if (Math.abs(skew) > RELEASE_SKEW_SECONDS) {
    throw staleIssuedAt(
      `issued_at is ${Math.abs(skew)} s from this node's clock, and a release request is ` +
        `accepted within ${RELEASE_SKEW_SECONDS} s either way`,
    );
  }

  // 2. The container's two pieces, by shape. No payload bytes are needed — the
  //    ciphertext lives in object storage and may be gigabytes; the commitment
  //    only ever sees its digest.
  // Exact, not bounded: the schema fixes the encoded length, and extra padding
  // can still decode short.
  const seedWrap = Buffer.from(fields.seed_wrap, "base64");
  if (seedWrap.length !== SEED_WRAP_BYTES) {
    throw badContainer(
      `a container v1 seed_wrap is ${SEED_WRAP_BYTES} bytes, and this one is ${seedWrap.length}`,
      "seed_wrap",
    );
  }
  const ctHash = Buffer.from(fields.ct_hash.slice(2), "hex");

  // 3. The job id, by shape. There is no weld here any more (C1): the pre-check
  //    that used to run at this point re-derived `keccak256(owner ‖ c)` from the
  //    body's **own** owner, which is a check over data the caller supplies — and
  //    P4 is the proof that no such check authorises anything, because the
  //    container is public and any predicate an attacker can read, an attacker
  //    can satisfy. The authorisation is the same commitment re-checked against
  //    the chain's own `c` in `release`, below.
  return {
    jobId: fields.job_id.toLowerCase() as Hex,
    seedWrap,
    ctHash,
    responsePubkey: Buffer.from(fields.response_pubkey.toLowerCase(), "hex"),
    issuedAt,
    signature: fields.signature as Hex,
  };
}

/** What `/release` is handed, once the mode gate and the chain gate have passed. */
export interface ReleaseDeps {
  /**
   * The key set. **{@link EscrowKeys}, not `KeyManager`**: this path calls
   * `tryUnseal` and nothing else, and a node whose keys are derived from its
   * operator credential serves this door exactly as a minting one does.
   */
  keys: EscrowKeys;
  chain: Chain;
  config: Config;
  /** This node's clock, in milliseconds. Injected so the ±600 s bound is testable. */
  nowMs: number;
  /** Task 5/6's marker, or `null` on a node that has none. Absent = not orphaned. */
  keyEpochStart: KeyEpochStart | null;
}

/** `{ "dek_sealed": "<b64 80 bytes>" }` — ~100 bytes out; the ciphertext never transits. */
export interface ReleaseResponse {
  dek_sealed: string;
}

/**
 * The whole policy, rung by rung.
 *
 * Rungs 1–3 and the shape checks are {@link parseRelease}'s; 4–7 are here,
 * because each one costs something the ones before it do not.
 */
export async function release(deps: ReleaseDeps, body: ReleaseBody): Promise<ReleaseResponse> {
  const { chain, config, keys } = deps;
  const request = parseRelease(body, Math.floor(deps.nowMs / 1000));

  // 4. Recover the signer. **Before any chain read**, so a caller whose signature
  //    does not verify learns nothing about this job's claim state.
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      domain: releaseDomain(config.addresses.chainId),
      types: RELEASE_TYPES,
      primaryType: "Release",
      message: {
        jobId: request.jobId,
        seedWrap: `0x${request.seedWrap.toString("hex")}` as Hex,
        ctHash: `0x${request.ctHash.toString("hex")}` as Hex,
        responsePubkey: `0x${request.responsePubkey.toString("hex")}` as Hex,
        issuedAt: request.issuedAt,
      },
      signature: request.signature,
    });
  } catch {
    throw wrongWallet("the release signature is malformed or was signed over another domain");
  }

  // 5. The chain's own account of this job, at the node's floor (P18): never a
  //    trailing tag, and never a load-balanced node that has yet to see the
  //    claim this node just relayed — see `atFloor`.
  const view = await getJob(chain, config.addresses.jobRegistry, request.jobId);
  if (!view.found) {
    throw new ApiError(
      404,
      "not_found",
      "the chain has no job with this id, so nothing has been claimed and no DEK is owed",
      "job_id",
      "no_claim",
    );
  }
  if (Number(view.state) !== JOB_STATE_CLAIMED) {
    throw new ApiError(
      409,
      "invalid_request",
      `this job is in state ${Number(view.state)}; a DEK is released only while it is claimed ` +
        `(state ${JOB_STATE_CLAIMED})`,
      "job_id",
      "not_claimed",
    );
  }

  // 5b. **The authorisation weld over what the caller supplied** (P4). `view.c`
  //     is the commitment the chain holds for this job, so a wrap that does not
  //     reproduce it is not this job's wrap — whatever the body said. C1 removed
  //     the body's `owner`, so the wrap and the ct hash are the only
  //     caller-supplied pieces left for a weld to check. It is **not** the only
  //     weld: the owner the KDF derives under is guarded separately, by the
  //     chain-side check immediately below, which R3 keeps for that reason.
  if (commitment(request.seedWrap, request.ctHash).toLowerCase() !== view.c.toLowerCase()) {
    throw wrapMismatch(
      "this seed_wrap and ct_hash do not reproduce the commitment the chain holds for this job",
    );
  }
  // The registry derives `jobId` from `owner ‖ c` on post, so this cannot fail
  // against a healthy contract. It is checked anyway because the *next* thing
  // that happens is deriving key material under `view.owner`: an owner that does
  // not reproduce the id would be an owner this job's client never committed to,
  // and deriving under it would hand back a key nobody can use while looking
  // exactly like success.
  if (jobIdFor(view.owner as Address, view.c).toLowerCase() !== request.jobId.toLowerCase()) {
    throw wrapMismatch(
      "the chain's own owner and commitment for this job do not reproduce its id",
    );
  }

  // 6. Identity, by **id** and never by address: an operator may be rotated, and
  //    the registry id is what survives it.
  const signerId = await idOf(chain, config.addresses.providerRegistry, signer as Address);
  if (signerId === 0n || signerId !== BigInt(view.providerId)) {
    throw wrongWallet(
      "the wallet that signed this request does not hold the provider registration that " +
        "claimed this job",
    );
  }

  // 7. The seed, the derivation and the response — in a function that has no
  //    request in scope at all (P4, S1). C1 removed the body's `owner`, so there
  //    is no longer a second candidate identity to derive under; `releaseUnder`
  //    keeps its narrow signature anyway, because the property worth holding is
  //    not "the body's owner is unused" but "nothing a caller supplies can reach
  //    the KDF", and that stays true whatever the next field added to this body
  //    turns out to be. The weld at the `jobIdFor` check above invites its own
  //    removal ("cannot fail against a healthy contract"); the day somebody
  //    accepts that invitation, this signature is still the thing standing there.
  return releaseUnder(keys, view, request.seedWrap, request.responsePubkey, deps.keyEpochStart);
}

/**
 * Trial-unseal, derive, and seal to the recipient — **under the chain's owner,
 * which is the only owner this function can see**.
 *
 * The parameters are deliberately narrow: a `JobView` read from the chain, the
 * wrap, and the recipient key. There is no request here, so there is no
 * request-supplied identity to derive under, and reaching for one is a change to
 * this signature rather than a one-word slip inside a hundred-line function.
 * C1 removed the body's `owner`, which makes the point moot today and is exactly
 * why the shape is kept: the guarantee is about the *signature*, not about which
 * fields happen to be on the wire this quarter.
 */
function releaseUnder(
  keys: EscrowKeys,
  view: JobView,
  wrap: Buffer,
  responsePubkey: Buffer,
  keyEpochStart: KeyEpochStart | null,
): ReleaseResponse {
  const unsealed = keys.tryUnseal(wrap);
  if (unsealed === null) {
    if (isEscrowOrphan(view, keyEpochStart)) {
      throw new ApiError(
        410,
        "not_found",
        "this job was posted before this escrow's current key custody began and is not " +
          "designated, so its seed_wrap was sealed to a generation no live instance holds. It " +
          "cannot be worked; fail it inside the grace window and no penalty applies.",
        "job_id",
        "escrow_key_lost",
      );
    }
    throw new ApiError(
      400,
      "invalid_request",
      "no generation this escrow holds opens this seed_wrap: it was sealed to a key that is not " +
        "this escrow's",
      "seed_wrap",
      "unseal_failed",
    );
  }

  // **The seed is not the DEK.** `tryUnseal` returns the sealed-box plaintext,
  // which under P4's mechanism is a 32-byte seed; the working key is derived from
  // it and the job's chain-read owner. See this module's header for why.
  const dek = deriveDek(unsealed.seed, view.owner as Address);
  return { dek_sealed: sealDek(dek, responsePubkey).toString("base64") };
}
