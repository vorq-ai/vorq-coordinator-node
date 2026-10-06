import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { jobRegistryAbi } from "../../../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../../../src/abi/providerRegistry.js";
import type { Address, Addresses, Env } from "../../../src/config.js";
import { CONTAINER_TAG } from "../../../src/container.js";
import {
  allowlistKeyFor,
  mockMeasurement,
  mockEvidence,
  CHANNEL_SERVICE_ID,
} from "../../../src/escrow/attest.js";
import { commitment, jobIdFor, sealDek } from "../../../src/escrow/container.js";
import { newChannelKeypair } from "../../../src/escrow/channel.js";
import { HANDOVER_AUTH_TYPES } from "../../../src/escrow/handover.js";
import { RELEASE_TYPES, deriveDek, releaseDomain } from "../../../src/escrow/release.js";
import {
  ANVIL_KEYS,
  CLAIM_TYPES,
  RPC_URL,
  allocatePort,
  devnetChain,
  opDomain,
  providerAccount,
  publicClientOf,
  startNodeProcess,
  waitFor,
  type NodeOptions,
  type NodeProcess,
} from "./harness.js";

/**
 * The escrow scenarios' shared machinery: the chain preconditions they establish,
 * the containers they build, and the two doors they knock on.
 *
 * Three things here are load-bearing and are worth reading before a scenario is.
 *
 * **Seeding is a curation-signed transaction, never a redeploy** (P8). The devnet
 * is a long-lived singleton — `make up` runs `docker compose down -v`, which is
 * hard-denied here, and the boot deploy refuses at nonce ≠ 0 anyway — so the one
 * allowlist entry `POST /handover` needs is written onto the running chain by
 * {@link ensureCoordinatorAllowlisted}, idempotently.
 *
 * **The sealed 32 bytes are a SEED** (P4a/P4b). A container built here seals a
 * random seed and encrypts under `HKDF(seed, "vorq-dek" ‖ owner)`, which is
 * what `/release` re-derives from the job's chain-read owner. A helper that
 * sealed a DEK directly would produce containers no release can ever decrypt, and
 * the whole round-trip assertion would be measuring nothing.
 *
 * **`claim` and `fail` are landed directly on chain.** Both are relayer-sent
 * transactions carrying the *provider's* signature — the contract takes the
 * signature as its whole authority and never looks at `msg.sender` — so a
 * scenario that only needs a job in a particular chain state does not have to
 * wait for a node to be ready, open a session, and relay. The one scenario about
 * the node's own op door is `job-lifecycle`, and it still goes the long way.
 */

// ---------------------------------------------------------------------------
// The chain precondition: one curation-signed allowlist entry
// ---------------------------------------------------------------------------

/**
 * Anvil key **#2**, which `Deploy.s.sol` assigns as curation and which
 * `ProviderRegistry.setAllowlistEntry` is `onlyCuration` against.
 *
 * Not a credential, for the same reason `ANVIL_KEYS` is not: anvil prints this
 * mnemonic on every start.
 */
const CURATION_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

/** Curation's account. `addresses.json` publishes the address it derives to. */
export const curationAccount = (): PrivateKeyAccount => privateKeyToAccount(CURATION_KEY);

/**
 * The **network operator** credential every escrow instance in these scenarios
 * signs its handover pulls with. Anvil key #6.
 *
 * Every spawned instance gets the same one, which is the deployment model: a
 * joiner signs its pull with it and a holder authenticates by recovering to a key
 * it holds itself.
 *
 * Not a credential in any real sense — anvil prints this mnemonic on every start
 * — and deliberately not one of the keys that already means something here:
 * curation authorises the allowlist, the relayer pays gas, the provider claims
 * jobs. Reusing any of those would let a confusion between trust domains pass
 * the suite.
 */
export const OPERATOR_KEY = "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e";

/** `allowlistStatus`'s vocabulary: 0 never listed, 1 active, 2 tombstoned. */
const ALLOWLIST_ACTIVE = 1;

/**
 * Makes this build's coordinator measurement an **active** allowlist entry, and
 * answers the key it landed on.
 *
 * **Idempotent by inspection, not by hope.** The entry survives across runs — the
 * devnet is long-lived and nothing here removes it — so the status is read first
 * and an already-active entry costs one `eth_call` and no transaction. That is
 * not only an optimisation: `setAllowlistEntry` is a real transaction on a shared
 * chain, and a helper that re-sent it on every run would put a curation write in
 * every block range every later scenario replays.
 *
 * **The key is the measurement itself** (P9). `allowlistKeyFor(mockMeasurement())`
 * is imported from the module the door itself calls, so a test can never seed one
 * key while the node reads another. The `kind` inside the entry is `"cvm-image"`,
 * matching what the devnet's own deploy writes; the chain stores those bytes
 * opaquely and this node never reads them.
 *
 * A **tombstoned** entry throws rather than being overwritten: status 2 is a
 * curation decision, and a test suite that quietly un-revoked an image would be
 * hiding exactly the state `POST /handover` refuses on.
 */
export async function ensureCoordinatorAllowlisted(addresses: Addresses): Promise<Hex> {
  return ensureAllowlisted(
    addresses,
    allowlistKeyFor(mockMeasurement()),
    `{"kind":"cvm-image","measurement":"${mockMeasurement()}"}`,
    `the coordinator measurement ${mockMeasurement()}`,
  );
}

/**
 * A complete, honest `/handover` body signed by **an arbitrary account**.
 *
 * Everything here is real: a freshly minted channel keypair, evidence bound to it
 * under the channel service id, a valid `HandoverAuth` signature. The only thing
 * the caller lacks is a key curation listed — which is the position of anyone who
 * pulls the published image and runs it, and the whole reason the operator rung
 * exists.
 */
export async function strangerHandoverBody(
  signer: PrivateKeyAccount,
  chainId: number,
): Promise<Record<string, unknown>> {
  const channel = newChannelKeypair();
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  return {
    evidence: mockEvidence(channel.publicKey, 1, CHANNEL_SERVICE_ID),
    channel_pubkey: channel.publicKey.toString("hex"),
    issued_at: Number(issuedAt),
    operator_signature: await signer.signTypedData({
      domain: releaseDomain(chainId),
      types: HANDOVER_AUTH_TYPES,
      primaryType: "HandoverAuth",
      message: { channelPubkey: `0x${channel.publicKey.toString("hex")}` as Hex, issuedAt },
    }),
  };
}

/**
 * One curation-signed allowlist entry, seeded if it is not already active.
 *
 * Kept as the one shared procedure for any entry — read, skip if active, refuse
 * if tombstoned, write, verify — so there is a single place for the tombstone
 * refusal to live.
 */
async function ensureAllowlisted(
  addresses: Addresses,
  key: Hex,
  entry: string,
  label: string,
): Promise<Hex> {
  const client = publicClientOf(addresses.chainId);

  const read = async (): Promise<number> =>
    Number(
      await client.readContract({
        address: addresses.providerRegistry,
        abi: providerRegistryAbi,
        functionName: "allowlistStatus",
        args: [key],
      }),
    );

  const before = await read();
  if (before === ALLOWLIST_ACTIVE) return key;
  if (before === 2) {
    throw new Error(
      `${label} is tombstoned on this devnet (status 2). Curation revoked it; re-activating it ` +
        "from a test would hide the state POST /handover exists to refuse.",
    );
  }

  // `onlyCuration` is the check: any other signer reverts, so nothing here has to
  // assert that this key is the right one — the transaction landing is the proof.
  const curation = curationAccount();
  const wallet = createWalletClient({
    account: curation,
    chain: devnetChain(addresses.chainId),
    transport: http(RPC_URL),
  });
  const hash = await wallet.writeContract({
    address: addresses.providerRegistry,
    abi: providerRegistryAbi,
    functionName: "setAllowlistEntry",
    args: [key, ALLOWLIST_ACTIVE, toHex(Buffer.from(entry, "utf8"))],
    chain: devnetChain(addresses.chainId),
    account: curation,
  });
  await client.waitForTransactionReceipt({ hash });

  const after = await read();
  if (after !== ALLOWLIST_ACTIVE) {
    throw new Error(
      `seeding ${label} left allowlistStatus(${key}) at ${after}, not ${ALLOWLIST_ACTIVE}`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// A container, built the way a client SDK must build one
// ---------------------------------------------------------------------------

/** A container v1 whose wrap is sealed to a live escrow key, and its plaintext. */
export interface EscrowContainer {
  /** The sealed-box plaintext. **A seed, not the DEK** (P4b). */
  seed: Buffer;
  /** `HKDF-SHA256(seed, "", "vorq-dek" ‖ owner20, 32)` — what the ciphertext used. */
  dek: Buffer;
  seedWrap: Buffer;
  ciphertext: Buffer;
  /** `keccak256(ciphertext)`, the digest `/release` is handed in place of the payload. */
  ctHash: Hex;
  /** `keccak256(version ‖ seed_wrap ‖ ct_hash)` — what the order signs. */
  c: Hex;
  /** `keccak256(owner ‖ c)`. */
  jobId: Hex;
  /** `version ‖ seed_wrap ‖ ciphertext`, ready for the post door. */
  bytes: Buffer;
  plaintext: string;
}

/**
 * Builds a container for `owner`, sealed to `escrowPublicKey`.
 *
 * The derivation is the shipped `deriveDek`, imported rather than restated: the
 * whole point of the round-trip assertion is that the key `/release` hands back
 * opens *this* ciphertext, and a second copy of the KDF here could drift and the
 * test would still pass with both halves wrong.
 *
 * The ciphertext layout is `iv(12) ‖ body ‖ tag(16)`, AES-256-GCM, matching
 * `test/release.test.ts` so one reader is enough for both.
 */
export function escrowContainer(
  owner: Address,
  escrowPublicKey: Buffer,
  plaintext: string,
): EscrowContainer {
  const seed = randomBytes(32);
  const dek = deriveDek(seed, owner);
  const seedWrap = sealDek(seed, escrowPublicKey);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const ciphertext = Buffer.concat([iv, body, cipher.getAuthTag()]);

  const ctHash = keccak256(ciphertext as unknown as Uint8Array);
  const c = commitment(seedWrap, Buffer.from(ctHash.slice(2), "hex"));

  return {
    seed,
    dek,
    seedWrap,
    ciphertext,
    ctHash,
    c,
    jobId: jobIdFor(owner, c),
    bytes: Buffer.concat([CONTAINER_TAG, seedWrap, ciphertext]),
    plaintext,
  };
}

/** Opens what a container committed to, or throws. */
export function openCiphertext(ciphertext: Buffer, dek: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", dek, ciphertext.subarray(0, 12));
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(12, ciphertext.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// The two escrow doors
// ---------------------------------------------------------------------------

/** `GET /key`'s body, as a scenario reads it. */
export interface KeyAnnouncementBody {
  escrow_public_key: string;
  evidence: { measurement: string; report_data: string; release: number };
  issued_at: number;
}

/** The current generation a node advertises, waiting out the join window. */
export async function escrowPublicKeyOf(node: {
  baseUrl: string;
  json<T>(path: string): Promise<{ status: number; body: T }>;
}): Promise<Buffer> {
  const announced = await waitFor(
    `${node.baseUrl} to advertise an escrow generation`,
    async () => {
      const answer = await node.json<KeyAnnouncementBody>("/key");
      return answer.status === 200 ? answer.body : null;
    },
    { timeoutMs: 60_000, intervalMs: 100 },
  );
  return Buffer.from(announced.escrow_public_key, "hex");
}

/** A `/release` body, every field of which but the signature is signed. */
export interface ReleaseBody {
  job_id: string;
  seed_wrap: string;
  ct_hash: string;
  response_pubkey: string;
  issued_at: number;
  signature: string;
}

/**
 * A signed release request from a provider **operator** wallet.
 *
 * The domain is the escrow's own third namespace (`VORQ Escrow`, version 1, the
 * real chain id) — never the session handshake's and never the registries'.
 */
export async function signedRelease(
  operator: PrivateKeyAccount,
  fields: Omit<ReleaseBody, "signature">,
  chainId: number,
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

/** The envelope every escrow refusal carries (P13: the code lives in `error`). */
export interface ErrorEnvelope {
  error: { type: string; code: string | null; message: string; param?: string | null };
}

/** A release answer: the sealed bytes on success, the envelope on a refusal. */
export type ReleaseAnswer =
  | { status: 200; body: { dek_sealed: string } }
  | { status: number; body: ErrorEnvelope };

// ---------------------------------------------------------------------------
// Landing `claim` and `fail` on chain directly
// ---------------------------------------------------------------------------

const relayerWallet = (chainId: number) =>
  createWalletClient({
    account: privateKeyToAccount(ANVIL_KEYS.relayer),
    chain: devnetChain(chainId),
    transport: http(RPC_URL),
  });

const FAIL_TYPES = {
  Fail: [
    { name: "jobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const SETTLE_TYPES = {
  Settle: [
    { name: "jobId", type: "bytes32" },
    { name: "completionTok", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

const nowSecondsBigInt = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/**
 * Every job these scenarios have claimed and not yet resolved.
 *
 * **The devnet's provider capacity is a shared, finite resource** and this is the
 * one thing in this suite that consumes it: `claim` increments `activeJobs` and
 * only a terminal transition gives it back. `effectiveCap` is 8 on this chain, so
 * a run that claimed nine jobs and resolved none would leave the registry at
 * capacity and every later `claim` — in this suite and in `job-lifecycle` — would
 * revert `AtCapacity`, on a chain nothing here can reset (P8).
 *
 * Registering the claim here rather than asking each scenario to remember is
 * deliberate: a scenario that failed halfway would be exactly the one that forgot.
 */
const outstandingClaims: { addresses: Addresses; jobId: Hex }[] = [];

/**
 * Settles every job still claimed by this file, returning the capacity.
 *
 * **Settle rather than fail**: `fail` past its 300 s grace applies `-40` to the
 * provider's reputation, and `effectiveCap` is a function of reputation — so a
 * cleanup that used it would shrink the very resource it exists to return, a
 * little more on every run. A settle inside the SLA is free.
 *
 * Best effort by construction: a job a scenario already resolved answers
 * `NotClaimed`, which is the expected outcome and not a failure of cleanup.
 */
export async function resolveOutstandingClaims(): Promise<void> {
  const pending = outstandingClaims.splice(0, outstandingClaims.length);
  for (const { addresses, jobId } of pending) {
    try {
      if ((await jobStateOf(addresses, jobId)) !== 1) continue;
      const provider = providerAccount();
      const issuedAt = nowSecondsBigInt();
      const completionTok = 1;
      const signature = await provider.signTypedData({
        domain: opDomain(addresses.chainId, addresses.jobRegistry),
        types: SETTLE_TYPES,
        primaryType: "Settle",
        message: { jobId, completionTok, issuedAt },
      });
      const wallet = relayerWallet(addresses.chainId);
      const hash = await wallet.writeContract({
        address: addresses.jobRegistry,
        abi: jobRegistryAbi,
        functionName: "submitAndSettle",
        args: [jobId, completionTok, toHex(Buffer.from(`cleanup-${jobId}`, "utf8")), issuedAt, signature],
        chain: devnetChain(addresses.chainId),
        account: wallet.account,
      });
      await publicClientOf(addresses.chainId).waitForTransactionReceipt({ hash });
    } catch {
      // A job somebody already resolved, or a chain that has moved on. Cleanup
      // never fails a run.
    }
  }
}

/**
 * Claims a job on chain: the **provider's** signature, landed from the relayer.
 *
 * `JobRegistry.claim` never reads `msg.sender` — the operator's EIP-712 signature
 * is the whole authority — so this is the same transition the node's op door
 * produces, without a session or a ready index in the way.
 */
export async function claimOnChain(addresses: Addresses, jobId: Hex): Promise<bigint> {
  const provider = providerAccount();
  const issuedAt = nowSecondsBigInt();
  const signature = await provider.signTypedData({
    domain: opDomain(addresses.chainId, addresses.jobRegistry),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: { jobId, issuedAt },
  });

  const wallet = relayerWallet(addresses.chainId);
  const hash = await wallet.writeContract({
    address: addresses.jobRegistry,
    abi: jobRegistryAbi,
    functionName: "claim",
    args: [jobId, issuedAt, signature],
    chain: devnetChain(addresses.chainId),
    account: wallet.account,
  });
  const receipt = await publicClientOf(addresses.chainId).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`claim reverted for ${jobId}`);
  // The claim has taken one of the provider's eight capacity slots on a chain
  // nothing here can reset. See {@link resolveOutstandingClaims}.
  outstandingClaims.push({ addresses, jobId });
  return receipt.blockNumber;
}

/** Aborts a claimed job with the provider's `Fail` signature, landed from the relayer. */
export async function failOnChain(addresses: Addresses, jobId: Hex): Promise<bigint> {
  const provider = providerAccount();
  const issuedAt = nowSecondsBigInt();
  const signature = await provider.signTypedData({
    domain: opDomain(addresses.chainId, addresses.jobRegistry),
    types: FAIL_TYPES,
    primaryType: "Fail",
    message: { jobId, issuedAt },
  });

  const wallet = relayerWallet(addresses.chainId);
  const hash = await wallet.writeContract({
    address: addresses.jobRegistry,
    abi: jobRegistryAbi,
    functionName: "fail",
    args: [jobId, issuedAt, signature],
    chain: devnetChain(addresses.chainId),
    account: wallet.account,
  });
  const receipt = await publicClientOf(addresses.chainId).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`fail reverted for ${jobId}`);
  return receipt.blockNumber;
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** The payment token's balance for one address — how a refund is observed. */
export async function tokenBalance(addresses: Addresses, holder: Address): Promise<bigint> {
  const client: PublicClient = publicClientOf(addresses.chainId);
  return client.readContract({ address: addresses.usdc, abi: ERC20, functionName: "balanceOf", args: [holder] });
}

/**
 * The live flat gas fee — the one leg `fail` and `reclaim` pay the treasury, so a
 * refund is `pulled − gasFee`, never `pulled`. It is snapshotted on the row at post
 * and nothing in this suite moves it, so the live read is the snapshot.
 */
export async function gasFeeOf(addresses: Addresses): Promise<bigint> {
  const client = publicClientOf(addresses.chainId);
  return client.readContract({ address: addresses.jobRegistry, abi: jobRegistryAbi, functionName: "gasFee" });
}

/**
 * The registry id a provider operator resolves to.
 *
 * Read from the chain rather than assumed to be `1`: the forged-row scenario has
 * to write the id a Postgres-reading implementation would have believed, and an
 * id this suite invented would forge a row that no implementation could have
 * acted on — which would prove nothing.
 */
export async function providerIdOf(addresses: Addresses, operator: Address): Promise<bigint> {
  const client = publicClientOf(addresses.chainId);
  const id = await client.readContract({
    address: addresses.providerRegistry,
    abi: providerRegistryAbi,
    functionName: "idOf",
    args: [operator],
  });
  return BigInt(id);
}

/**
 * A provider's reputation score — how "inside the grace window" is observed.
 *
 * `fail` prices at landing time: strictly past `claimedAt + FAIL_GRACE` it
 * applies `-40`, and inside it applies nothing. The money moves the same way either
 * way — gas fee to the treasury, the rest to the owner — so the reputation is the
 * only thing that distinguishes the free escape the key-loss path promises from an
 * ordinary penalised abort.
 */
export async function reputationOf(addresses: Addresses, providerId: bigint): Promise<bigint> {
  const client = publicClientOf(addresses.chainId);
  const score = await client.readContract({
    address: addresses.providerRegistry,
    abi: providerRegistryAbi,
    functionName: "reputationOf",
    args: [Number(providerId)],
  });
  return BigInt(score);
}

/** The head block's timestamp, in seconds — the clock `expiresAt` is compared to. */
export async function chainNow(addresses: Addresses): Promise<bigint> {
  const block = await publicClientOf(addresses.chainId).getBlock({ blockTag: "latest" });
  return block.timestamp;
}

/** The chain's own account of a job, read the way `/release` reads it. */
export async function jobStateOf(addresses: Addresses, jobId: Hex): Promise<number> {
  const client = publicClientOf(addresses.chainId);
  const view = await client.readContract({
    address: addresses.jobRegistry,
    abi: jobRegistryAbi,
    functionName: "getJob",
    args: [jobId],
  });
  return Number((view as { state: number }).state);
}

// ---------------------------------------------------------------------------
// An escrow instance: the real `src/main.ts`, with the escrow on
// ---------------------------------------------------------------------------

export interface EscrowNodeOptions extends NodeOptions {
  /** `RELEASE_ORDINAL`. Defaults to the shipped `1` (P19). */
  releaseOrdinal?: number;
  /**
   * `PEER_URL` — the peer this instance pulls from.
   *
   * One URL, both topologies: a mirrored pair sets it on **both** instances,
   * pointing at each other (P6), and a successor sets it at its predecessor.
   */
  peerUrl?: string;
  /**
   * `PEER_REQUIRED` — the first pull is boot-critical.
   *
   * A successor sets it: the mint is deferred until the pull lands and a failure
   * is a failed boot. A mirrored pair must not, or neither instance can boot
   * until the other is up.
   */
  peerRequired?: boolean;
  /** `PEER_SYNC_S`, seconds. The floor the loader allows is 5. */
  peerSyncSeconds?: number;
  /** `ESCROW_CLOCK_OFFSET_MS` — the dev-only key-lifecycle offset (P22). */
  clockOffsetMs?: number;
  /** `ESCROW_SWEEP_INTERVAL_MS`. The loader's floor is 1000. */
  sweepIntervalMs?: number;
}

/**
 * Spawns a real `src/main.ts` with `ESCROW_MODE=mock`.
 *
 * **A process, not an in-process app**, and that is the whole reason these
 * scenarios are worth running: the boot order under test is `main.ts`'s —
 * soundness against the live chain, the epoch marker, the required join *before*
 * anything listens, the deferred mint, the standing peer sync — and none of it
 * exists in an app assembled by `buildApp`.
 */
export async function startEscrowNode(options: EscrowNodeOptions): Promise<NodeProcess> {
  const env: Env = {
    ESCROW_MODE: "mock",
    RELEASE_ORDINAL: String(options.releaseOrdinal ?? 1),
    // Every instance carries the operator key, whether or not it pulls: a node
    // that later gains a peer URL must not need a redeploy to be able to sign.
    OPERATOR_KEY: OPERATOR_KEY,
    ...(options.peerUrl === undefined ? {} : { PEER_URL: options.peerUrl }),
    ...(options.peerRequired === true ? { PEER_REQUIRED: "1" } : {}),
    ...(options.peerSyncSeconds === undefined
      ? {}
      : { PEER_SYNC_S: String(options.peerSyncSeconds) }),
    ...(options.clockOffsetMs === undefined
      ? {}
      : { ESCROW_CLOCK_OFFSET_MS: String(options.clockOffsetMs) }),
    ...(options.sweepIntervalMs === undefined
      ? {}
      : { ESCROW_SWEEP_INTERVAL_MS: String(options.sweepIntervalMs) }),
    ...options.env,
  };
  return startNodeProcess({ ...options, env });
}

/** A port drawn before the node that will bind it — the symmetric pair needs this. */
export { allocatePort };

// ---------------------------------------------------------------------------
// A valve on a peer link
// ---------------------------------------------------------------------------

/**
 * An HTTP pass-through in front of a peer, with a valve.
 *
 * **Scenario 4's B → A direction is otherwise a race.** A replica's sync tick is
 * bounded below at 5 s by the loader, its first tick fires at boot, and the
 * assertion that has to come first — *A cannot open a wrap sealed to B's key* —
 * is only meaningful before A has pulled. Standing a closed valve in A's peer
 * link makes that ordering a fact rather than a hope: A cannot reach B at all
 * until the scenario opens it, and the propagation that follows is one tick
 * against a link that started working.
 *
 * Closed answers `503`, which `startPeerSync` treats as any other unreachable
 * peer — logged, non-fatal, retried next tick.
 */
export interface PeerGate {
  url: string;
  open(): void;
  close(): void;
  /** How many requests reached the upstream. */
  forwarded(): number;
  stop(): Promise<void>;
}

export async function startPeerGate(upstream: string): Promise<PeerGate> {
  let isOpen = false;
  let forwarded = 0;

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        if (!isOpen) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "gate_closed" } }));
          return;
        }
        forwarded += 1;
        try {
          const body = Buffer.concat(chunks);
          const answer = await fetch(`${upstream}${request.url ?? "/"}`, {
            method: request.method,
            headers: { "content-type": "application/json" },
            body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
          });
          const text = await answer.text();
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(text);
        } catch (error) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: String(error) } }));
        }
      })();
    });
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the peer gate did not bind");

  return {
    url: `http://127.0.0.1:${address.port}`,
    open: () => {
      isOpen = true;
    },
    close: () => {
      isOpen = false;
    },
    forwarded: () => forwarded,
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
