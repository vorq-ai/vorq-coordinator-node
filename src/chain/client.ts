import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type ReadContractReturnType,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import { providerRegistryAbi } from "../abi/providerRegistry.js";
import { viewRead } from "../api/chain-failure.js";
import type { Address, Addresses, Config } from "../config.js";
import { causeChain } from "./revert.js";

/**
 * How long a JobRegistry config read is served from memory. These values change
 * by governance transaction, not by the block, so a short TTL costs one
 * `eth_call` a minute and removes one per request.
 */
export const CHAIN_PARAMS_TTL_MS = 60_000;

/** The header fields the indexer reads. */
export interface Header {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  logsBloom: Hex;
}

const headerOf = (block: {
  number: bigint | null;
  hash: Hex | null;
  parentHash: Hex;
  logsBloom: Hex | null;
}): Header => {
  if (block.number === null || block.hash === null || block.logsBloom === null) {
    throw new Error("the endpoint answered a pending block for a mined one");
  }
  return { number: block.number, hash: block.hash, parentHash: block.parentHash, logsBloom: block.logsBloom };
};

/** The node's handle on the chain: a reader, a signer, and the head. */
export interface Chain {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** The relayer. Pays gas for every relayed op. */
  account: PrivateKeyAccount;
  chain: ViemChain;
  /**
   * The chain's own answer to `latest`, resolved on every call. See {@link headBlockOf}.
   * Raises {@link floor} to the answer.
   */
  headBlock(): Promise<bigint>;
  /**
   * The `latest` header in one read: what the indexer needs to advance, link
   * and skip a block. Raises {@link floor} to its number.
   */
  head(): Promise<Header>;
  /**
   * The newest block this node holds proof of: a receipt it waited for, or a
   * head it polled. `0n` until either has happened. See {@link atFloor}.
   */
  floor(): bigint;
  /** Raise the floor to `block`; lower values are ignored. */
  saw(block: bigint): void;
  /**
   * `waitForTransactionReceipt`, and the floor raised to the receipt's block.
   *
   * Every receipt this node waits for goes through here rather than through the
   * public client, so a read that follows a relay can never be served from a
   * block older than the one the relay landed in.
   */
  receipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt>;
  /**
   * The hash of one block, by number.
   *
   * The indexer's reorg guard is the caller: a block number is not an identity
   * on a chain that can be replaced, and the hash is.
   */
  blockHash(block: bigint): Promise<Hex>;
  /** One block's header, by number. */
  header(block: bigint): Promise<Header>;
  /**
   * Whether one account carries code at `latest`. See {@link hasCodeAt} — the
   * payment doors ask this about the payer before they pin or front gas.
   */
  hasCode(address: Address): Promise<boolean>;
  /**
   * Signs and broadcasts one transaction from the relayer account — **one at a
   * time, process-wide** (R66).
   *
   * The relayer account is the node's scarce resource, and its transaction
   * nonce is a single counter. `sendTransaction` reads
   * `eth_getTransactionCount` at `pending` and signs immediately after, so two
   * calls that overlap read the *same* count and sign two transactions carrying
   * the *same* nonce: only one can ever mine, and if the fees differ the second
   * silently **replaces** the first — relaying an op the caller never asked to
   * have relayed. Measured before this existed: two concurrent relays, two
   * different jobs, both signed with nonce 7.
   *
   * Serialising here rather than at a route is deliberate. The queues in
   * `routes/ops.ts` are keyed by the *contract's* subject — a job, a provider —
   * and answer a different question ("is this op racing another op?"). This one
   * is keyed by nothing, because there is exactly one relayer account per
   * process and it is what everything contends for.
   *
   * **Bounded, in depth and in wait, since R76.** R71 left this queue unbounded
   * on the argument that admission control adds no capacity — true, and beside
   * the point once the queue has callers that are not paying for their place in
   * it. R71 named its own reopen condition (*"a second caller of `relay`
   * appears"*); Task 9 tripped it with `POST /v1/jobs` and measured **50
   * concurrent posts of distinct `job_id`s → 50 admitted relays**, the
   * per-subject `429` no help because a burst across distinct subjects takes
   * distinct keys. Task 10's ask publisher is the third caller and the first
   * whose concurrency is set by the **provider set** rather than by a caller who
   * pays.
   *
   * Latency here is `queue_position × send_RTT`; measured against a transport
   * with a realistic round trip: 50 concurrent relays at 20 ms give p50 576 ms /
   * max 1.16 s, 100 at 50 ms give p50 2.67 s / max 5.35 s, 200 at 50 ms give
   * p50 5.34 s / max 10.7 s — linear, as one serial resource must be. So:
   *
   *   * **`config.relayMaxDepth`** (`RELAY_MAX_DEPTH`, default 32) bounds
   *     how many entries may be admitted at once. At the measured 50 ms RTT that
   *     caps the wait at 1.6 s, inside the doors' own 60 s receipt budget and
   *     under the 2.67 s p50 R71 measured at N=100. Past it this rejects
   *     immediately with {@link RelayUnavailableError} `relay_queue_full`, which
   *     every door answers `503 relay_unavailable`, retryable, through
   *     `sendFailure`'s relayer envelope — **never a `400`**: a full queue is the
   *     node's condition, not the caller's fault.
   *   * **`config.relayQueueTimeoutMs`** (`RELAY_QUEUE_TIMEOUT_MS`, default
   *     10 000) bounds how long one entry may **wait**. `RECEIPT_TIMEOUT_MS`
   *     covers only the receipt, *outside* this queue, so without a deadline a
   *     request could burn its entire budget having never been sent. The
   *     deadline is disarmed the instant the entry's turn arrives: it bounds the
   *     wait and never the send, because abandoning a send already on the wire
   *     would answer "retryable" for a transaction that may mine — the one
   *     answer that must never be given (cf. `504 receipt_timeout`, which is
   *     deliberately *not* retryable for the same reason).
   *
   * An abandoned entry keeps its place in the tail and sends nothing when it
   * gets there, so ordering is untouched and no nonce is consumed.
   *
   * The bound that is still missing, stated plainly: this rations one relayer
   * account and adds no throughput. The only change that adds throughput is a
   * second relayer key — a second nonce sequence and a second queue.
   *
   * `gas` is optional and almost never wanted: viem estimates one, and an
   * estimate is right for every call whose failure is a revert. It is wrong for
   * exactly one caller — `postMany`, which catches each line's revert and
   * succeeds regardless — so the estimate converges on a limit at which the tail
   * of a chunk runs out of gas inside its sub-call and is reported as skipped on a
   * transaction whose receipt says success. That caller computes its own limit;
   * see `batches/worker.ts`.
   */
  relay(request: { to: Address; data: Hex; gas?: bigint }): Promise<Hex>;
}

/**
 * The relayer queue refused this relay, and it is the **node's** condition
 * rather than a verdict on anything the caller signed (R76).
 *
 * A distinct class because `sendFailure`'s discrimination is built on JSON-RPC
 * evidence — a numeric `code` in the `cause` chain, revert data, the endpoint's
 * wording — and this failure never reached an endpoint at all. Without a class
 * to recognise it, a queue refusal would fall into the "nothing answered" branch
 * and be reported as `chain_unreachable`, sending an operator to look at an RPC
 * endpoint that is perfectly healthy.
 */
export class RelayUnavailableError extends Error {
  constructor(
    /** Which bound refused it. Travels to the caller as `error.code`. */
    readonly code: "relay_queue_full" | "relay_queue_timeout",
    message: string,
  ) {
    super(message);
    this.name = "RelayUnavailableError";
  }
}

/** Anything that can read the chain — a bare public client or a whole {@link Chain}. */
export type ChainReader = PublicClient | Chain;

const readerOf = (reader: ChainReader): PublicClient =>
  "publicClient" in reader ? reader.publicClient : reader;

function relayerAccount(relayerKey: string): PrivateKeyAccount {
  // Validated here rather than in the config loader because this is where the
  // shape actually matters. The key itself never appears in the message.
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey)) {
    throw new Error("RELAYER_KEY must be a 0x-prefixed 32-byte hex private key");
  }
  return privateKeyToAccount(relayerKey as `0x${string}`);
}

/**
 * The head this node indexes at: `latest`.
 *
 * Base has one sequencer and 2 s blocks; `safe` trails by minutes and finality by ~20, and a
 * client polls its job row to a terminal status, so either would be added to every job. The price
 * of `latest` is that a reorg is possible, which the indexer's block-hash guard turns into a
 * stopped, not-ready node rather than a silently wrong projection.
 *
 * `cacheTime: 0` because every caller of this wants the head now: viem otherwise
 * serves `getBlockNumber` from a cache whose default is the client's polling
 * interval, and a readiness answer built on a cached head measures the cache.
 */
export async function headBlockOf(reader: ChainReader): Promise<bigint> {
  return readerOf(reader).getBlockNumber({ cacheTime: 0 });
}

/**
 * Whether `address` carries code at `latest`.
 *
 * **This is a money-path question, not a curiosity.** The payment token validates
 * `receiveWithAuthorization` through `SignatureChecker`, which routes an
 * authorizer *with code* to ERC-1271 `isValidSignature` and never to `ecrecover`.
 * A plain EOA signature from an account carrying an EIP-7702 delegation — or from
 * a smart account — therefore recovers correctly off chain and fails on chain with
 * `invalid signature` at `claim`, after this node has pinned the container and
 * fronted the gas for the post. The doors read this **before** they spend either.
 *
 * `blockTag: "latest"` and no memo, deliberately: 7702 code appears and
 * disappears with a single transaction the wallet makes, so an answer older than
 * this request is an answer about a different account. It is one `eth_getCode`
 * per payment, which is the same order as the two signature recoveries beside it.
 */
export async function hasCodeAt(reader: ChainReader, address: Address): Promise<boolean> {
  const code = await readerOf(reader).getCode({ address, blockTag: "latest" });
  // viem answers an account with no code as `undefined`; some endpoints answer
  // `0x`. Both mean the same thing and neither is code.
  return code !== undefined && code !== "0x";
}

/**
 * Builds the chain handle from configuration.
 *
 * `transport` exists so unit tests can drive this over a canned handler; in
 * production it is left out and an HTTP transport to `config.rpcUrl` is used.
 */
export function makeChain(config: Config, transport?: Transport): Chain {
  const chain = defineChain({
    id: config.addresses.chainId,
    name: "vorq",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });

  const account = relayerAccount(config.relayerKey);
  const wire = transport ?? http(config.rpcUrl);

  // `cacheTime: 0`, and it is load-bearing. viem caches `getBlockNumber` for
  // `cacheTime`, which **defaults to `pollingInterval` (4000 ms)** — so the
  // default client answers "what block is it?" with a number up to four seconds
  // old. Measured on the e2e chain at 0.45 s blocks: six blocks behind.
  //
  // `reconcileJob` pins its `getJob` read to that number, and it is the one read
  // whose entire purpose is to serve chain truth *inside* the finality window.
  // Cached, it reported `found: false` for a job this node had relayed and
  // received a receipt for two milliseconds earlier — a `404` on a live job from
  // the mechanism built to prevent exactly that. `found: false` also DELETEs the
  // row, so on the refusal-hook path a stale answer can drop a live one.
  //
  // Set here rather than at the call site: the call site's own docblock already
  // budgets "one `eth_blockNumber` + one `eth_call`" per miss, so a fresh read is
  // what every reader of this code already believes happens, and a second call
  // site would silently inherit the stale default.
  const publicClient = createPublicClient({
    chain,
    transport: wire,
    cacheTime: 0,
  }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport: wire });

  // One tail per relayer account, and there is one account per process. The
  // whole of `sendTransaction` runs inside the queue — the nonce read is part of
  // signing, so serialising only the broadcast would leave the collision exactly
  // where it was.
  let tail: Promise<unknown> = Promise.resolve();
  // Entries admitted and still owned by a caller. Decremented on every exit —
  // sent, refused or abandoned — so a burst cannot leak the queue shut (R76).
  let depth = 0;

  const relay = async ({
    to,
    data,
    gas,
  }: {
    to: Address;
    data: Hex;
    gas?: bigint;
  }): Promise<Hex> => {
    if (depth >= config.relayMaxDepth) {
      throw new RelayUnavailableError(
        "relay_queue_full",
        `${depth} relays are already queued on the relayer account ` +
          `(RELAY_MAX_DEPTH=${config.relayMaxDepth}); retry shortly`,
      );
    }
    depth += 1;

    try {
      // "waiting" is the only state the deadline may fire in. Once the entry's
      // turn arrives the timer is cleared and the send runs to completion: a
      // transaction on the wire must never be answered retryably.
      let state: "waiting" | "sending" | "abandoned" = "waiting";

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (state !== "waiting") return;
          state = "abandoned";
          reject(
            new RelayUnavailableError(
              "relay_queue_timeout",
              `waited ${config.relayQueueTimeoutMs} ms for the relayer account without being ` +
                "sent (RELAY_QUEUE_TIMEOUT_MS); nothing was broadcast, retry shortly",
            ),
          );
        }, config.relayQueueTimeoutMs);
        // Never hold the process open past SIGTERM for a timer that only bounds
        // a wait.
        timer.unref?.();
      });

      // `.then(fn, fn)`: the queue advances whether the transaction in front was
      // broadcast or refused. A tail that stalls on the first failure would wedge
      // every later relay, and a rejected tail nobody handles takes the process
      // down.
      const send = (): Promise<Hex> | undefined => {
        // The abandoned entry still takes its turn and sends nothing, so the
        // ordering of everything behind it is untouched and no nonce is spent.
        if (state === "abandoned") return undefined;
        state = "sending";
        clearTimeout(timer);
        return walletClient.sendTransaction({ account, chain, to, data, gas });
      };
      const run = tail.then(send, send);
      tail = run.then(
        () => undefined,
        () => undefined,
      );

      // `race` attaches a handler to both, so neither an abandoned `run` nor an
      // unraced `deadline` can become an unhandled rejection.
      return (await Promise.race([run, deadline])) as Hex;
    } finally {
      depth -= 1;
    }
  };

  let floor = 0n;
  const saw = (block: bigint): void => {
    if (block > floor) floor = block;
  };

  return {
    publicClient,
    walletClient,
    account,
    chain,
    headBlock: async () => {
      const head = await headBlockOf(publicClient);
      saw(head);
      return head;
    },
    head: async () => {
      const header = headerOf(await publicClient.getBlock({ blockTag: "latest" }));
      saw(header.number);
      return header;
    },
    floor: () => floor,
    saw,
    receipt: async (hash, timeoutMs) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
      saw(receipt.blockNumber);
      return receipt;
    },
    blockHash: async (block) => (await publicClient.getBlock({ blockNumber: block })).hash,
    header: async (block) => headerOf(await publicClient.getBlock({ blockNumber: block })),
    hasCode: (address) => hasCodeAt(publicClient, address),
    relay,
  };
}

/** Where a pinned read looks: the node's floor, or `latest` before it has one. */
export type BlockPin = { blockNumber: bigint } | { blockTag: "latest" };

/**
 * How long a read pinned at the floor waits for a lagging endpoint to reach it:
 * `FLOOR_RETRIES × FLOOR_RETRY_MS`, 3 s — one and a half Base blocks.
 */
const FLOOR_RETRIES = 6;
const FLOOR_RETRY_MS = 500;

/** The endpoint does not have the pinned block yet: `-32001 block not found`, in every spelling seen. */
export function missingBlock(error: unknown): boolean {
  return causeChain(error).some(
    (node) =>
      node.code === -32001 ||
      /block not found|header not found|unknown block/i.test(String(node.message ?? node.details ?? "")),
  );
}

/**
 * Read at the node's floor, not at `latest`.
 *
 * **Measured on Base Sepolia through Infura, 2026-09-23:** the claim relay
 * waited for its receipt and answered `201`; the daemon's `/release` arrived
 * 10 ms later and `getJob` at `latest` answered the pre-claim state, so the
 * DEK was refused (`409 not_claimed`), the fail report was refused for the
 * same reason, and the job sat claimed until reclaim. A load-balanced endpoint
 * is many nodes, and `latest` is whichever one answers — the receipt came from
 * one that had the block, the read from one that did not yet.
 *
 * So a **state read** that authorises or refuses against this node's own
 * receipts — `getJob` behind `/release`, the views behind `/evm/simulate/claim`
 * — is pinned to the newest block this node has proof of (a receipt it waited
 * for, or a head it polled). A node that has the block answers the state at it;
 * a node that does not answers `-32001 block not found`, and the read is asked
 * again for up to {@link FLOOR_RETRIES} attempts rather than served stale.
 * Anything else is thrown unchanged, for the caller's own classification.
 *
 * **Never a simulate.** The pre-relay `eth_call` is a verdict on the
 * transaction as it would mine, and the contract reads `block.timestamp`
 * (`AlreadyExpired`, `ExpiryTooFar`, the fail-grace price); at an older block
 * it refused a valid 24 h order as `ExpiryTooFar` (measured 2026-09-23). Those
 * stay at `latest`.
 *
 * Before the first head poll or receipt the floor is `0n` and the read goes to
 * `latest`, because there is nothing yet to be consistent with.
 */
export async function atFloor<T>(chain: Chain, read: (at: BlockPin) => Promise<T>): Promise<T> {
  const floor = chain.floor();
  if (floor === 0n) return read({ blockTag: "latest" });
  const at: BlockPin = { blockNumber: floor };
  for (let attempt = 1; ; attempt++) {
    try {
      return await read(at);
    } catch (error) {
      if (attempt >= FLOOR_RETRIES || !missingBlock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, FLOOR_RETRY_MS));
    }
  }
}

// ---------------------------------------------------------------------------
// Cached JobRegistry config reads
// ---------------------------------------------------------------------------

/**
 * A single value refreshed at most once per TTL, with concurrent misses sharing
 * one upstream call. Without that sharing, a burst of requests arriving on a
 * cold or just-expired cell would each start their own `eth_call`.
 */
function cell<T>(load: () => Promise<T>) {
  let cached: { value: T; expiresAt: number } | null = null;
  let inflight: Promise<T> | null = null;
  let epoch = 0;

  return {
    get(): Promise<T> {
      const hit = cached;
      if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit.value);
      if (inflight) return inflight;

      const startedAt = epoch;
      const run = load().then((value) => {
        // A bust that landed while this read was in flight means the value was
        // already stale when it arrived; storing it would defeat the very
        // re-check that called bust. The caller that started the read still
        // receives what it read.
        if (epoch === startedAt) {
          cached = { value, expiresAt: Date.now() + CHAIN_PARAMS_TTL_MS };
        }
        return value;
      });
      inflight = run;
      // Release the slot on success and on failure alike, so a transient RPC
      // fault is retried on the next read instead of being latched forever.
      // Both branches are handled, so this derived promise never goes unhandled;
      // callers still observe `run`'s own rejection.
      const release = () => {
        if (inflight === run) inflight = null;
      };
      run.then(release, release);
      return run;
    },
    bust() {
      epoch++;
      cached = null;
      inflight = null;
    },
  };
}

/** The JobRegistry config the node needs at request time. */
export interface ChainParams {
  /** Protocol fee, in basis points. */
  feeBps(): Promise<number>;
  /** Flat gas fee the client funds on top of the cap. */
  gasFee(): Promise<bigint>;
  /** Fee recipient. Mutable on chain (R39) — read here, never from the addresses file. */
  treasury(): Promise<Address>;
  /** Whether an SLA of `secs` may be posted. */
  slaAllowed(secs: number): Promise<boolean>;
  /** Drops every cached value. Used for the re-check immediately before relaying. */
  bust(): void;
}

/**
 * Cached `eth_call` reads of the JobRegistry's configuration.
 *
 * This is the single source for these values. They are deliberately not
 * projected from their config events: the events exist for audit, and a
 * projection would add a second copy that can disagree with the chain.
 */
export function chainParams(reader: ChainReader, addresses: Addresses): ChainParams {
  const client = readerOf(reader);
  const at = { address: addresses.jobRegistry, abi: jobRegistryAbi } as const;

  // R77-off-request-path: every caller of these cells wraps them itself —
  // `post.ts`'s `configRead` and, for `feeBps`, the `viewRead` in
  // `routes/relay.ts` — so the failure is classified there. Nothing here
  // answers an HTTP request directly.
  const feeBps = cell(() => client.readContract({ ...at, functionName: "feeBps" }));
  // R77-off-request-path: as `feeBps` above — reached only through `configRead`.
  const gasFee = cell(() => client.readContract({ ...at, functionName: "gasFee" }));
  // R77-off-request-path: as `feeBps` above — reached only through `configRead`.
  const treasury = cell(() => client.readContract({ ...at, functionName: "treasury" }));

  // One cell per `secs`: the answer differs per value, and the set of SLAs a
  // node is asked about is small and bounded by what providers actually list.
  const sla = new Map<number, ReturnType<typeof cell<boolean>>>();
  const slaCell = (secs: number) => {
    let existing = sla.get(secs);
    if (!existing) {
      // The on-chain view is `allowedSla`; the setter and event are spelled
      // `setSlaAllowed`/`SlaAllowedChanged`. The name here follows the caller's
      // vocabulary, the ABI call follows the contract's.
      // R77-off-request-path: as the three cells above — `configRead` is the
      // only caller and it classifies the failure.
      existing = cell(() =>
        client.readContract({ ...at, functionName: "allowedSla", args: [secs] }),
      );
      sla.set(secs, existing);
    }
    return existing;
  };

  return {
    feeBps: () => feeBps.get(),
    gasFee: () => gasFee.get(),
    treasury: () => treasury.get(),
    slaAllowed: (secs: number) => slaCell(secs).get(),
    bust() {
      feeBps.bust();
      gasFee.bust();
      treasury.bust();
      sla.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Authorisation reads — one per question, pinned to `latest`
// ---------------------------------------------------------------------------

/**
 * The three reads an authorisation decision is made from, in one place.
 *
 * They live here rather than in the module that happens to need them first
 * because more than one door asks these questions and a second implementation of
 * "what does the chain say about this job" is a second answer waiting to
 * disagree (R32). The plan asserted these already existed on the Plan 2 client;
 * they did not — `getJob` was inline in reconcile, `idOf` inline in
 * `resolveProviderId`, and `allowlistStatus` had never been read at all, only
 * projected from its events into Postgres.
 *
 * Two properties are shared by all three and both are load-bearing.
 *
 *   * **The block tag is `latest`, explicitly** (P18). Authorisation must see
 *     the chain as it is now, and a read whose answer is consumed and discarded
 *     inside one request carries none of the projection's reorg exposure — the
 *     book's guard against that is the indexer's, not this call's. At any
 *     trailing tag a provider that claimed a job seconds ago would be refused
 *     its own DEK for the length of the lag. The tag is written out rather than
 *     left to viem's default so the decision is visible at the call site instead
 *     of inherited.
 *   * **They are `viewRead`s** (R77). A storage getter on a frozen contract
 *     cannot revert when this node is configured correctly; when it does, the
 *     node is misconfigured or the endpoint is unwell, and neither is a verdict
 *     on the caller's request. Unwrapped, a dead endpoint would answer a
 *     provider `400 invalid_request, retryable=false` — a promise that its
 *     perfectly good request can never succeed.
 */

/** `getJob`'s 20-field return, derived from the ABI rather than restated. */
export type JobView = ReadContractReturnType<typeof jobRegistryAbi, "getJob">;

/**
 * The chain's own account of one job. `found = false` for a job it never had.
 *
 * Through a {@link Chain} the read is pinned at the node's floor (see
 * {@link atFloor}); a bare client reads `latest`, which is all it can know.
 */
export function getJob(reader: ChainReader, jobRegistry: Address, jobId: Hex): Promise<JobView> {
  const client = readerOf(reader);
  return viewRead("job_read", () => {
    const read = (at: BlockPin) =>
      client.readContract({
        address: jobRegistry,
        abi: jobRegistryAbi,
        functionName: "getJob",
        args: [jobId],
        ...at,
      });
    return "floor" in reader ? atFloor(reader, read) : read({ blockTag: "latest" });
  });
}

/**
 * The registry id an operator address holds, or `0n` for none.
 *
 * The identity comparison every authorisation here makes is **id equality**,
 * never address equality: an operator may be rotated, and the id is what
 * survives it.
 */
export async function idOf(
  reader: ChainReader,
  providerRegistry: Address,
  operator: Address,
): Promise<bigint> {
  const client = readerOf(reader);
  const id = await viewRead("provider_id_read", () =>
    client.readContract({
      address: providerRegistry,
      abi: providerRegistryAbi,
      functionName: "idOf",
      args: [operator],
      blockTag: "latest",
    }),
  );
  return BigInt(id);
}

/**
 * The curation allowlist status of one key: `0` never listed, `1` active, `2`
 * tombstoned.
 *
 * Read from the chain and **not** from the `allowlist` projection, deliberately.
 * The projection trails the head, and the decision this feeds — Task 5's
 * handover — is the one place where being a minute behind means handing key
 * material to an image curation has just revoked.
 */
export async function allowlistStatus(
  reader: ChainReader,
  providerRegistry: Address,
  key: Hex,
): Promise<number> {
  const client = readerOf(reader);
  const status = await viewRead("allowlist_status_read", () =>
    client.readContract({
      address: providerRegistry,
      abi: providerRegistryAbi,
      functionName: "allowlistStatus",
      args: [key],
      blockTag: "latest",
    }),
  );
  return Number(status);
}

// ---------------------------------------------------------------------------
// The boot-time soundness facts
// ---------------------------------------------------------------------------

/**
 * The two live JobRegistry facts the escrow's retention window depends on.
 *
 * A narrow port rather than a `Chain`, so `src/escrow/keys.ts` can assert the
 * soundness inequality against the chain without importing a chain client — the
 * key manager holds secrets and touches nothing else, and it should stay that
 * way. `assertEscrowSoundness` consumes this; {@link slaFacts} is the one
 * implementation, used by `main.ts` at boot and by the test that proves the node
 * refuses to start.
 */
export interface SlaFacts {
  /** `JobRegistry.MAX_EXPIRY`, in seconds. */
  maxExpirySeconds(): Promise<number>;
  /** `JobRegistry.allowedSla(secs)` — whether an order may name this SLA. */
  slaAllowed(secs: number): Promise<boolean>;
}

/**
 * {@link SlaFacts} against a real chain.
 *
 * Uncached, unlike {@link chainParams}'s cells, and not a `viewRead`: these run
 * once at boot, before anything is listening, and there is no caller to answer.
 * A failure here should propagate and stop the process — a node that could not
 * read `MAX_EXPIRY` has not proved its retention window is sound, and booting
 * anyway would be exactly the "a comment asserting soundness is not soundness"
 * failure P3 exists to close.
 */
export function slaFacts(reader: ChainReader, jobRegistry: Address): SlaFacts {
  const client = readerOf(reader);
  const at = { address: jobRegistry, abi: jobRegistryAbi, blockTag: "latest" } as const;

  return {
    // R77-off-request-path: this runs once at boot, before anything is
    // listening, and has no caller to answer — a failure stops the process,
    // which is the behaviour P3 asks for.
    maxExpirySeconds: async () =>
      Number(await client.readContract({ ...at, functionName: "MAX_EXPIRY" })),
    // R77-off-request-path: as `maxExpirySeconds` above — boot-time, no caller.
    slaAllowed: async (secs: number) =>
      await client.readContract({ ...at, functionName: "allowedSla", args: [secs] }),
  };
}
