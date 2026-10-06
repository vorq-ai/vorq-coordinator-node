import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, getAddress, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { JobView } from "../src/chain/client.js";
import type { Address, Config } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import {
  DEK_BYTES,
  SEED_BYTES,
  commitment,
  escrowKeypairFromOperatorKey,
  jobIdFor,
  newRecipientKeypair,
  openDek,
  sealDek,
} from "../src/escrow/container.js";
import { ESCROW_SWEEP_INTERVAL_MS, KeyManager, type EscrowKeys } from "../src/escrow/keys.js";
import { StaticKeyManager } from "../src/escrow/static-keys.js";
import {
  DEK_HKDF_SALT,
  DEK_INFO_PREFIX,
  RELEASE_BODY_LIMIT_BYTES,
  RELEASE_SKEW_SECONDS,
  RELEASE_TYPES,
  deriveDek,
  isEscrowOrphan,
  releaseDomain,
  type KeyEpochStart,
} from "../src/escrow/release.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import {
  ADDRESSES,
  bareRevert,
  refusedCall,
  stubChain,
  testConfig,
  unreachableEndpoint,
} from "./support/stub-chain.js";

/**
 * `POST /release` — the key oracle, its verification ladder, and the wrap-lifting
 * attack P4 exists to close.
 *
 * Unit project: no database, no chain, no network. The chain reads go through
 * viem and the ABI against `test/support/stub-chain.ts`, and the database handed
 * to every app here **throws on any query** — which is P7 asserted by
 * construction rather than by a stub that would have answered. Task 7 forges a
 * `Claimed` row in Postgres and expects a refusal; the property that test checks
 * is the one this file's `hostileDb` makes impossible to violate at all.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A store that must never be reached (P7). Any query is the failure under test. */
const hostileDb = {
  query: async () => {
    throw new Error("/release must not read the store (P7)");
  },
} as unknown as Db;

const indexerReporting = (status: IndexerStatus): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async () => status,
  start: async () => undefined,
  stop: async () => undefined,
});

const READY = indexerReporting({ cursor: 100n, head: 100n, ready: true, forked: null });
const CATCHING_UP = indexerReporting({ cursor: 5n, head: 900n, ready: false, forked: null });

const escrowConfig = (overrides: Partial<Config["escrow"]> = {}): Config =>
  testConfig({
    escrow: { mode: "mock", releaseOrdinal: 1, sweepIntervalMs: ESCROW_SWEEP_INTERVAL_MS, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0, ...overrides },
    match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
    jobRateLimit: 0,
  });

const NOW_SECONDS = 1_790_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ZERO_ADDRESS = getAddress(`0x${"00".repeat(20)}`) as Address;

/** Two wallets that own orders, and two that operate providers. Never credentials. */
const wallet = (byte: string): PrivateKeyAccount =>
  privateKeyToAccount(`0x${byte.repeat(32)}` as Hex);

const VICTIM = wallet("a1");
const ATTACKER = wallet("b2");
const HONEST_OPERATOR = wallet("c3");
const ROTATED_OPERATOR = wallet("c4");
const OTHER_OPERATOR = wallet("d5");

const HONEST_PROVIDER_ID = 7;
const ATTACKER_PROVIDER_ID = 9;

/** A `getJob` answer, defaulted to a live claimed job so each test states one thing. */
const jobView = (over: Partial<JobView>): JobView =>
  ({
    found: true,
    jobId: ZERO32,
    owner: ZERO_ADDRESS,
    c: ZERO32,
    state: 1,
    endedBecause: 0,
    providerId: HONEST_PROVIDER_ID,
    designated: 0,
    modelId: 1,
    rateIn: 0n,
    rateOut: 0n,
    unitsIn: 0,
    unitsOut: 0,
    completionTok: 0,
    slaSecs: 3600,
    // Far past the epoch used below, so nothing is orphaned unless a test says so.
    expiresAt: BigInt(NOW_SECONDS + 86_400),
    claimedAt: BigInt(NOW_SECONDS - 60),
    taskCid: "0x",
    resultCid: "0x",
    gasFee: 0n,
    ...over,
  }) as unknown as JobView;

const MISSING_JOB = jobView({ found: false, state: 0, providerId: 0, expiresAt: 0n, claimedAt: 0n });

/**
 * A node with an escrow, a stubbed chain, and a hostile store.
 *
 * `jobs` and `providerIds` are the chain's whole answer: `getJob` and `idOf` are
 * *mappings*, so both are stubbed as functions of the decoded arguments.
 */
function escrowNode(options: {
  jobs?: Record<string, JobView>;
  providerIds?: Record<string, number>;
  indexer?: Indexer;
  config?: Config;
  keyEpochStart?: KeyEpochStart | null;
  keys?: EscrowKeys;
  /** The endpoint fails every `eth_call`, whichever read asks first. */
  callError?: () => unknown;
  /** One named view fails while the others answer, so a read can be isolated. */
  viewError?: { view: "getJob" | "idOf"; error: () => unknown };
} = {}) {
  const config = options.config ?? escrowConfig();
  const jobs = new Map(
    Object.entries(options.jobs ?? {}).map(([id, view]) => [id.toLowerCase(), view]),
  );
  const providerIds = new Map(
    Object.entries(options.providerIds ?? {}).map(([a, id]) => [a.toLowerCase(), id]),
  );
  const failing = (view: "getJob" | "idOf") =>
    options.viewError?.view === view ? options.viewError.error : null;

  const stub = stubChain(config, {
    ...(options.callError === undefined ? {} : { callError: options.callError }),
    views: {
      getJob: (args: readonly unknown[]) => {
        const fail = failing("getJob");
        if (fail !== null) throw fail();
        return jobs.get(String(args[0]).toLowerCase()) ?? MISSING_JOB;
      },
      idOf: (args: readonly unknown[]) => {
        const fail = failing("idOf");
        if (fail !== null) throw fail();
        return providerIds.get(String(args[0]).toLowerCase()) ?? 0;
      },
    },
  });

  let keys: EscrowKeys;
  if (options.keys !== undefined) {
    keys = options.keys;
  } else {
    const minted = new KeyManager();
    minted.boot();
    keys = minted;
  }

  const app = buildApp({
    db: hostileDb,
    indexer: options.indexer ?? READY,
    config,
    chain: stub.chain,
    escrowKeys: keys,
    escrowClock: () => NOW_MS,
    escrowKeyEpochStart: () => options.keyEpochStart ?? null,
  });

  return { app, keys, stub, config };
}

/**
 * One client-side container, built exactly as the client SDK must build it: seal
 * a **seed**, derive the working key from the seed and the order's own owner.
 */
function containerFor(owner: Address, escrowPublicKey: Buffer, plaintext = "the task") {
  const seed = randomBytes(SEED_BYTES);
  const seedWrap = sealDek(seed, escrowPublicKey);
  const dek = deriveDek(seed, owner);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([
    iv,
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const ctHash = keccak256(ciphertext as unknown as Uint8Array);
  const c = commitment(seedWrap, Buffer.from(ctHash.slice(2), "hex"));
  return { seed, dek, seedWrap, ciphertext, ctHash, c, jobId: jobIdFor(owner, c) };
}

/** Opens what a container committed to, or throws. The attacker's key must fail here. */
function openCiphertext(ciphertext: Buffer, dek: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", dek, ciphertext.subarray(0, 12));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(12, ciphertext.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

interface ReleaseBody {
  job_id: string;
  seed_wrap: string;
  ct_hash: string;
  response_pubkey: string;
  /** Unix seconds, a JSON integer. */
  issued_at: number;
  signature: string;
}

/** A signed `/release` request. Every field of the body but the signature is signed. */
async function signedRelease(
  operator: PrivateKeyAccount,
  fields: Omit<ReleaseBody, "signature">,
  chainId = ADDRESSES.chainId,
): Promise<ReleaseBody> {
  const signature = await operator.signTypedData({
    domain: releaseDomain(chainId),
    types: RELEASE_TYPES,
    primaryType: "Release",
    message: {
      jobId: fields.job_id as Hex,
      seedWrap: `0x${Buffer.from(fields.seed_wrap, "base64").toString("hex")}` as Hex,
      ctHash: fields.ct_hash as Hex,
      responsePubkey: `0x${fields.response_pubkey}` as Hex,
      issuedAt: BigInt(fields.issued_at),
    },
  });
  return { ...fields, signature };
}

const errorOf = (response: { json: () => unknown }) =>
  (response.json() as { error: { code: string; type: string; message: string } }).error;

// ---------------------------------------------------------------------------
// The happy path, end to end
// ---------------------------------------------------------------------------

describe("POST /release", () => {
  /** The whole round trip, from the client's seal to the provider's opened DEK. */
  async function happyPath() {
    const keys = new KeyManager();
    keys.boot();
    const escrowKey = keys.current();
    expect(escrowKey).not.toBeNull();

    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, escrowKey!.publicKey);
    const node = escrowNode({
      keys,
      jobs: {
        [container.jobId]: jobView({
          jobId: container.jobId,
          owner,
          c: container.c,
          state: 1,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    return { node, container, response, body, owner };
  }

  it("round-trips a DEK: sealed to the escrow key, released, opened with the response key", async () => {
    const { node, container, response, body } = await happyPath();

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);

    const sealed = Buffer.from(
      (answer.json() as { dek_sealed: string }).dek_sealed,
      "base64",
    );
    // ~100 bytes out, and the ciphertext never transits.
    expect(sealed).toHaveLength(80);

    const dek = openDek(sealed, response.publicKey, response.secretKey);
    expect(dek).toHaveLength(DEK_BYTES);
    // Not merely "some 32 bytes": the key the client encrypted under.
    expect(dek.equals(container.dek)).toBe(true);
    expect(openCiphertext(container.ciphertext, dek)).toBe("the task");
  });

  it("reads the chain at the node's floor and never touches the store (P7, P18)", async () => {
    const { node, body } = await happyPath();
    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);

    const calls = node.stub.requests.filter((request) => request.method === "eth_call");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // P18: authorisation sees the chain as it is now, never at a trailing tag —
    // a provider that claimed seconds ago must not be refused its own DEK for
    // the lag. Before this node has a receipt or a head poll, "now" is `latest`.
    for (const call of calls) expect((call.params as unknown[])[1]).toBe("latest");
    // P7's other half: `hostileDb` throws on any query, so a 200 is the proof.

    // Once the node holds proof of a block — here, the receipt of the claim it
    // just relayed — the read is pinned there, so a load-balanced node that has
    // not seen that block yet cannot answer the pre-claim state (`atFloor`).
    node.stub.chain.saw(1234n);
    node.stub.requests.length = 0;
    const pinned = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(pinned.statusCode).toBe(200);
    const jobReads = node.stub.requests.filter((request) => request.method === "eth_call");
    expect(jobReads.length).toBeGreaterThanOrEqual(1);
    expect((jobReads[0]?.params as unknown[])[1]).toBe("0x4d2");
  });

  it("is idempotent by construction: a replay re-derives and re-delivers", async () => {
    const { node, container, response, body } = await happyPath();

    const first = await node.app.inject({ method: "POST", url: "/release", payload: body });
    const second = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const sealedOf = (r: typeof first) =>
      Buffer.from((r.json() as { dek_sealed: string }).dek_sealed, "base64");
    // A sealed box is anonymous and randomised, so the *bytes* differ — release
    // is not a cache, and identical bytes would mean the node had remembered
    // something. Release-once is the chain's claim state, never this node's memory.
    expect(sealedOf(first).equals(sealedOf(second))).toBe(false);

    // The replayed request carries the **original** `response_pubkey`, because
    // the pubkey is inside the signature. So the second answer is deliverable
    // only to the party that made the first — harmless by construction.
    for (const answer of [first, second]) {
      const dek = openDek(sealedOf(answer), response.publicKey, response.secretKey);
      expect(dek.equals(container.dek)).toBe(true);
    }
  });

  it("still releases after an operator rotation, because identity is the id", async () => {
    const { node, container, response, owner } = await happyPath();
    // The wallet that signs is a different address; `idOf` maps it to the same
    // registry id. Address equality would refuse this; id equality is the rule.
    const body = await signedRelease(ROTATED_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    const rotated = escrowNode({
      keys: node.keys,
      jobs: {
        [container.jobId]: jobView({
          jobId: container.jobId,
          owner,
          c: container.c,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [ROTATED_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const answer = await rotated.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);
    const dek = openDek(
      Buffer.from((answer.json() as { dek_sealed: string }).dek_sealed, "base64"),
      response.publicKey,
      response.secretKey,
    );
    expect(dek.equals(container.dek)).toBe(true);
  });

  /**
   * The per-route `bodyLimit`, asserted rather than assumed.
   *
   * This door carries no session, so it is open to the internet, and `bodyLimit`
   * is the **only** bound that acts before Fastify allocates and `JSON.parse`s
   * the body — every field check in `release.ts` runs on bytes that have already
   * been read. The body below is byte-for-byte the one the happy path releases
   * on, plus a padding field: the *only* difference between the 413 and the 200
   * is size, which is what makes this an assertion about the limit and not about
   * the content.
   *
   * Deleting `{ bodyLimit: RELEASE_BODY_LIMIT_BYTES }` at `src/api/escrow.ts`
   * makes this padded body **accepted** — the app-wide 1 MiB inherits, the
   * unknown field is ignored, and the door answers 200. The `toBeLessThan` below
   * states that fail-open direction as an assertion: this payload is one the
   * app-wide limit would take, so a green 413 can only come from the per-route
   * limit still being there.
   */
  it("refuses a body past this door's own limit, not the app-wide one", async () => {
    const { node, body } = await happyPath();

    const padded = JSON.stringify({ ...body, padding: "x".repeat(RELEASE_BODY_LIMIT_BYTES) });
    // Well inside the app-wide 1 MiB: only the per-route limit can refuse this.
    expect(padded.length).toBeGreaterThan(RELEASE_BODY_LIMIT_BYTES);
    expect(padded.length).toBeLessThan(1024 * 1024);

    const answer = await node.app.inject({
      method: "POST",
      url: "/release",
      headers: { "content-type": "application/json" },
      payload: padded,
    });

    expect(answer.statusCode).toBe(413);
    // The frozen envelope, not a bare Fastify 413 and not a 500: a caller told
    // "internal error" for its own oversized body would retry it.
    expect(errorOf(answer).type).toBe("invalid_request_error");
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
    // Refused before the body was read, so before any authorisation read.
    expect(node.stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);

    // The control, on the same node: the identical body without the padding is
    // released. The refusal above is the size and nothing else.
    const unpadded = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(unpadded.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P4 — the wrap-lifting attack, which is the acceptance test
// ---------------------------------------------------------------------------

describe("P4: a wrap lifted onto an attacker's own claimed order", () => {
  /**
   * The attack, built exactly as the finding describes it and with **every**
   * check of the ladder satisfied:
   *
   *   * containers are publicly fetchable by CID, so the attacker holds the
   *     victim's `seed_wrap` `W`;
   *   * the attacker picks any `ct_hash` and computes `c' = keccak256(TAG ‖ W ‖ ct')`;
   *   * the attacker posts a dust order under **its own** address, minting
   *     `job_id' = keccak256(attacker ‖ c')` — so the chain-read owner is
   *     genuinely the attacker and the weld is self-consistent;
   *   * the attacker claims it with a genuinely registered provider wallet.
   *
   * Nothing in the request is forged, so nothing in the request can be refused.
   * The defence is in the **derivation**: the sealed 32 bytes are a seed, and the
   * working key is `HKDF(seed, info = "vorq-dek" ‖ chain-read owner)`. The
   * attacker's release derives under the attacker's owner and is therefore not
   * the key the victim's ciphertext was encrypted under.
   */
  async function theAttack() {
    const keys = new KeyManager();
    keys.boot();
    const escrowKey = keys.current()!;

    const victimOwner = getAddress(VICTIM.address) as Address;
    const attackerOwner = getAddress(ATTACKER.address) as Address;

    const victim = containerFor(victimOwner, escrowKey.publicKey, "the victim's prompt");

    // The lifted wrap, over a ct_hash of the attacker's choosing — a `c` nobody
    // has spent, so on-chain `c` uniqueness would not see it either.
    const liftedCtHash = keccak256(Buffer.from("anything at all", "utf8") as unknown as Uint8Array);
    const liftedC = commitment(victim.seedWrap, Buffer.from(liftedCtHash.slice(2), "hex"));
    const liftedJobId = jobIdFor(attackerOwner, liftedC);

    const node = escrowNode({
      keys,
      jobs: {
        [victim.jobId]: jobView({
          jobId: victim.jobId,
          owner: victimOwner,
          c: victim.c,
          providerId: HONEST_PROVIDER_ID,
        }),
        // Genuinely Claimed, by a genuinely registered provider, at cap = 1.
        [liftedJobId]: jobView({
          jobId: liftedJobId,
          owner: attackerOwner,
          c: liftedC,
          providerId: ATTACKER_PROVIDER_ID,
        }),
      },
      providerIds: {
        [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID,
        [OTHER_OPERATOR.address]: ATTACKER_PROVIDER_ID,
      },
    });

    const attackerResponse = newRecipientKeypair();
    const attackBody = await signedRelease(OTHER_OPERATOR, {
      job_id: liftedJobId,
      seed_wrap: victim.seedWrap.toString("base64"),
      ct_hash: liftedCtHash,
      response_pubkey: attackerResponse.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    return { node, victim, attackerOwner, attackBody, attackerResponse };
  }

  it("does not yield the victim's DEK", async () => {
    const { node, victim, attackBody, attackerResponse } = await theAttack();

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: attackBody });

    // Every field is honest and every identity is the attacker's own, so there is
    // nothing here a check over public data could refuse — the container is
    // public, so any predicate an attacker can read, an attacker can satisfy.
    // What the attacker receives is a key derived under its own owner.
    expect(answer.statusCode).toBe(200);
    const got = openDek(
      Buffer.from((answer.json() as { dek_sealed: string }).dek_sealed, "base64"),
      attackerResponse.publicKey,
      attackerResponse.secretKey,
    );

    // The bytes are not the victim's DEK...
    expect(got.equals(victim.dek)).toBe(false);
    // ...and, which is the objective the attack actually has, they do not open
    // the victim's ciphertext.
    expect(() => openCiphertext(victim.ciphertext, got)).toThrow();
  });

  it("is not an accidental failure: the legitimate job releases the victim's DEK", async () => {
    const { node, victim } = await theAttack();

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: victim.jobId,
      seed_wrap: victim.seedWrap.toString("base64"),
      ct_hash: victim.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);

    const dek = openDek(
      Buffer.from((answer.json() as { dek_sealed: string }).dek_sealed, "base64"),
      response.publicKey,
      response.secretKey,
    );
    expect(dek.equals(victim.dek)).toBe(true);
    expect(openCiphertext(victim.ciphertext, dek)).toBe("the victim's prompt");
  });

  /**
   * **The weld that decides the KDF's owner input, and the only one left** (S1).
   *
   * C1 removed the body's `owner`, so `parseRelease`'s pre-check weld and the
   * refusal it produced are gone: there is no caller-supplied identity left to
   * disagree with the chain. What remains is this — the chain's own answer
   * checked for self-consistency before a single byte of key material moves.
   * `releaseUnder` still takes a narrow signature and still cannot see a
   * request, and that is not redundancy: the day somebody accepts the invitation
   * in the comment above `jobIdFor` ("cannot fail against a healthy contract"),
   * there must still be no way for anything but `view.owner` to reach the KDF.
   */
  it("refuses to derive under a chain answer that does not reproduce the job id", async () => {
    // The chain's weld is now the only one, and it holds by collision resistance
    // — **as long as the chain's own answer is self-consistent.** This is the
    // case where it is not: `getJob` reports an
    // owner that does not reproduce the id it was asked about. Deriving under it
    // would hand back a key nobody can use while looking exactly like success,
    // so the last thing this door does before touching key material is check that
    // the identity it is about to derive under is the one welded into the id.
    const keys = new KeyManager();
    keys.boot();
    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, keys.current()!.publicKey);

    const node = escrowNode({
      keys,
      jobs: {
        [container.jobId]: jobView({
          jobId: container.jobId,
          // The commitment is this job's, so rung 5b's first half passes...
          c: container.c,
          // ...and the owner is somebody else's, so its second half does not.
          owner: getAddress(ATTACKER.address) as Address,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer).code).toBe("wrap_mismatch");
  });
});

// ---------------------------------------------------------------------------
// The KDF itself
// ---------------------------------------------------------------------------

const VECTORS_PATH = fileURLToPath(new URL("./vectors/container-v1.json", import.meta.url));
const kdfVector = (
  JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
    kdf: { info_prefix: string; salt: string; seed: string; owner: string; dek: string };
  }
).kdf;

describe("the DEK derivation (P4's mechanism, P10's KDF)", () => {
  const seed = Buffer.alloc(SEED_BYTES, 0x5a);
  const a = getAddress(VICTIM.address) as Address;
  const b = getAddress(ATTACKER.address) as Address;

  it("is HKDF-SHA256 over the stated IKM, salt and info", () => {
    // Recomputed here from the primitive rather than from the module's own
    // helper: an unspecified KDF is how two implementations silently disagree,
    // so the inputs are pinned as arithmetic a second implementation can copy.
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        seed,
        Buffer.alloc(0),
        Buffer.concat([Buffer.from("vorq-dek", "utf8"), Buffer.from(a.slice(2), "hex")]),
        32,
      ),
    );
    expect(deriveDek(seed, a).equals(expected)).toBe(true);
    expect(DEK_INFO_PREFIX.toString("utf8")).toBe("vorq-dek");
    expect(DEK_INFO_PREFIX).toHaveLength(8);
    // Salt is explicitly zero-length; RFC 5869 §2.2 substitutes HashLen zeros.
    expect(DEK_HKDF_SALT).toHaveLength(0);
  });

  it("agrees with the vectors file's kdf block, which both SDKs read (R6)", () => {
    // The recompute above proves this node's KDF is the one it documents. This
    // proves the *cross-language* artifact says the same thing — one value, one
    // source, three readers. Both are kept: a recomputed answer and a pinned one
    // fail for different reasons, and losing either loses a real signal.
    expect(kdfVector.info_prefix).toBe("vorq-dek");
    expect(kdfVector.salt).toBe("0x");

    const vectorSeed = Buffer.from(kdfVector.seed.slice(2), "hex");
    const vectorOwner = kdfVector.owner as Address;
    expect(vectorSeed).toHaveLength(SEED_BYTES);

    // The file's own answer, from the primitive, with nothing of this module in
    // the path — this is the arithmetic a Python implementation copies.
    const fromPrimitive = Buffer.from(
      hkdfSync(
        "sha256",
        vectorSeed,
        Buffer.alloc(0),
        Buffer.concat([
          Buffer.from(kdfVector.info_prefix, "utf8"),
          Buffer.from(vectorOwner.slice(2), "hex"),
        ]),
        32,
      ),
    );
    expect(`0x${fromPrimitive.toString("hex")}`).toBe(kdfVector.dek);

    // And the shipped helper reaches it too.
    expect(`0x${deriveDek(vectorSeed, vectorOwner).toString("hex")}`).toBe(kdfVector.dek);
  });

  it("is a different key under a different owner, and stable under the same one", () => {
    expect(deriveDek(seed, a).equals(deriveDek(seed, a))).toBe(true);
    expect(deriveDek(seed, a).equals(deriveDek(seed, b))).toBe(false);
    // Checksum casing is display-only: the owner enters the KDF as 20 raw bytes.
    expect(deriveDek(seed, a.toLowerCase() as Address).equals(deriveDek(seed, a))).toBe(true);
  });

  it("refuses a seed or an owner of the wrong width", () => {
    expect(() => deriveDek(Buffer.alloc(31, 1), a)).toThrow(/32/);
    expect(() => deriveDek(Buffer.alloc(33, 1), a)).toThrow(/32/);
    expect(() => deriveDek(seed, "0xdeadbeef" as Address)).toThrow(/20/);
  });

  it("keeps the wrap at 80 bytes, so container v1 is untouched", () => {
    const { publicKey } = newRecipientKeypair();
    expect(sealDek(Buffer.alloc(SEED_BYTES, 7), publicKey)).toHaveLength(80);
  });
});

// ---------------------------------------------------------------------------
// The verification ladder, refusal by refusal, in order
// ---------------------------------------------------------------------------

describe("the verification ladder", () => {
  /** The legitimate request, which each test below breaks in exactly one way. */
  async function fixture() {
    const keys = new KeyManager();
    keys.boot();
    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, keys.current()!.publicKey);
    const response = newRecipientKeypair();

    const jobs: Record<string, JobView> = {
      [container.jobId]: jobView({
        jobId: container.jobId,
        owner,
        c: container.c,
        providerId: HONEST_PROVIDER_ID,
      }),
    };

    const fields = {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    };

    return { keys, owner, container, response, jobs, fields };
  }

  it("1. refuses a clock outside ±600 s with stale_issued_at, before anything else", async () => {
    const { keys, jobs, fields } = await fixture();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    for (const issuedAt of [NOW_SECONDS - RELEASE_SKEW_SECONDS - 1, NOW_SECONDS + RELEASE_SKEW_SECONDS + 1]) {
      const body = await signedRelease(HONEST_OPERATOR, { ...fields, issued_at: Number(issuedAt) });
      const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
      expect(answer.statusCode).toBe(400);
      expect(errorOf(answer).code).toBe("stale_issued_at");
    }

    // The cheapest check runs first: nothing was asked of the chain.
    expect(node.stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);

    // And the boundary is inclusive on both sides.
    for (const issuedAt of [NOW_SECONDS - RELEASE_SKEW_SECONDS, NOW_SECONDS + RELEASE_SKEW_SECONDS]) {
      const body = await signedRelease(HONEST_OPERATOR, { ...fields, issued_at: Number(issuedAt) });
      const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
      expect(answer.statusCode).toBe(200);
    }
  });

  it("2. refuses a truncated wrap or a malformed ct_hash with bad_container", async () => {
    const { keys, jobs, fields, container } = await fixture();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const truncated = await signedRelease(HONEST_OPERATOR, {
      ...fields,
      seed_wrap: container.seedWrap.subarray(0, 79).toString("base64"),
    });
    const short = await node.app.inject({ method: "POST", url: "/release", payload: truncated });
    expect(short.statusCode).toBe(400);
    expect(errorOf(short).code).toBe("bad_container");

    const long = await signedRelease(HONEST_OPERATOR, {
      ...fields,
      seed_wrap: Buffer.concat([container.seedWrap, Buffer.alloc(1)]).toString("base64"),
    });
    const wide = await node.app.inject({ method: "POST", url: "/release", payload: long });
    expect(wide.statusCode).toBe(400);
    expect(errorOf(wide).code).toBe("bad_container");

    // Signed with a placeholder: a 4-byte `ct_hash` is not a signable `bytes32`
    // either, which is itself the point — the shape is refused before anything
    // tries to interpret it.
    const signed = await signedRelease(HONEST_OPERATOR, fields);
    const hash = await node.app.inject({
      method: "POST",
      url: "/release",
      payload: { ...signed, ct_hash: "0xdeadbeef" },
    });
    expect(hash.statusCode).toBe(400);
    expect(errorOf(hash).code).toBe("bad_container");

    // Still nothing asked of the chain — ~150 bytes in, no payload, no eth_call.
    expect(node.stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });

  it("3. refuses a wrap lifted from another order with wrap_mismatch, at the chain's own c", async () => {
    const { keys, jobs, fields, owner } = await fixture();
    // A different client's wrap over this order's job id: `c` covers the wrap, so
    // the commitment the chain holds for this job is not the one these two pieces
    // reproduce.
    const other = containerFor(owner, keys.current()!.publicKey, "someone else's task");

    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const body = await signedRelease(HONEST_OPERATOR, {
      ...fields,
      seed_wrap: other.seedWrap.toString("base64"),
    });
    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer).code).toBe("wrap_mismatch");

    // **This costs a chain read now, and that is the change C1 made.** The old
    // parse-time weld refused here for free by re-deriving `jobId` from the
    // *body's* owner — a check over data the caller supplies, which P4 already
    // proved cannot authorise anything. One producer of `wrap_mismatch` was
    // deleted; the two that read the chain remain, and this is the first of them.
    expect(node.stub.requests.filter((r) => r.method === "eth_call").length).toBeGreaterThanOrEqual(1);
  });

  it("4. refuses a malformed or foreign signature with wrong_wallet, and leaks no claim state", async () => {
    const { keys, jobs, fields } = await fixture();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const malformed = await node.app.inject({
      method: "POST",
      url: "/release",
      payload: { ...fields, signature: "0xnotasignature" },
    });
    expect(malformed.statusCode).toBe(403);
    expect(errorOf(malformed).code).toBe("wrong_wallet");

    // Well-formed hex, 65 bytes, and still unrecoverable — `r = 0` is outside the
    // curve order. This is the case that reaches the recovery and fails *inside*
    // it, which is the only way to observe that rung 4 really does run before
    // rung 5 rather than merely being written above it.
    const unrecoverable = await node.app.inject({
      method: "POST",
      url: "/release",
      payload: { ...fields, signature: `0x${"00".repeat(65)}` },
    });
    expect(unrecoverable.statusCode).toBe(403);
    expect(errorOf(unrecoverable).code).toBe("wrong_wallet");

    // **Nothing leaked**: the recovery precedes every chain read, so a request
    // this node cannot recover an address from costs it no `eth_call` and tells
    // its sender nothing about whether this job exists or who claimed it.
    expect(node.stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);

    // A well-formed signature over a **different domain** — a release signed for
    // another deployment, or a captured session handshake — recovers, as any
    // well-formed ECDSA signature must, but to an unrelated address. So it is
    // refused at the identity rung with the same code, which is the point of
    // giving both halves one code: the answer does not say which half was wrong.
    const wrongDomain = await signedRelease(HONEST_OPERATOR, fields, ADDRESSES.chainId + 1);
    const foreign = await node.app.inject({
      method: "POST",
      url: "/release",
      payload: wrongDomain,
    });
    expect(foreign.statusCode).toBe(403);
    expect(errorOf(foreign).code).toBe("wrong_wallet");
  });

  it("5. refuses an unknown job with no_claim and a job in any other state with not_claimed", async () => {
    const { keys, fields, owner, container } = await fixture();

    const unknown = escrowNode({
      keys,
      jobs: {},
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });
    const body = await signedRelease(HONEST_OPERATOR, fields);
    const missing = await unknown.app.inject({ method: "POST", url: "/release", payload: body });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe("no_claim");

    // Cancelled (state 3), and Open (state 0) — a job nobody has claimed is not a
    // job whose DEK anyone may have.
    for (const state of [0, 2, 3]) {
      const node = escrowNode({
        keys,
        jobs: {
          [container.jobId]: jobView({
            jobId: container.jobId,
            owner,
            c: container.c,
            state,
            providerId: state === 0 ? 0 : HONEST_PROVIDER_ID,
          }),
        },
        providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      });
      const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
      expect(answer.statusCode).toBe(409);
      expect(errorOf(answer).code).toBe("not_claimed");
    }
  });

  it("6. refuses a signer whose provider id is not the claimant, with wrong_wallet", async () => {
    const { keys, jobs, fields } = await fixture();
    const node = escrowNode({
      keys,
      jobs,
      // Registered, and a real provider — just not the one holding this claim.
      providerIds: { [OTHER_OPERATOR.address]: ATTACKER_PROVIDER_ID },
    });

    const body = await signedRelease(OTHER_OPERATOR, fields);
    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(403);
    expect(errorOf(answer).code).toBe("wrong_wallet");

    // An unregistered signer (`idOf` = 0) is refused the same way, and never
    // matches a `providerId` of 0.
    const stranger = escrowNode({ keys, jobs, providerIds: {} });
    const strangerAnswer = await stranger.app.inject({
      method: "POST",
      url: "/release",
      payload: await signedRelease(ROTATED_OPERATOR, fields),
    });
    expect(strangerAnswer.statusCode).toBe(403);
    expect(errorOf(strangerAnswer).code).toBe("wrong_wallet");
  });

  it("7. refuses a wrap sealed to a key this node never held, with unseal_failed", async () => {
    const { keys, owner } = await fixture();
    // A junk wrap: well formed, 80 bytes, sealed to a random recipient. The job
    // is welded to it and genuinely claimed, so only the unseal can refuse.
    const stranger = newRecipientKeypair();
    const junk = containerFor(owner, stranger.publicKey);

    const node = escrowNode({
      keys,
      jobs: {
        [junk.jobId]: jobView({
          jobId: junk.jobId,
          owner,
          c: junk.c,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: junk.jobId,
      seed_wrap: junk.seedWrap.toString("base64"),
      ct_hash: junk.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer).code).toBe("unseal_failed");
  });
});

// ---------------------------------------------------------------------------
// P7 / P15 — `escrow_key_lost`, per job, chain-only, one-sided
// ---------------------------------------------------------------------------

describe("escrow_key_lost is per-job and derived from the chain alone (P7, P15)", () => {
  /** A junk-to-this-node wrap on an undesignated job that expired before the epoch. */
  async function orphanFixture(over: { designated?: number; expiresAt?: bigint } = {}) {
    const keys = new KeyManager();
    keys.boot();
    const owner = getAddress(VICTIM.address) as Address;
    // Sealed to a generation this node does not hold — which is what key loss
    // looks like from inside the process: the bytes are fine, nothing opens them.
    const lost = containerFor(owner, newRecipientKeypair().publicKey);

    const jobs = {
      [lost.jobId]: jobView({
        jobId: lost.jobId,
        owner,
        c: lost.c,
        providerId: HONEST_PROVIDER_ID,
        designated: over.designated ?? 0,
        expiresAt: over.expiresAt ?? BigInt(NOW_SECONDS - 7_200),
      }),
    };

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: lost.jobId,
      seed_wrap: lost.seedWrap.toString("base64"),
      ct_hash: lost.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    return { keys, jobs, body };
  }

  /** This node's keys began an hour ago; anything expiring before that predates them. */
  const EPOCH: KeyEpochStart = { time: NOW_MS - 3_600_000, block: 900n };

  it("answers escrow_key_lost when the job provably predates this node's key epoch", async () => {
    const { keys, jobs, body } = await orphanFixture();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      keyEpochStart: EPOCH,
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(410);
    expect(errorOf(answer).code).toBe("escrow_key_lost");
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
  });

  it("answers unseal_failed, never escrow_key_lost, with no epoch at all", async () => {
    const { keys, jobs, body } = await orphanFixture();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      keyEpochStart: null,
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(400);
    expect(errorOf(answer).code).toBe("unseal_failed");
  });

  it("never calls a designated job orphaned — the escrow was never in its path", async () => {
    const { keys, jobs, body } = await orphanFixture({ designated: 4 });
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      keyEpochStart: EPOCH,
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(errorOf(answer).code).toBe("unseal_failed");
  });

  it("classifies the ambiguous band as unseal_failed, which is the one-sided direction", async () => {
    // A job that expires *after* the epoch began may have been posted either side
    // of it; `getJob` carries no posting block or time, so the honest answer is
    // the conservative one. The provider's escape is identical either way.
    const { keys, jobs, body } = await orphanFixture({ expiresAt: BigInt(NOW_SECONDS + 600) });
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      keyEpochStart: EPOCH,
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(errorOf(answer).code).toBe("unseal_failed");
  });

  it("is a pure predicate over chain state and the epoch", () => {
    const before = jobView({ designated: 0, expiresAt: BigInt(NOW_SECONDS - 7_200) });
    const after = jobView({ designated: 0, expiresAt: BigInt(NOW_SECONDS + 7_200) });
    const designated = jobView({ designated: 3, expiresAt: BigInt(NOW_SECONDS - 7_200) });

    expect(isEscrowOrphan(before, EPOCH)).toBe(true);
    expect(isEscrowOrphan(after, EPOCH)).toBe(false);
    expect(isEscrowOrphan(designated, EPOCH)).toBe(false);
    expect(isEscrowOrphan(before, null)).toBe(false);
    // Strict: an expiry landing exactly on the epoch proves nothing about posting.
    expect(isEscrowOrphan(jobView({ designated: 0, expiresAt: BigInt(EPOCH.time / 1000) }), EPOCH)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// R77 — a failed authorisation read is never a verdict on the caller
// ---------------------------------------------------------------------------

/**
 * **The compensating control the `view-reads` exemption used to claim, now real.**
 *
 * Plan 3 moved three genuine request-path authorisation reads — `getJob`, `idOf`,
 * `allowlistStatus` — into `src/chain/client.ts`, a file the R77 guard skipped
 * whole. The exemption's prose named these tests as the compensating control and
 * they did not exist: stripping the `viewRead` classification off all three left
 * `view-reads`, `escrow-key`, `release` and `handover` green. The guard is now
 * read-level (`test/view-reads.test.ts`), and this is the behavioural half.
 *
 * What is asserted is R77's actual claim: a read this node could not complete is
 * **the node's failure, not the caller's**, so the answer is a retryable `503`
 * naming the read — never a `400 invalid_request, retryable=false`, which under
 * R57 promises a provider that its perfectly good request can never succeed, and
 * never a bare `500`.
 */
describe("a failed authorisation read on POST /release (R77)", () => {
  /** A well-formed, correctly signed release for a job this node could serve. */
  async function goodRelease() {
    const keys = new KeyManager();
    keys.boot();
    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, keys.current()!.publicKey);
    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });
    const jobs = {
      [container.jobId]: jobView({
        jobId: container.jobId,
        owner,
        c: container.c,
        providerId: HONEST_PROVIDER_ID,
      }),
    };
    return { keys, jobs, body };
  }

  it.each([
    ["a dead endpoint", () => unreachableEndpoint(), "chain_unreachable", null],
    [
      "an RPC rate limit",
      () => refusedCall("limit exceeded", -32005),
      "relay_unavailable",
      "rate_limited",
    ],
    ["a reverting view read", () => bareRevert(), "relay_unavailable", "job_read"],
  ])(
    "503s %s at the job read, never a 400 and never a verdict",
    async (_name, callError, type, code) => {
      const { keys, jobs, body } = await goodRelease();
      const node = escrowNode({
        keys,
        jobs,
        providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
        callError,
      });

      const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });

      expect(answer.statusCode).toBe(503);
      expect(errorOf(answer)).toMatchObject({ type, code });
      // The whole point of the classification: a daemon reading this header
      // keeps polling instead of failing the job.
      expect(answer.headers["x-vorq-retryable"]).toBe("true");
    },
  );

  it("names the provider read when that is the one that failed", async () => {
    // `getJob` answers and `idOf` does not, so the `code` has to come from the
    // read that actually failed rather than from the first one on the path.
    const { keys, jobs, body } = await goodRelease();
    const node = escrowNode({
      keys,
      jobs,
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
      viewError: { view: "idOf", error: () => bareRevert() },
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });

    expect(answer.statusCode).toBe(503);
    expect(errorOf(answer)).toMatchObject({
      type: "relay_unavailable",
      code: "provider_id_read",
    });
    expect(answer.headers["x-vorq-retryable"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// P14 / P26 — the door exists at mode off, and answers during catch-up
// ---------------------------------------------------------------------------

describe("POST /release outside the readiness gate (P14, P26)", () => {
  it("answers 403 escrow_unavailable at ESCROW_MODE=off, and does not 404", async () => {
    const app = buildApp({
      db: hostileDb,
      indexer: READY,
      config: testConfig({ escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 } }),
    });

    const answer = await app.inject({ method: "POST", url: "/release", payload: {} });
    expect(answer.statusCode).toBe(403);
    expect(errorOf(answer).code).toBe("escrow_unavailable");
    expect(errorOf(answer).type).toBe("invalid_request_error");
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
  });

  it("releases while the indexer reports not ready", async () => {
    const keys = new KeyManager();
    keys.boot();
    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, keys.current()!.publicKey);
    const response = newRecipientKeypair();

    const node = escrowNode({
      keys,
      indexer: CATCHING_UP,
      jobs: {
        [container.jobId]: jobView({
          jobId: container.jobId,
          owner,
          c: container.c,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    // The premise: this node really is not ready, and the gate really bites.
    const readyz = await node.app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    const gated = await node.app.inject({ method: "GET", url: "/evm/allowlist" });
    expect(gated.statusCode).toBe(503);

    // A node behind on log replay still holds every key it held a second ago;
    // gating this would make an ordinary restart look like key loss.
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });
    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);
  });

  it("refuses a body that is not an object, without reaching the chain", async () => {
    const node = escrowNode();
    const answer = await node.app.inject({ method: "POST", url: "/release", payload: [] });
    expect(answer.statusCode).toBe(400);
    expect(node.stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });
});

describe("/release on a static node", () => {
  const OPERATOR_KEYS = [`0x${"d4".repeat(32)}`, `0x${"e5".repeat(32)}`];

  it("releases a wrap sealed to a non-current derived key, deriving the DEK as usual", async () => {
    // The list is what makes an OPERATOR_KEY cutover survivable: the second
    // entry no longer derives the announced key, and still opens what was
    // sealed to it — through the actual door, and the same parse → chain auth
    // → tryUnseal → deriveDek → re-seal pipeline as a minted manager's release.
    const keys = new StaticKeyManager(OPERATOR_KEYS);
    const older = escrowKeypairFromOperatorKey(OPERATOR_KEYS[1]);

    const owner = getAddress(VICTIM.address) as Address;
    const container = containerFor(owner, older.publicKey);
    const node = escrowNode({
      keys,
      jobs: {
        [container.jobId]: jobView({
          jobId: container.jobId,
          owner,
          c: container.c,
          providerId: HONEST_PROVIDER_ID,
        }),
      },
      providerIds: { [HONEST_OPERATOR.address]: HONEST_PROVIDER_ID },
    });

    const response = newRecipientKeypair();
    const body = await signedRelease(HONEST_OPERATOR, {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Number(NOW_SECONDS),
    });

    const answer = await node.app.inject({ method: "POST", url: "/release", payload: body });
    expect(answer.statusCode).toBe(200);

    const sealed = Buffer.from((answer.json() as { dek_sealed: string }).dek_sealed, "base64");
    const dek = openDek(sealed, response.publicKey, response.secretKey);
    // Not merely "some 32 bytes": the key the client encrypted under, recovered
    // through the non-current entry rather than the one the node advertises.
    expect(dek.equals(container.dek)).toBe(true);
    expect(openCiphertext(container.ciphertext, dek)).toBe("the task");
  });

  it("never classifies escrow_key_lost, because there is no epoch to be before", () => {
    // A static node's custody has no beginning to be on the wrong side of. The
    // one cost is stated rather than discovered: after a breach-style rotation
    // that drops the old entry, those jobs answer `unseal_failed` at release
    // time instead — no funds move, but there is no early signal either.
    const expired = jobView({ designated: 0, expiresAt: 1n });
    expect(isEscrowOrphan(expired, null)).toBe(false);
  });
});
