import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { JobView } from "../src/chain/client.js";
import { loadConfig, type Address, type Config } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import {
  CHANNEL_SERVICE_ID,
  SERVICE_ID,
  allowlistKeyFor,
  mockEvidence,
  mockMeasurement,
  reportData,
  type Evidence,
} from "../src/escrow/attest.js";
import {
  CHANNEL_SEAL_OVERHEAD_BYTES,
  ChannelError,
  newChannelKeypair,
  openPayload,
  sealPayload,
} from "../src/escrow/channel.js";
import {
  SEED_BYTES,
  commitment,
  jobIdFor,
  newRecipientKeypair,
  openDek,
  sealDek,
} from "../src/escrow/container.js";
import {
  HANDOVER_BODY_LIMIT_BYTES,
  HANDOVER_MAGIC,
  HANDOVER_SKEW_SECONDS,
  decodeHandoverPayload,
  encodeHandoverPayload,
  joinPeer,
  minKeyEpochStart,
  startPeerSync,
  type PeerTransport,
  HANDOVER_AUTH_TYPES,
} from "../src/escrow/handover.js";
import { bootEscrow } from "../src/escrow/boot.js";
import { ESCROW_KEY_RETENTION_MS, ESCROW_SWEEP_INTERVAL_MS, KeyManager } from "../src/escrow/keys.js";
import { RELEASE_TYPES, deriveDek, releaseDomain, type KeyEpochStart } from "../src/escrow/release.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { ADDRESSES, bareRevert, stubChain, testConfig } from "./support/stub-chain.js";

/**
 * `POST /handover` — the attested channel, the takeover, and the symmetric
 * replica cross-share.
 *
 * Unit project: no database, no chain, no network. Every exchange below runs
 * **two in-process `KeyManager`s over the real channel and the real route** —
 * that is the point of the file, not a shortcut. The chain reads go through viem
 * and the ABI against `test/support/stub-chain.ts`; the two nodes talk over an
 * injected transport that is `app.inject`, so the bytes crossing between them are
 * the bytes a socket would carry.
 *
 * The database handed to every app here **throws on any query**: the escrow doors
 * read neither the index nor the store, and a stub that answered would let that
 * property pass untested.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hostileDb = {
  query: async () => {
    throw new Error("the handover door must not read the store");
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

const NOW_SECONDS = 1_790_000_000;
const NOW_MS = NOW_SECONDS * 1000;

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ZERO_ADDRESS = getAddress(`0x${"00".repeat(20)}`) as Address;

const wallet = (byte: string): PrivateKeyAccount =>
  privateKeyToAccount(`0x${byte.repeat(32)}` as Hex);

const CLIENT = wallet("a1");
const OPERATOR = wallet("c3");
const PROVIDER_ID = 7;

/**
 * The network operator's credential — the key curation lists under
 * `coordinator:<address>`, and the one thing a `/handover` caller cannot forge.
 *
 * Deliberately **not** `OPERATOR` above, which is a *provider's* wallet: the two
 * authorise different things in different trust domains, and a fixture that
 * shared one key would let a test pass while the code confused them.
 */
const NETWORK_OPERATOR_KEY = `0x${"d4".repeat(32)}` as Hex;
const NETWORK_OPERATOR = privateKeyToAccount(NETWORK_OPERATOR_KEY);
/** An attested instance somebody else runs: the exact caller the rung exists for. */
const STRANGER_OPERATOR = wallet("e5");

/** Signs a `HandoverAuth` as the given account, over the escrow domain. */
const authSignerFor =
  (account: PrivateKeyAccount) =>
  async (message: { channelPubkey: Hex; issuedAt: bigint }): Promise<Hex> =>
    account.signTypedData({
      domain: releaseDomain(ADDRESSES.chainId),
      types: HANDOVER_AUTH_TYPES,
      primaryType: "HandoverAuth",
      message,
    });

const signAuth = authSignerFor(NETWORK_OPERATOR);

/** Curation's three answers, by name rather than by number at every call site. */
const NEVER_LISTED = 0;
const ACTIVE = 1;
const TOMBSTONED = 2;

/** The default curation table: this image. The operator key is not chain state. */
const CURATED = (): Record<string, number> => ({
  [allowlistKeyFor(mockMeasurement())]: ACTIVE,
});

const escrowConfig = (overrides: Partial<Config["escrow"]> = {}): Config =>
  testConfig({
    escrow: {
      mode: "mock",
      releaseOrdinal: 1,
      sweepIntervalMs: ESCROW_SWEEP_INTERVAL_MS,
      peerUrl: null,
      peerRequired: false,
      peerSyncMs: 300_000,
      rotateIntervalMs: 86_400_000,
      // The holder's half of the operator check: `/handover` authenticates a
      // caller by recovering to *this* key's address, so a node verifying one
      // and a joiner signing another is the mismatch the rung exists to catch.
      operatorKeys: [NETWORK_OPERATOR_KEY],
      clockOffsetMs: 0,
      ...overrides,
    },
  });

const jobView = (over: Partial<JobView>): JobView =>
  ({
    found: true,
    jobId: ZERO32,
    owner: ZERO_ADDRESS,
    c: ZERO32,
    state: 1,
    endedBecause: 0,
    providerId: PROVIDER_ID,
    designated: 0,
    modelId: 1,
    rateIn: 0n,
    rateOut: 0n,
    unitsIn: 0,
    unitsOut: 0,
    completionTok: 0,
    slaSecs: 3600,
    expiresAt: BigInt(NOW_SECONDS + 86_400),
    claimedAt: BigInt(NOW_SECONDS - 60),
    taskCid: "0x",
    resultCid: "0x",
    gasFee: 0n,
    ...over,
  }) as unknown as JobView;

const MISSING_JOB = jobView({ found: false, state: 0, providerId: 0, expiresAt: 0n, claimedAt: 0n });

/** A chain whose soundness facts pass, for driving `bootEscrow`. */
const bootChain = () =>
  stubChain(testConfig(), { views: { MAX_EXPIRY: 86_400n, allowedSla: () => false } });

interface NodeOptions {
  /** Curation's answer, by allowlist key. Anything unnamed is never-listed. */
  allowlist?: Record<string, number>;
  /** The curation read fails at the endpoint instead of answering (R77). */
  allowlistError?: () => unknown;
  jobs?: Record<string, JobView>;
  indexer?: Indexer;
  config?: Config;
  keyEpochStart?: KeyEpochStart | null;
  /** Bring your own manager — the two-instance exercises need to hold both. */
  keys?: KeyManager;
  /** Defer the mint, the way a takeover joiner boots. */
  mint?: boolean;
  clock?: () => number;
}

/** One escrow node: a key manager, a stubbed chain, a hostile store, an app. */
function escrowNode(options: NodeOptions = {}) {
  const config = options.config ?? escrowConfig();
  const allowlist = new Map(
    Object.entries(options.allowlist ?? CURATED()).map(
      ([key, status]) => [key.toLowerCase(), status],
    ),
  );
  const jobs = new Map(
    Object.entries(options.jobs ?? {}).map(([id, view]) => [id.toLowerCase(), view]),
  );

  const stub = stubChain(config, {
    views: {
      allowlistStatus: (args: readonly unknown[]) => {
        if (options.allowlistError !== undefined) throw options.allowlistError();
        return allowlist.get(String(args[0]).toLowerCase()) ?? NEVER_LISTED;
      },
      getJob: (args: readonly unknown[]) => jobs.get(String(args[0]).toLowerCase()) ?? MISSING_JOB,
      idOf: (args: readonly unknown[]) =>
        String(args[0]).toLowerCase() === OPERATOR.address.toLowerCase() ? PROVIDER_ID : 0,
    },
  });

  const keys = options.keys ?? new KeyManager(options.clock ?? (() => NOW_MS));
  if (options.keys === undefined) keys.boot({ mint: options.mint ?? true });

  let epoch = options.keyEpochStart ?? null;
  const app = buildApp({
    db: hostileDb,
    indexer: options.indexer ?? READY,
    config,
    chain: stub.chain,
    escrowKeys: keys,
    escrowClock: options.clock ?? (() => NOW_MS),
    escrowKeyEpochStart: () => epoch,
  });

  return {
    app,
    keys,
    stub,
    config,
    get epoch() {
      return epoch;
    },
    set epoch(value: KeyEpochStart | null) {
      epoch = value;
    },
    /** The transport a peer uses to reach this node — `inject`, not a socket. */
    transport: (async (url, init) => {
      const path = new URL(url).pathname;
      const response = await app.inject({
        method: init.method,
        url: path,
        ...(init.body === undefined
          ? {}
          : { payload: init.body, headers: { "content-type": "application/json" } }),
      });
      return { status: response.statusCode, body: response.body };
    }) satisfies PeerTransport,
  };
}

type EscrowNode = ReturnType<typeof escrowNode>;

/**
 * A `/handover` body, honest by default; every test bends exactly one field.
 *
 * `async` because the operator signature is real — the tests sign with a real
 * key over the real domain, so a change to `HANDOVER_AUTH_TYPES` that the vector
 * did not catch shows up here as every case failing rather than as a fixture
 * quietly agreeing with the bug.
 */
async function handoverBody(
  channelPublicKey: Buffer,
  over: {
    issued_at?: number;
    evidence?: Partial<Evidence>;
    channel_pubkey?: string;
    operator_signature?: string;
    /** Sign as somebody else — a stranger's instance, or a revoked key. */
    signer?: PrivateKeyAccount;
  } = {},
) {
  const evidence = mockEvidence(channelPublicKey, 1, CHANNEL_SERVICE_ID);
  const issuedAt = over.issued_at ?? NOW_SECONDS;
  return {
    evidence: { ...evidence, ...over.evidence },
    channel_pubkey: over.channel_pubkey ?? channelPublicKey.toString("hex"),
    issued_at: Number(issuedAt),
    operator_signature:
      over.operator_signature ??
      (await authSignerFor(over.signer ?? NETWORK_OPERATOR)({
        channelPubkey: `0x${channelPublicKey.toString("hex")}` as Hex,
        issuedAt: BigInt(issuedAt),
      })),
  };
}

/** What the holder's state is, in the two respects a refusal must not change. */
const stateOf = (keys: KeyManager) => ({
  current: keys.current()?.publicKey.toString("hex") ?? null,
  held: keys
    .heldKeys()
    .map((key) => `${key.publicKey.toString("hex")}:${String(key.decayAt)}`)
    .sort(),
});

const errorOf = (response: { json: () => unknown }) =>
  (response.json() as { error: { code: string; type: string; message: string } }).error;

/** A client-side container: seal a **seed**, derive the working key (P4b). */
function containerFor(owner: Address, escrowPublicKey: Buffer) {
  const seed = randomBytes(SEED_BYTES);
  const seedWrap = sealDek(seed, escrowPublicKey);
  const dek = deriveDek(seed, owner);
  const ciphertext = randomBytes(64);
  const ctHash = keccak256(ciphertext as unknown as Uint8Array);
  const c = commitment(seedWrap, Buffer.from(ctHash.slice(2), "hex"));
  return { seed, dek, seedWrap, ciphertext, ctHash, c, jobId: jobIdFor(owner, c) };
}

/**
 * `POST /release` against a node, for a container, as the claiming provider.
 *
 * The handover's whole purpose is that this succeeds on an instance that never
 * minted the generation the wrap names, so the exercises below prove adoption by
 * releasing rather than by reading the successor's private map.
 */
async function releaseOn(node: EscrowNode, container: ReturnType<typeof containerFor>) {
  const response = newRecipientKeypair();
  const fields = {
    job_id: container.jobId,
    seed_wrap: container.seedWrap.toString("base64"),
    ct_hash: container.ctHash,
    response_pubkey: response.publicKey.toString("hex"),
    issued_at: Number(NOW_SECONDS),
  };
  const signature = await OPERATOR.signTypedData({
    domain: releaseDomain(ADDRESSES.chainId),
    types: RELEASE_TYPES,
    primaryType: "Release",
    message: {
      jobId: fields.job_id as Hex,
      seedWrap: `0x${container.seedWrap.toString("hex")}` as Hex,
      ctHash: fields.ct_hash as Hex,
      responsePubkey: `0x${fields.response_pubkey}` as Hex,
      issuedAt: BigInt(fields.issued_at),
    },
  });

  const answer = await node.app.inject({
    method: "POST",
    url: "/release",
    payload: { ...fields, signature },
  });
  if (answer.statusCode !== 200) return { status: answer.statusCode, dek: null };
  const sealed = Buffer.from((answer.json() as { dek_sealed: string }).dek_sealed, "base64");
  return { status: 200, dek: openDek(sealed, response.publicKey, response.secretKey) };
}

/** The job the chain reports for a container, so `/release` can authorise it. */
const jobFor = (container: ReturnType<typeof containerFor>, owner: Address) => ({
  [container.jobId]: jobView({ jobId: container.jobId, owner, c: container.c }),
});

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

describe("the attested channel", () => {
  it("round-trips a payload of any length to the bound channel key", () => {
    const channel = newChannelKeypair();
    for (const size of [0, 1, 32, 500, 4096]) {
      const payload = randomBytes(size);
      const blob = sealPayload(payload, channel.publicKey);
      expect(blob).toHaveLength(size + CHANNEL_SEAL_OVERHEAD_BYTES);
      expect(openPayload(blob, channel.publicKey, channel.secretKey).equals(payload)).toBe(true);
    }
  });

  it("is anonymous: two seals of the same payload to the same key differ", () => {
    const channel = newChannelKeypair();
    const payload = randomBytes(64);
    expect(
      sealPayload(payload, channel.publicKey).equals(sealPayload(payload, channel.publicKey)),
    ).toBe(false);
  });

  it("refuses another key's channel, and a tampered blob", () => {
    const channel = newChannelKeypair();
    const stranger = newChannelKeypair();
    const blob = sealPayload(randomBytes(64), channel.publicKey);

    expect(() => openPayload(blob, stranger.publicKey, stranger.secretKey)).toThrow(ChannelError);

    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => openPayload(tampered, channel.publicKey, channel.secretKey)).toThrow(ChannelError);
  });
});

// ---------------------------------------------------------------------------
// The payload encoding
// ---------------------------------------------------------------------------

describe("the handover payload encoding", () => {
  const samplePayload = () => ({
    releaseOrdinal: 3,
    channelPublicKey: randomBytes(32),
    keyEpochStart: { time: NOW_MS - 5_000, block: 12_345n },
    keys: [
      { publicKey: randomBytes(32), secretKey: randomBytes(32), decayAt: NOW_MS + 1000 },
      { publicKey: randomBytes(32), secretKey: randomBytes(32), decayAt: NOW_MS + 2000 },
    ],
  });

  it("round-trips every field, byte for byte", () => {
    const payload = samplePayload();
    const decoded = decodeHandoverPayload(encodeHandoverPayload(payload));

    expect(decoded.releaseOrdinal).toBe(3);
    expect(decoded.channelPublicKey.equals(payload.channelPublicKey)).toBe(true);
    expect(decoded.keyEpochStart).toEqual({ time: NOW_MS - 5_000, block: 12_345n });
    expect(decoded.keys).toHaveLength(2);
    for (const [index, key] of decoded.keys.entries()) {
      expect(key.publicKey.equals(payload.keys[index]!.publicKey)).toBe(true);
      expect(key.secretKey.equals(payload.keys[index]!.secretKey)).toBe(true);
      expect(key.decayAt).toBe(payload.keys[index]!.decayAt);
    }
  });

  it("has the byte layout it documents", () => {
    const payload = samplePayload();
    const bytes = encodeHandoverPayload(payload);

    expect(bytes.subarray(0, 8).equals(HANDOVER_MAGIC)).toBe(true);
    expect(bytes.readUInt16BE(8)).toBe(3);
    expect(bytes.subarray(10, 42).equals(payload.channelPublicKey)).toBe(true);
    expect(bytes[42]).toBe(0x01); // epoch present
    expect(Number(bytes.readBigUInt64BE(43))).toBe(NOW_MS - 5_000);
    expect(bytes.readBigUInt64BE(51)).toBe(12_345n);
    expect(bytes.readUInt16BE(59)).toBe(2);
    // 61 header + 2 records of 32 + 32 + 8.
    expect(bytes).toHaveLength(61 + 2 * 72);
  });

  it("carries an absent epoch without a hole in the layout", () => {
    const bytes = encodeHandoverPayload({ ...samplePayload(), keyEpochStart: null, keys: [] });
    expect(bytes[42]).toBe(0x00);
    expect(bytes.readUInt16BE(43)).toBe(0);
    expect(bytes).toHaveLength(45);
    expect(decodeHandoverPayload(bytes).keyEpochStart).toBeNull();
  });

  it("refuses a payload that is not one: wrong magic, short body, trailing bytes", () => {
    const bytes = encodeHandoverPayload(samplePayload());

    const wrongMagic = Buffer.from(bytes);
    wrongMagic[0] ^= 0xff;
    expect(() => decodeHandoverPayload(wrongMagic)).toThrow(/magic/i);

    expect(() => decodeHandoverPayload(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => decodeHandoverPayload(Buffer.concat([bytes, Buffer.of(0)]))).toThrow();

    const wrongEpochFlag = Buffer.from(bytes);
    wrongEpochFlag[42] = 0x09;
    expect(() => decodeHandoverPayload(wrongEpochFlag)).toThrow(/epoch flag/i);
  });

  /**
   * P11's wall, restated at the wire: a serialised key with no deadline is what
   * `adoptKeys` refuses, so the encoding must not be able to express one.
   */
  it("refuses to serialise a key with no deadline (P11)", () => {
    expect(() =>
      encodeHandoverPayload({
        ...samplePayload(),
        keys: [
          {
            publicKey: randomBytes(32),
            secretKey: randomBytes(32),
            decayAt: null as unknown as number,
          },
        ],
      }),
    ).toThrow(/deadline/i);
  });
});

// ---------------------------------------------------------------------------
// The door itself: the mode gate and the readiness gate
// ---------------------------------------------------------------------------

describe("POST /handover — the door", () => {
  /** P14: mode `off` refuses with `escrow_unavailable`, and does not 404. */
  it("answers 403 escrow_unavailable at mode off", async () => {
    const node = escrowNode({ config: escrowConfig({ mode: "off" }) });
    const channel = newChannelKeypair();

    const answer = await node.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(channel.publicKey),
    });

    expect(answer.statusCode).toBe(403);
    // M2/P13: the frozen envelope, and `code` is inside `error` — never a bare
    // `{code}` at the top level.
    const body = answer.json() as { error: { code: string }; code?: string };
    expect(body.error.code).toBe("escrow_unavailable");
    expect(body.code).toBeUndefined();
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
  });

  /** P26: the escrow doors are outside the readiness gate. */
  it("serves a handover while the indexer reports not ready", async () => {
    const holder = escrowNode({ indexer: CATCHING_UP });
    const channel = newChannelKeypair();

    // The premise is real: a gated route does refuse right now.
    expect((await holder.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    expect((await holder.app.inject({ method: "GET", url: "/evm/allowlist" })).statusCode).toBe(503);

    const answer = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(channel.publicKey),
    });
    expect(answer.statusCode).toBe(200);
  });

  it("reads the chain and never the store", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    const answer = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(channel.publicKey),
    });

    expect(answer.statusCode).toBe(200);
    // **One** curation read: the measurement, which is the only question this
    // door asks the chain. Whose deployment is asking is settled locally against
    // this node's own operator key and costs no RPC — which is also why an
    // unauthorised caller cannot make this node spend one. The store is not
    // consulted at all (the db throws on any query, so a read of the wrong kind
    // would fail this test outright rather than go uncounted).
    const calls = holder.stub.requests.filter((request) => request.method === "eth_call");
    expect(calls).toHaveLength(1);
  });

  /**
   * The per-route `bodyLimit`, asserted rather than assumed.
   *
   * This is the door that most needs it: `/handover` is **unauthenticated** — the
   * attestation is inside the body, so there is nothing to check until the body
   * has been read — which makes `bodyLimit` the one thing standing between an
   * anonymous caller and an allocation of whatever it cares to send. Every check
   * in `handover.ts` runs after Fastify has already buffered and parsed.
   *
   * The body below is byte-for-byte the honest replica request the test above
   * gets a 200 from, plus a padding field; the only difference between the 413
   * and the 200 is size. Deleting `{ bodyLimit: HANDOVER_BODY_LIMIT_BYTES }` at
   * `src/api/escrow.ts` makes the padded body **accepted** — the app-wide 1 MiB
   * inherits and the unknown field is ignored — so the `toBeLessThan` below is
   * the fail-open direction written down: this payload is one the app-wide limit
   * would take, and only the per-route limit can be refusing it.
   */
  it("refuses a body past this door's own limit, not the app-wide one", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    const before = stateOf(holder.keys);

    const body = await handoverBody(channel.publicKey);
    const padded = JSON.stringify({ ...body, padding: "x".repeat(HANDOVER_BODY_LIMIT_BYTES) });
    // Well inside the app-wide 1 MiB: only the per-route limit can refuse this.
    expect(padded.length).toBeGreaterThan(HANDOVER_BODY_LIMIT_BYTES);
    expect(padded.length).toBeLessThan(1024 * 1024);

    const answer = await holder.app.inject({
      method: "POST",
      url: "/handover",
      headers: { "content-type": "application/json" },
      payload: padded,
    });

    expect(answer.statusCode).toBe(413);
    // The frozen envelope, not a bare Fastify 413 and not a 500.
    expect(errorOf(answer).type).toBe("invalid_request_error");
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
    // Refused before the body was read, so before the curation read — and with
    // nothing of this node's custody touched.
    expect(holder.stub.requests.filter((request) => request.method === "eth_call")).toHaveLength(0);
    expect(stateOf(holder.keys)).toEqual(before);

    // The control, on the same node: the identical body without the padding is
    // served. The refusal above is the size and nothing else.
    const unpadded = await holder.app.inject({ method: "POST", url: "/handover", payload: body });
    expect(unpadded.statusCode).toBe(200);
  });

  /**
   * P9: the key the door asks curation about is the measurement itself, as
   * bytes32 — the eth_call carries the digest the evidence announced, verbatim.
   */
  it("asks curation about the measurement itself, verbatim in the calldata", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(channel.publicKey),
    });

    const call = holder.stub.requests.find((request) => request.method === "eth_call");
    const data = (call!.params as [{ data: string }])[0].data;
    expect(data.toLowerCase()).toContain(allowlistKeyFor(mockMeasurement()).slice(2).toLowerCase());

    // The convention on the contracts repo's own example, so a drift is a
    // failing test rather than a live node reading a permanently absent entry.
    const cvm = createHash("sha256").update(Buffer.from("vorq-mock-cvm-image-v1", "utf8")).digest("hex");
    expect(cvm).toBe("3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d");
    expect(allowlistKeyFor(cvm)).toBe(
      "0x3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d",
    );
  });
});

// ---------------------------------------------------------------------------
// The verification ladder — every refusal, and the state it must not change
// ---------------------------------------------------------------------------

describe("POST /handover — the verification ladder", () => {
  /**
   * Every refusal below asserts the **holder's whole state is unchanged**, not
   * merely that it answered 403.
   *
   * That property is now true of the success path too — the door has no branch
   * that writes to the key manager — so these assertions are a regression guard
   * on the redesign rather than a description of the refusal path. If a later
   * change reintroduces a local effect, it fails here first.
   *
   * The payload is taken as a promise so call sites do not each have to `await`
   * a body whose signature is real.
   */
  async function refuses(
    node: EscrowNode,
    body: Record<string, unknown> | Promise<Record<string, unknown>>,
    expected: { status: number; code: string },
  ) {
    const payload = await body;
    const before = stateOf(node.keys);
    const answer = await node.app.inject({ method: "POST", url: "/handover", payload });

    expect(answer.statusCode).toBe(expected.status);
    expect(errorOf(answer).code).toBe(expected.code);
    expect(answer.headers["x-vorq-retryable"]).toBe("false");
    expect(stateOf(node.keys)).toEqual(before);
    // Nothing was released: the body carries no key material at all.
    expect(answer.body).not.toContain("keys_sealed");
    return answer;
  }

  /**
   * **R77 on the curation read** — the third of the three authorisation reads
   * Plan 3 moved into `src/chain/client.ts`, and the one `/handover` makes.
   *
   * A read this node could not complete is the node's failure, not the caller's.
   * Unwrapped it would answer `400 invalid_request, retryable=false` — telling a
   * successor its handover can never succeed — or a bare `500`. It must be a
   * retryable `503` naming the read, and it must move no state, which is exactly
   * what a refusal of a *live* peer would have to do too.
   */
  it("503s a curation read the endpoint could not answer, and changes nothing (R77)", async () => {
    const holder = escrowNode({ allowlistError: () => bareRevert() });
    const channel = newChannelKeypair();
    const before = stateOf(holder.keys);

    const answer = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(channel.publicKey),
    });

    expect(answer.statusCode).toBe(503);
    expect(errorOf(answer)).toMatchObject({
      type: "relay_unavailable",
      code: "allowlist_status_read",
    });
    expect(answer.headers["x-vorq-retryable"]).toBe("true");
    expect(stateOf(holder.keys)).toEqual(before);
    expect(holder.keys.current()).not.toBeNull();
    expect(answer.body).not.toContain("keys_sealed");
  });

  it("refuses a tombstoned measurement and changes nothing", async () => {
    const holder = escrowNode({
      allowlist: {
        ...CURATED(),
        [allowlistKeyFor(mockMeasurement())]: TOMBSTONED,
      },
    });
    const channel = newChannelKeypair();
    await refuses(holder, handoverBody(channel.publicKey), {
      status: 403,
      code: "tombstoned",
    });
    // The one that would be invisible in a "did it 403" assertion: the current
    // generation is still current.
    expect(holder.keys.current()).not.toBeNull();
  });

  it("refuses a measurement curation never listed", async () => {
    const holder = escrowNode({ allowlist: {} });
    const channel = newChannelKeypair();
    await refuses(holder, handoverBody(channel.publicKey), {
      status: 403,
      code: "not_allowlisted",
    });
  });

  // -------------------------------------------------------------------------
  // The operator rung: attested code is not on its own a reason to hand over
  // -------------------------------------------------------------------------

  /**
   * **The hole this rung exists to close.**
   *
   * Everything above authenticates the *image*. Nothing above authenticates the
   * *deployment*, and configuration is not measured: a stranger who runs the
   * genuine, allowlisted image on their own host produces evidence that is
   * honest in every particular. Here that caller carries perfect evidence and a
   * perfectly valid signature — from a key curation never listed — and leaves
   * with nothing.
   *
   * What it buys is everything downstream: their instance, pointed at a chain
   * they control where `getJob` answers `Claimed` for anything, would otherwise
   * hand them every DEK through its own `/release`.
   */
  /**
   * **The rotation property, and the only reason `OPERATOR_KEY` is a list.**
   *
   * A node reads its keys once at boot and cannot be reconfigured without a
   * restart, and a restart erases the escrow key set. So a successor carrying a
   * brand-new key could never join a predecessor that knows only the old one —
   * every rotation would cost the key set. Accepting the whole list makes the
   * change two ordinary cutovers, `K_old` → `K_old,K_new` → `K_new`, and the old
   * key dies with the last process holding it.
   *
   * The signing half is asymmetric on purpose: the *first* entry is what this
   * node signs its own pulls with, so a fleet mid-rotation still presents one
   * predictable identity outward.
   */
  it("accepts any configured operator key, not only the one it signs with", async () => {
    const successor = wallet("f6");
    const holder = escrowNode({
      config: escrowConfig({ operatorKeys: [NETWORK_OPERATOR_KEY, `0x${"f6".repeat(32)}` as Hex] }),
    });

    // The outgoing key still works — that is what lets the *first* cutover land.
    const first = newChannelKeypair();
    const outgoing = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(first.publicKey),
    });
    expect(outgoing.statusCode).toBe(200);

    // And so does the incoming one, which is what lets the second cutover land.
    const second = newChannelKeypair();
    const incoming = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: await handoverBody(second.publicKey, { signer: successor }),
    });
    expect(incoming.statusCode).toBe(200);

    // A third key is still nobody: the list is an allowance, not an opening.
    await refuses(
      holder,
      handoverBody(newChannelKeypair().publicKey, { signer: STRANGER_OPERATOR }),
      { status: 403, code: "operator_not_authorized" },
    );
  });

  it("refuses an attested stranger: real evidence, real signature, unlisted key", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();

    await refuses(
      holder,
      handoverBody(channel.publicKey, { signer: STRANGER_OPERATOR }),
      { status: 403, code: "operator_not_authorized" },
    );
  });


  /**
   * `ecrecover` does not fail on a wrong signature — it returns a stranger. So a
   * signature lifted from another exchange is not a *malformed* signature, and
   * the code says the true thing: whoever that recovers to is not authorised.
   */
  it("refuses a signature over a different channel key", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    const elsewhere = newChannelKeypair();

    await refuses(
      holder,
      handoverBody(channel.publicKey, {
        operator_signature: await signAuth({
          channelPubkey: `0x${elsewhere.publicKey.toString("hex")}` as Hex,
          issuedAt: BigInt(NOW_SECONDS),
        }),
      }),
      { status: 403, code: "operator_not_authorized" },
    );
  });

  it("refuses a signature that is not one at all", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();

    // Well-formed on the wire, unrecoverable in fact: 65 bytes of zeroes.
    await refuses(
      holder,
      handoverBody(channel.publicKey, { operator_signature: `0x${"00".repeat(65)}` }),
      { status: 403, code: "bad_operator_signature" },
    );
  });

  /**
   * A body with no signature is a **malformed request**, not a failed
   * authorization: answering `403` would tell a prober the field is optional
   * somewhere, and `400` is what every other missing field gets.
   */
  it("refuses a body with no operator signature at the parser", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    const { operator_signature: _dropped, ...unsigned } = await handoverBody(channel.publicKey);

    const before = stateOf(holder.keys);
    const answer = await holder.app.inject({
      method: "POST",
      url: "/handover",
      payload: unsigned,
    });
    expect(answer.statusCode).toBe(400);
    expect(stateOf(holder.keys)).toEqual(before);
    expect(answer.body).not.toContain("keys_sealed");
  });

  /**
   * Order matters, and this pins it: a caller running a **withdrawn image** with
   * the **wrong key** is told about the key.
   *
   * The operator check is local and the measurement check is an `eth_call`, so
   * cheapest-first puts the signature first — and it means an unauthorised
   * caller costs this node no RPC at all, which is the difference between a
   * refusal and an amplification vector. Nothing is leaked by the ordering: a
   * caller without the key learns only what it already knew.
   */
  it("reports the operator before the image when both are wrong", async () => {
    const holder = escrowNode({
      allowlist: { [allowlistKeyFor(mockMeasurement())]: TOMBSTONED },
    });
    const channel = newChannelKeypair();

    await refuses(
      holder,
      handoverBody(channel.publicKey, { signer: STRANGER_OPERATOR }),
      { status: 403, code: "operator_not_authorized" },
    );
  });

  it("refuses a lower release ordinal — keys never migrate backwards (M3)", async () => {
    const holder = escrowNode({ config: escrowConfig({ releaseOrdinal: 4 }) });
    const channel = newChannelKeypair();
    await refuses(
      holder,
      { ...await handoverBody(channel.publicKey), evidence: mockEvidence(channel.publicKey, 3, CHANNEL_SERVICE_ID) },
      { status: 403, code: "stale_release" },
    );
  });

  it("accepts an equal ordinal, and a higher one", async () => {
    for (const ordinal of [4, 9]) {
      const holder = escrowNode({ config: escrowConfig({ releaseOrdinal: 4 }) });
      const channel = newChannelKeypair();
      const answer = await holder.app.inject({
        method: "POST",
        url: "/handover",
        payload: {
          ...await handoverBody(channel.publicKey),
          evidence: mockEvidence(channel.publicKey, ordinal, CHANNEL_SERVICE_ID),
        },
      });
      expect(answer.statusCode).toBe(200);
    }
  });

  it("refuses evidence whose report_data does not bind the channel key", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    const other = newChannelKeypair();
    await refuses(
      holder,
      { ...await handoverBody(channel.publicKey), evidence: mockEvidence(other.publicKey, 1, CHANNEL_SERVICE_ID) },
      { status: 403, code: "bad_binding" },
    );
  });

  it("refuses debug-enabled evidence", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    await refuses(holder, handoverBody(channel.publicKey, { evidence: { debug: true } }), {
      status: 403,
      code: "debug_evidence",
    });
  });

  it("refuses a rolled-back TCB", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    await refuses(holder, handoverBody(channel.publicKey, { evidence: { tcb: { svn: 0 } } }), {
      status: 403,
      code: "stale_release",
    });
  });

  it("refuses an evidence type this mode does not verify", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();
    await refuses(
      holder,
      handoverBody(channel.publicKey, { evidence: { type: "mock-provider-v1" } }),
      { status: 403, code: "bad_binding" },
    );
  });

  /**
   * I7's freshness bound. Without it a captured `/handover` body is replayable
   * forever — and in `takeover` mode a replay forces the holder to retire.
   */
  it("bounds issued_at to ±600 s, inclusive at the boundary", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();

    for (const skew of [HANDOVER_SKEW_SECONDS, -HANDOVER_SKEW_SECONDS]) {
      const answer = await holder.app.inject({
        method: "POST",
        url: "/handover",
        payload: await handoverBody(channel.publicKey, {
          issued_at: NOW_SECONDS + skew,
        }),
      });
      expect(answer.statusCode).toBe(200);
    }

    for (const skew of [HANDOVER_SKEW_SECONDS + 1, -(HANDOVER_SKEW_SECONDS + 1)]) {
      await refuses(
        holder,
        await handoverBody(channel.publicKey, { issued_at: NOW_SECONDS + skew }),
        { status: 400, code: "stale_issued_at" },
      );
    }
  });

  it("refuses a body that is not one", async () => {
    const holder = escrowNode();
    const channel = newChannelKeypair();

    for (const payload of [
      { ...await handoverBody(channel.publicKey), channel_pubkey: "ff" },
      { ...await handoverBody(channel.publicKey), evidence: "not an object" },
    ]) {
      const before = stateOf(holder.keys);
      const answer = await holder.app.inject({ method: "POST", url: "/handover", payload });
      expect(answer.statusCode).toBe(400);
      expect(stateOf(holder.keys)).toEqual(before);
    }
  });

  /**
   * **I7, the whole point of the domain separation.** `GET /key` is public and
   * unauthenticated and its response carries evidence built the same way. If both
   * uses shared a `service_id`, that response would replay verbatim as a
   * `/handover` body.
   *
   * The replay is signed by the **real** operator key here, which is the only
   * version of this test worth running: an unsigned replay dies at the parser
   * and proves nothing about the binding. So this is our own credential, aimed
   * at a public artifact, and the domain separation is what still refuses it.
   */
  it("refuses a GET /key response replayed verbatim as a handover body", async () => {
    const holder = escrowNode();
    const announced = await holder.app.inject({ method: "GET", url: "/key" });
    expect(announced.statusCode).toBe(200);
    const key = announced.json() as { escrow_public_key: string; evidence: Evidence; issued_at: number };

    await refuses(
      holder,
      {
        evidence: key.evidence,
        channel_pubkey: key.escrow_public_key,
        issued_at: key.issued_at,
        operator_signature: await signAuth({
          channelPubkey: `0x${key.escrow_public_key}` as Hex,
          issuedAt: BigInt(key.issued_at),
        }),
      },
      { status: 403, code: "bad_binding" },
    );
    expect(holder.keys.current()).not.toBeNull();
  });

  it("separates the two report-data domains by service id", () => {
    const key = randomBytes(32);
    expect(CHANNEL_SERVICE_ID).not.toBe(SERVICE_ID);
    expect(reportData(key, CHANNEL_SERVICE_ID)).not.toBe(reportData(key, SERVICE_ID));
    // Stated as bytes, unpadded utf-8, exactly as P24 requires of the first one.
    expect(Buffer.from(CHANNEL_SERVICE_ID, "utf8")).toHaveLength(CHANNEL_SERVICE_ID.length);
  });
});

// ---------------------------------------------------------------------------
// Succession, between two in-process managers, over the real channel
// ---------------------------------------------------------------------------

describe("succession", () => {
  /** Predecessor with a key and a live claimed job; successor joining from it. */
  async function successionPair() {
    const owner = getAddress(CLIENT.address) as Address;
    const predecessorKeys = new KeyManager(() => NOW_MS);
    predecessorKeys.boot();
    const oldKey = predecessorKeys.current()!;
    const container = containerFor(owner, oldKey.publicKey);

    const predecessor = escrowNode({ keys: predecessorKeys, jobs: jobFor(container, owner) });
    predecessor.epoch = { time: NOW_MS - 60_000, block: 900n };
    const before = stateOf(predecessorKeys);

    const successorKeys = new KeyManager(() => NOW_MS);
    successorKeys.boot({ mint: false });
    const successor = escrowNode({ keys: successorKeys, jobs: jobFor(container, owner) });

    const joined = await joinPeer({
      peerUrl: "http://predecessor.invalid",
      keys: successorKeys,
      releaseOrdinal: 1,
      signAuth,
      keyEpochStart: { time: NOW_MS, block: 1000n },
      transport: predecessor.transport,
      nowMs: () => NOW_MS,
    });
    successor.epoch = joined.keyEpochStart;
    successorKeys.mint();

    return { predecessor, successor, oldKey, container, owner, joined, before };
  }

  it("moves the keys: a wrap sealed to the predecessor's key still releases on the successor", async () => {
    const { successor, container } = await successionPair();

    const released = await releaseOn(successor, container);
    expect(released.status).toBe(200);
    expect(released.dek!.equals(container.dek)).toBe(true);
  });

  /**
   * **P11, asserted on the successor.** The predecessor stamping its own key
   * would prove nothing about what it *serialised* — and it no longer stamps
   * anything at all, so this is the only place the deadline can be observed. A
   * `decayAt: null` arriving here would be a key erased by nothing.
   */
  it("stamps deadlines before serialising: the successor's adopted key carries one", async () => {
    const { successor, oldKey } = await successionPair();

    const adopted = successor.keys
      .heldKeys()
      .find((key) => key.publicKey.equals(oldKey.publicKey));
    expect(adopted).toBeDefined();
    expect(adopted!.decayAt).toBe(NOW_MS + ESCROW_KEY_RETENTION_MS);

    // And nothing else arrived without one. The successor's own fresh mint is
    // the single un-deadlined key it may hold.
    const undeadlined = successor.keys.heldKeys().filter((key) => key.decayAt === null);
    expect(undeadlined).toHaveLength(1);
    expect(undeadlined[0]!.publicKey.equals(successor.keys.current()!.publicKey)).toBe(true);
  });

  /**
   * **The property the whole redesign exists for.** A handover is a read: the
   * predecessor keeps its current generation, keeps advertising it, and keeps
   * serving. Nothing about a successor's request — including a successor that
   * dies one instruction later — can leave the network with no key advertised.
   *
   * The predecessor used to retire here and latch a permanent `410`, which put an
   * unrecoverable state change on the far side of a network call: a successor
   * that crashed before it listened took the whole escrow down with it, and the
   * only repair erased every key. Cutover is the orchestrator's job now.
   */
  it("leaves the predecessor completely unchanged, still current and still advertising", async () => {
    const { predecessor, oldKey, before } = await successionPair();

    expect(stateOf(predecessor.keys)).toEqual(before);
    expect(predecessor.keys.current()!.publicKey.equals(oldKey.publicKey)).toBe(true);

    const announced = await predecessor.app.inject({ method: "GET", url: "/key" });
    expect(announced.statusCode).toBe(200);
    expect(announced.json().escrow_public_key).toBe(oldKey.publicKey.toString("hex"));
  });

  /** The predecessor is still a key oracle for everything it holds. */
  it("the predecessor still releases from its generations", async () => {
    const { predecessor, container } = await successionPair();

    const released = await releaseOn(predecessor, container);
    expect(released.status).toBe(200);
    expect(released.dek!.equals(container.dek)).toBe(true);
  });

  it("takes the earlier key epoch start, and the successor serves it (P21)", async () => {
    const { joined, successor } = await successionPair();
    expect(joined.keyEpochStart).toEqual({ time: NOW_MS - 60_000, block: 900n });
    expect(successor.epoch).toEqual({ time: NOW_MS - 60_000, block: 900n });
  });
});

// ---------------------------------------------------------------------------
// Replica: symmetric, and proved in the direction the plan claims (P6)
// ---------------------------------------------------------------------------

describe("replica cross-share", () => {
  /**
   * **P6.** `/handover` is a pure pull, so a topology in which only one instance
   * carries a peer URL cannot propagate a generation minted on the other. The
   * exchange is made symmetric by configuration: **both** instances carry the
   * other's URL and each pulls. The test below asserts the direction the plan
   * claims — B → A — which under a one-sided pull is unreachable by construction.
   */
  async function replicaPair() {
    const owner = getAddress(CLIENT.address) as Address;

    const keysA = new KeyManager(() => NOW_MS);
    keysA.boot();
    const keysB = new KeyManager(() => NOW_MS);
    keysB.boot();

    const containerA = containerFor(owner, keysA.current()!.publicKey);
    const containerB = containerFor(owner, keysB.current()!.publicKey);
    const jobs = { ...jobFor(containerA, owner), ...jobFor(containerB, owner) };

    const a = escrowNode({ keys: keysA, jobs });
    const b = escrowNode({ keys: keysB, jobs });
    a.epoch = { time: NOW_MS - 30_000, block: 700n };
    b.epoch = { time: NOW_MS - 10_000, block: 800n };

    const join = (self: EscrowNode, peer: EscrowNode) =>
      joinPeer({
        peerUrl: "http://peer.invalid",
        keys: self.keys,
        releaseOrdinal: 1,
        signAuth,
        keyEpochStart: self.epoch,
        transport: peer.transport,
        nowMs: () => NOW_MS,
      });

    return { a, b, containerA, containerB, owner, jobs, join };
  }

  it("retires nothing on either side, and the same wrap releases on both", async () => {
    const { a, b, containerA, containerB, join } = await replicaPair();
    const currentA = a.keys.current()!.publicKey.toString("hex");
    const currentB = b.keys.current()!.publicKey.toString("hex");

    a.epoch = (await join(a, b)).keyEpochStart;
    b.epoch = (await join(b, a)).keyEpochStart;

    // The holder retires nothing: both instances keep advertising their own.
    expect(a.keys.current()!.publicKey.toString("hex")).toBe(currentA);
    expect(b.keys.current()!.publicKey.toString("hex")).toBe(currentB);

    for (const node of [a, b]) {
      for (const container of [containerA, containerB]) {
        const released = await releaseOn(node, container);
        expect(released.status).toBe(200);
        expect(released.dek!.equals(container.dek)).toBe(true);
      }
    }
  });

  /** **The direction the plan claims (P6/T7.4): a generation minted on B reaches A.** */
  it("propagates a generation minted on B to A within one sync tick", async () => {
    const { a, b, owner, join } = await replicaPair();
    await join(a, b);
    await join(b, a);

    // B rotates. A has never seen this key, and nothing pushed it.
    const mintedOnB = b.keys.mint();
    const container = containerFor(owner, mintedOnB.publicKey);
    const jobs = jobFor(container, owner);
    // Rebuild both nodes' chain view so `/release` can authorise the new job,
    // keeping the same managers — the key material is what is under test.
    const aWithJob = escrowNode({ keys: a.keys, jobs });
    const bWithJob = escrowNode({ keys: b.keys, jobs });

    expect((await releaseOn(aWithJob, container)).status).toBe(400);

    const sync = startPeerSync({
      peerUrl: "http://peer.invalid",
      keys: a.keys,
      releaseOrdinal: 1,
      signAuth,
      intervalMs: 300_000,
      transport: bWithJob.transport,
      nowMs: () => NOW_MS,
      keyEpochStart: () => a.epoch,
      onEpoch: (epoch) => {
        a.epoch = epoch;
      },
    });
    await sync.tick();
    sync.stop();

    const released = await releaseOn(aWithJob, container);
    expect(released.status).toBe(200);
    expect(released.dek!.equals(container.dek)).toBe(true);
  });

  /**
   * **S3 — P11's projection, asserted where it actually fires.**
   *
   * `handover.ts`'s `decayAt: key.decayAt ?? deadline` is the only bound on a
   * replica's copy of a peer's **current** generation. In takeover the retirement
   * has already stamped the key, so the `??` branch never executes and the P11
   * test above cannot see this line at all — mutating it to
   * `Number.MAX_SAFE_INTEGER` left all 48 tests in this file green. Replica mode
   * is where it fires: the holder retires nothing, so its current key crosses the
   * wire with `decayAt: null` and the *copy* must arrive deadlined or every
   * replica accumulates an un-sweepable copy of its peer's key material, secret
   * key included, on every rotation.
   *
   * The assertion is on the successor's view, as P11 requires, and against a
   * literal rather than against the peer's own state.
   */
  it("bounds the replica's copy of the peer's current generation (P11, S3)", async () => {
    const { a, b, join } = await replicaPair();
    const peerCurrent = b.keys.current()!.publicKey;

    await join(a, b);

    const adopted = a.keys.heldKeys().find((key) => key.publicKey.equals(peerCurrent));
    expect(adopted).toBeDefined();
    expect(adopted!.decayAt).toBe(NOW_MS + ESCROW_KEY_RETENTION_MS);

    // The holder keeps serving the original as current — the projection is the
    // copy's deadline, not a retirement.
    expect(b.keys.current()!.publicKey.equals(peerCurrent)).toBe(true);
    expect(b.keys.heldKeys().find((key) => key.publicKey.equals(peerCurrent))!.decayAt).toBeNull();

    // And the adopted copy is genuinely sweepable, which is the property the
    // deadline exists for: exactly one un-deadlined key on the joiner, its own.
    const undeadlined = a.keys.heldKeys().filter((key) => key.decayAt === null);
    expect(undeadlined).toHaveLength(1);
    expect(undeadlined[0]!.publicKey.equals(a.keys.current()!.publicKey)).toBe(true);
  });

  /**
   * **S8 — the projection is stamped on the key-lifecycle clock.**
   *
   * The holder's `KeyManager` runs on `ESCROW_CLOCK_OFFSET_MS`; the route
   * runs on real time (P22 — `/release`'s `issued_at` bound lives there, and a
   * shifted one would call every honest request stale). The deadline the replica
   * copy carries is a key-lifecycle deadline: the successor's sweep compares
   * against it. Stamped from the route's clock it would be a number measured on a
   * clock that erases nothing.
   */
  it("projects the replica's deadline on the key manager's clock, not the route's (S8)", async () => {
    const offset = 10 * 3_600_000;
    const holderKeys = new KeyManager(() => NOW_MS + offset);
    holderKeys.boot();
    const holder = escrowNode({ keys: holderKeys });
    const joinerKeys = new KeyManager(() => NOW_MS);
    joinerKeys.boot();

    await joinPeer({
      peerUrl: "http://peer.invalid",
      keys: joinerKeys,
      releaseOrdinal: 1,
      signAuth,
      keyEpochStart: null,
      transport: holder.transport,
      nowMs: () => NOW_MS,
    });

    const adopted = joinerKeys
      .heldKeys()
      .find((key) => key.publicKey.equals(holderKeys.current()!.publicKey));
    expect(adopted!.decayAt).toBe(NOW_MS + offset + ESCROW_KEY_RETENTION_MS);
  });

  /**
   * **S2 — a hostile peer cannot make this node erase key material.**
   *
   * The peer link is MITM-able by whoever controls it, which the design concedes
   * — but it concedes it as a *confidentiality* risk. This is the other
   * consequence: a peer that answers every handover with `decayAt: 1` used to
   * shorten every generation this node holds, and a swept generation is a DEK a
   * live claimed job can never recover. `/release` would answer `unseal_failed`,
   * which reads to a provider like a junk wrap, and nothing would log it.
   */
  describe("a peer that shortens deadlines (S2)", () => {
    /** A holder that serves honest key material under a hostile deadline. */
    class ShorteningHolder extends KeyManager {
      shorten = false;
      override heldKeys() {
        const held = super.heldKeys();
        return this.shorten ? held.map((key) => ({ ...key, decayAt: 1 })) : held;
      }
    }

    async function hostilePair() {
      const owner = getAddress(CLIENT.address) as Address;
      const keysA = new KeyManager(() => NOW_MS);
      keysA.boot();
      const keysB = new ShorteningHolder(() => NOW_MS);
      keysB.boot();

      const containerB = containerFor(owner, keysB.current()!.publicKey);
      const jobs = jobFor(containerB, owner);
      const a = escrowNode({ keys: keysA, jobs });
      const b = escrowNode({ keys: keysB, jobs });
      a.epoch = { time: NOW_MS - 30_000, block: 700n };

      const join = () =>
        joinPeer({
          peerUrl: "http://peer.invalid",
          keys: keysA,
          releaseOrdinal: 1,
          signAuth,
          keyEpochStart: a.epoch,
          transport: b.transport,
          nowMs: () => NOW_MS,
        });

      return { a, keysA, keysB, containerB, owner, join };
    }

    it("cannot stamp an already-expired deadline on a key this node adopts", async () => {
      const { a, keysA, keysB, containerB, join } = await hostilePair();
      keysB.shorten = true;

      await join();

      const adopted = keysA
        .heldKeys()
        .find((key) => key.publicKey.equals(keysB.current()!.publicKey));
      expect(adopted!.decayAt).toBe(NOW_MS + ESCROW_KEY_RETENTION_MS);

      // The consequence, not just the number: the key is still here to release
      // with after the sweep the hostile deadline was meant to trigger.
      expect(keysA.sweep()).toBe(0);
      const released = await releaseOn(a, containerB);
      expect(released.status).toBe(200);
      expect(released.dek!.equals(containerB.dek)).toBe(true);
    });

    it("cannot shorten a retained generation this node already holds", async () => {
      const { a, keysA, containerB, keysB, join } = await hostilePair();
      await join();
      const before = stateOf(keysA);

      keysB.shorten = true;
      await join();

      expect(stateOf(keysA)).toEqual(before);
      expect(keysA.sweep()).toBe(0);
      const released = await releaseOn(a, containerB);
      expect(released.status).toBe(200);
      expect(released.dek!.equals(containerB.dek)).toBe(true);
    });
  });

  it("is idempotent: repeated syncs never move a deadline later", async () => {
    const { a, b, join } = await replicaPair();
    await join(a, b);
    const after = stateOf(a.keys);

    await join(a, b);
    await join(a, b);
    expect(stateOf(a.keys)).toEqual(after);
  });

  it("adopts min(own, peer's) epoch in both directions (P21)", async () => {
    const { a, b, join } = await replicaPair();
    expect((await join(a, b)).keyEpochStart).toEqual({ time: NOW_MS - 30_000, block: 700n });
    expect((await join(b, a)).keyEpochStart).toEqual({ time: NOW_MS - 30_000, block: 700n });
  });

  it("a dead peer pauses sync and never stops the instance serving", async () => {
    const { a, containerA } = await replicaPair();
    const failures: unknown[] = [];
    const sync = startPeerSync({
      peerUrl: "http://peer.invalid",
      keys: a.keys,
      releaseOrdinal: 1,
      signAuth,
      intervalMs: 300_000,
      transport: async () => {
        throw new Error("ECONNREFUSED");
      },
      nowMs: () => NOW_MS,
      keyEpochStart: () => a.epoch,
      onEpoch: () => undefined,
      onError: (error) => failures.push(error),
    });

    await expect(sync.tick()).resolves.toBeUndefined();
    sync.stop();
    expect(failures).toHaveLength(1);
    expect((await releaseOn(a, containerA)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The key epoch start marker (I8/P, P21)
// ---------------------------------------------------------------------------

describe("keyEpochStart", () => {
  it("takes the minimum of the epoch-start timestamps (P21)", () => {
    const early = { time: 1000, block: 50n };
    const late = { time: 2000, block: 10n };
    expect(minKeyEpochStart(early, late)).toEqual(early);
    expect(minKeyEpochStart(late, early)).toEqual(early);
  });

  /** P21's tie-break: equal timestamps resolve to the **lower** ordinal. */
  it("resolves a tie to the lower block ordinal", () => {
    const lower = { time: 1000, block: 10n };
    const higher = { time: 1000, block: 50n };
    expect(minKeyEpochStart(lower, higher)).toEqual(lower);
    expect(minKeyEpochStart(higher, lower)).toEqual(lower);
  });

  /**
   * `main()` runs on import, so no in-process test can boot the node — the
   * wiring's *shape* is asserted from the source instead, exactly as Task 3 does
   * for the soundness check. Deleting any of these lines from `main.ts` turns
   * this red, which is the whole point: without it the boot marker, the takeover
   * join and the standing sync would all ship with no test at all.
   */
  /**
   * The boot sequence, **driven** rather than read (S4). This was four
   * assertions on the text of `main.ts`, which could see that the lines were
   * written in the right order and nothing about what they did. `bootEscrow` is
   * a module of its own now, so the properties are exercised: the marker is the
   * head this node indexes at, the takeover defers its mint, and the epoch the
   * join returned is the one that survives.
   */
  it("mints the marker at the head, and defers the takeover's mint", async () => {
    const stub = bootChain();
    const keys = new KeyManager(() => NOW_MS);
    const config = escrowConfig({ peerUrl: "http://predecessor.invalid", peerRequired: true, operatorKeys: [NETWORK_OPERATOR_KEY] });
    const peerEpoch = { time: NOW_MS - 120_000, block: 500n };

    let currentAtJoin: unknown = "join never ran";
    let ownEpochAtJoin: KeyEpochStart | null = null;
    const epoch = await bootEscrow(stub.chain, config, keys, async (options) => {
      // The mint is deferred: at the moment the predecessor is asked for its
      // keys, this node advertises nothing. Minting first would advertise an
      // orphan generation for the length of the join.
      currentAtJoin = options.keys.current();
      ownEpochAtJoin = options.keyEpochStart;
      return { adopted: 2, keyEpochStart: peerEpoch, peerRelease: 1 };
    });

    expect(currentAtJoin).toBeNull();
    // The marker is the head this node indexes at, so the half Task 6's book
    // filter reads is a block the projection admits.
    expect(ownEpochAtJoin).not.toBeNull();
    expect((ownEpochAtJoin as unknown as KeyEpochStart).block).toBe(await stub.chain.headBlock());
    // And the epoch that survives is the joined one (P21), not this node's own.
    expect(epoch).toEqual(peerEpoch);
    // Minted after the adoption, so the node advertises a generation it holds.
    expect(keys.current()).not.toBeNull();
  });

  it("is wired into the routes and the shutdown (main.ts)", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

    // Read fresh on every request, never captured at registration time.
    expect(main).toContain("escrowKeyEpochStart: () => keyEpochStart");
    expect(main).toContain("await bootEscrow(chain, config, escrowKeys)");

    // The standing replica sync, and the shutdown that stops it.
    expect(main).toContain("startPeerSync({");
    expect(main).toContain("config.escrow.peerUrl");
    expect(main).toContain("peerSync?.stop()");
  });

  it("treats an absent marker as no information, never as zero", () => {
    const epoch = { time: 1000, block: 10n };
    expect(minKeyEpochStart(null, epoch)).toEqual(epoch);
    expect(minKeyEpochStart(epoch, null)).toEqual(epoch);
    expect(minKeyEpochStart(null, null)).toBeNull();
  });

  it("crosses the wire as part of the handover payload", async () => {
    const holder = escrowNode({ keyEpochStart: { time: NOW_MS - 90_000, block: 640n } });
    const joiner = new KeyManager(() => NOW_MS);
    joiner.boot();

    const joined = await joinPeer({
      peerUrl: "http://holder.invalid",
      keys: joiner,
      releaseOrdinal: 1,
      signAuth,
      keyEpochStart: { time: NOW_MS, block: 1000n },
      transport: holder.transport,
      nowMs: () => NOW_MS,
    });

    expect(joined.keyEpochStart).toEqual({ time: NOW_MS - 90_000, block: 640n });
  });
});

// ---------------------------------------------------------------------------
// The joiner's own checks
// ---------------------------------------------------------------------------

describe("joinPeer", () => {
  /**
   * The 43-byte header is a binding, not decoration: the joiner checks the echoed
   * `channel_pubkey` and `mode` against what it asked for.
   *
   * Both liars below seal a **perfectly openable** payload to the joiner's own
   * channel key, read straight off the request they are forwarding — which is
   * exactly what an unauthenticated peer link permits (I7), and why the README
   * requires the transport to carry the authentication this protocol does not. So
   * the channel itself cannot catch them and only the echo check can, which is
   * what makes these tests able to observe it.
   */
  const forgingPeer = (
    bend: (channelPk: Buffer) => Parameters<typeof encodeHandoverPayload>[0],
  ): PeerTransport =>
    async (url, init) => {
      if (!url.endsWith("/handover")) return { status: 200, body: "{}" };
      const asked = JSON.parse(init.body!) as { channel_pubkey: string };
      const channelPk = Buffer.from(asked.channel_pubkey, "hex");
      return {
        status: 200,
        body: JSON.stringify({
          keys_sealed: sealPayload(encodeHandoverPayload(bend(channelPk)), channelPk).toString(
            "base64",
          ),
          key_count: 0,
          holder_release: 1,
        }),
      };
    };

  it("refuses a payload that echoes a channel key this join did not mint", async () => {
    const joiner = new KeyManager(() => NOW_MS);
    joiner.boot();

    await expect(
      joinPeer({
        peerUrl: "http://holder.invalid",
        keys: joiner,
        releaseOrdinal: 1,
        signAuth,
        keyEpochStart: null,
        // Openable by the joiner, and the header names somebody else's channel.
        transport: forgingPeer(() => ({
          releaseOrdinal: 1,
          signAuth,
          channelPublicKey: newChannelKeypair().publicKey,
          keyEpochStart: null,
          keys: [],
        })),
        nowMs: () => NOW_MS,
      }),
    ).rejects.toThrow(/channel key/i);
  });

  it("reports the peer's refusal code rather than a bare failure", async () => {
    const holder = escrowNode({ allowlist: {} });
    const joiner = new KeyManager(() => NOW_MS);
    joiner.boot();

    await expect(
      joinPeer({
        peerUrl: "http://holder.invalid",
        keys: joiner,
        releaseOrdinal: 1,
        signAuth,
        keyEpochStart: null,
        transport: holder.transport,
        nowMs: () => NOW_MS,
      }),
    ).rejects.toThrow(/not_allowlisted/);
  });

  /**
   * The liveness probe is a probe, and its status never gates.
   *
   * The case that matters is a peer still in its own join window: it answers
   * `503 escrow_key_unminted` on `/key` while already holding every generation
   * worth having. A joiner that read the probe's status as permission would
   * refuse a peer with keys to give — and in a pair booting together, that is
   * both of them.
   */
  it("still joins a peer whose GET /key does not advertise a generation yet", async () => {
    const holderKeys = new KeyManager(() => NOW_MS);
    holderKeys.boot({ mint: false });
    holderKeys.adoptKeys([
      {
        publicKey: newRecipientKeypair().publicKey,
        secretKey: newRecipientKeypair().secretKey,
        decayAt: NOW_MS + ESCROW_KEY_RETENTION_MS,
      },
    ]);
    const holder = escrowNode({ keys: holderKeys });

    expect((await holder.app.inject({ method: "GET", url: "/key" })).statusCode).toBe(503);

    const joiner = new KeyManager(() => NOW_MS);
    joiner.boot({ mint: false });
    const joined = await joinPeer({
      peerUrl: "http://holder.invalid",
      keys: joiner,
      releaseOrdinal: 1,
      signAuth,
      keyEpochStart: null,
      transport: holder.transport,
      nowMs: () => NOW_MS,
    });
    expect(joined.adopted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("the peer knobs", () => {
  const base = {
    ADDRESSES_FILE: fileURLToPath(new URL("./fixtures/addresses.json", import.meta.url)),
    DATABASE_URL: "postgres://unused",
    RELAYER_KEY: `0x${"11".repeat(32)}`,
    PIN_S3_ENDPOINT: "http://unused",
    PIN_S3_KEY: "k",
    PIN_S3_SECRET: "s",
    PIN_S3_BUCKET: "b",
    ESCROW_MODE: "mock",
    // Required of every escrow-holding node, not only the ones that pull: the
    // holder authenticates a pull by recovering to this key's own address.
    OPERATOR_KEY: NETWORK_OPERATOR_KEY,
  };

  it("defaults to a standalone node with no peer at all", () => {
    const config = loadConfig(base);
    expect(config.escrow.peerUrl).toBeNull();
    expect(config.escrow.peerRequired).toBe(false);
    expect(config.escrow.peerSyncMs).toBe(300_000);
  });

  it("reads the peer URL and the sync interval in seconds", () => {
    const config = loadConfig({
      ...base,
      PEER_URL: "http://peer:8402",
      PEER_SYNC_S: "45",
    });
    expect(config.escrow.peerUrl).toBe("http://peer:8402");
    expect(config.escrow.peerRequired).toBe(false);
    expect(config.escrow.peerSyncMs).toBe(45_000);
  });

  it("refuses a peer URL that is not an http(s) origin", () => {
    for (const value of ["not a url", "ftp://peer", "peer:8402"]) {
      expect(() => loadConfig({ ...base, PEER_URL: value })).toThrow(/PEER_URL/);
    }
  });

  it("reads every accepted spelling of the required flag, and refuses the rest", () => {
    for (const value of ["1", "true", "TRUE"]) {
      const config = loadConfig({ ...base, PEER_URL: "http://peer:8402", PEER_REQUIRED: value });
      expect(config.escrow.peerRequired).toBe(true);
    }
    for (const value of ["0", "false"]) {
      const config = loadConfig({ ...base, PEER_URL: "http://peer:8402", PEER_REQUIRED: value });
      expect(config.escrow.peerRequired).toBe(false);
    }
    // The refusal is the point: `value === "true"` would read this as "off" and
    // hand the operator a node that silently inherits nothing.
    expect(() =>
      loadConfig({ ...base, PEER_URL: "http://peer:8402", PEER_REQUIRED: "yes" }),
    ).toThrow(/PEER_REQUIRED/);
  });

  /** "The first pull must succeed" says nothing without somewhere to pull from. */
  it("refuses the required flag with no peer URL", () => {
    expect(() => loadConfig({ ...base, PEER_REQUIRED: "1" })).toThrow(/PEER_REQUIRED/);
  });
});
