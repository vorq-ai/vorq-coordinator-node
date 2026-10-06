import {
  custom,
  decodeFunctionData,
  parseTransaction,
  encodeErrorResult,
  encodeFunctionResult,
  HttpRequestError,
  RpcRequestError,
  type Abi,
  type Hex,
} from "viem";
import { askRegistryAbi } from "../../src/abi/askRegistry.js";
import { jobRegistryAbi } from "../../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../../src/abi/providerRegistry.js";
import { makeChain, type Chain } from "../../src/chain/client.js";
import type { Addresses, Config } from "../../src/config.js";
import { MAX_BLOB_BYTES } from "../../src/api/routes/files.js";

/**
 * A canned JSON-RPC endpoint, so the write doors can be driven without a chain.
 *
 * `makeChain` takes a transport for exactly this reason. Everything the relay
 * path touches is answered here — nonce, fees, gas, broadcast, receipt — which
 * is what lets a test assert on the **bytes** the node would have sent rather
 * than on a mock of its own intent. Two properties matter and both are
 * deliberate:
 *
 *   * **every request is recorded**, so "nothing was relayed" is provable by the
 *     absence of `eth_sendRawTransaction` rather than by trusting a status code;
 *   * **an `eth_call` that decodes to a mutating function is the pre-relay
 *     simulate**, and is answered from {@link StubOptions.simulate}. A view call
 *     is answered from {@link StubOptions.views}. That split is what makes "the
 *     simulate reverted" expressible without stubbing the whole EVM.
 */

/** A valid secp256k1 scalar. Not a credential — no chain has ever used it. */
export const RELAYER_KEY = `0x${"11".repeat(32)}` as const;

export const ADDRESSES: Addresses = {
  chainId: 97,
  deployBlock: 0,
  jobRegistry: "0x1111111111111111111111111111111111111111",
  providerRegistry: "0x2222222222222222222222222222222222222222",
  askRegistry: "0x3333333333333333333333333333333333333333",
  usdc: "0x4444444444444444444444444444444444444444",
  decimals: 6,
  tokenDomain: { name: "USDC", version: "2" },
};

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    getLogsCap: 5000,
    dbUrl: process.env.TEST_DATABASE_URL ?? "postgres://unused",
    relayerKey: RELAYER_KEY,
    blockTimeMs: 60_000,
    port: 8402,
    readyLagBlocks: 30,
    // No browser calls a node under test. Spec 02: an empty list registers no
    // CORS at all, which is the shipped default.
    corsOrigins: [],
    maxBlobBytes: MAX_BLOB_BYTES,
    fileRetentionSeconds: 2_592_000,
    pinS3: {
        endpoint: "http://127.0.0.1:1",
        key: "unused",
        secret: "unused",
        bucket: "unused",
        region: "us-east-1",
      },
    relayMaxDepth: 32,
    relayQueueTimeoutMs: 10_000,
    relayerLowBalanceGwei: 50_000_000,
    // The shipped default: a node hosts no escrow unless an operator asks for
    // one, so every suite that does not care about the escrow gets the same
    // node it had before Plan 3 — the doors exist and refuse.
    escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 },
    match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
    jobRateLimit: 0,
    addresses: ADDRESSES,
    ...overrides,
  };
}

/** How a stubbed pre-relay simulate answers. */
export type Simulate =
  | { kind: "ok" }
  /** Reverts with a custom error of one of the two registries. */
  | { kind: "revert"; errorName: string }
  /** Reverts with bytes neither registry's ABI can decode — the payment token's case. */
  | { kind: "opaque"; data: Hex };

export interface StubOptions {
  /** What `eth_getBalance` answers for any address. One ether when omitted. */
  balance?: bigint;
  /**
   * `functionName` → the value `eth_call` should decode to, **or a function of
   * the decoded arguments**.
   *
   * The second form exists because several of the views this node reads are
   * *mappings*: `allowedSla(uint32)`, `allowlistStatus(bytes32)`, `idOf(address)`.
   * One canned answer per function name cannot express a mapping at all — it
   * answers the same thing for every key — and the escrow's boot check is
   * precisely about *which* keys of `allowedSla` are set. A stub that could only
   * say "all or none" would let an unsound configuration pass as easily as a
   * sound one.
   */
  views?: Record<string, unknown | ((args: readonly unknown[]) => unknown)>;
  /** What the pre-relay simulate does. A function so it can change per call. */
  simulate?: () => Simulate;
  /** The head `latest` resolves to — the one this node indexes at. */
  latestBlock?: bigint;
  /**
   * `eth_getCode`, by address (lower-cased). Anything not named answers `0x`.
   *
   * The payment doors read this about the payer before they pin or front gas: a
   * code-bearing authorizer is validated by the payment token through ERC-1271,
   * so its plain EOA authorization can never be collected. Without a stub that
   * can *say* an account has code, that refusal is unreachable and the door's
   * only observable behaviour is the happy path.
   */
  code?: Record<string, Hex>;
  receiptStatus?: "success" | "reverted";
  /**
   * The transaction count **before any broadcast**. Every broadcast advances it,
   * exactly as a `pending` count does on a real endpoint — see
   * {@link StubChain.broadcasts}.
   */
  transactionCount?: number;
  /**
   * Called **per broadcast**: return an error to refuse that one,
   * `undefined` to let it through (R66). Nothing is recorded in
   * {@link StubChain.broadcasts} for a refused send — the endpoint refused the
   * bytes.
   *
   * Per-call, like {@link StubOptions.simulate}, because a pass that relays
   * several transactions needs to fail exactly one of them: "the sweep carries
   * on past a failure" is a property a stub that could only refuse all or none
   * cannot express.
   */
  sendError?: () => unknown;
  /**
   * If set, **every** `eth_call` throws this instead of answering — the
   * pre-relay simulate and the registry floor read alike.
   *
   * This exists because the suite could not see the failure it was most likely
   * to meet (R72, and the third instance of R64/R65): the stub could refuse a
   * *broadcast* and nothing else, so every test of a failed chain call was
   * really a test of a failed broadcast, and the whole first half of the op
   * pipeline — where a dead endpoint actually strikes, since the simulate is the
   * first chain call a job op makes — could not be driven off the happy path at
   * all. An unfaithful stub does not merely leave a branch untested; it bounds
   * what the tests are *able* to observe, and the branch that answered a dead
   * endpoint `409 {ok:false, reason:"unknown"}` lived there for exactly that
   * reason.
   *
   * Deliberately not limited to the mutating call: `set_identity` and
   * `request_capacity` read `lastIdentityAt`/`lastCapacityAt` **before** they
   * simulate, so a view that cannot fail cannot express what those two ops meet
   * first.
   *
   * Distinct from {@link StubOptions.simulate}'s `revert`/`opaque`, which are the
   * *contract* answering. This is the endpoint failing to answer.
   */
  callError?: () => unknown;
  /**
   * The `logs` array of every receipt this stub answers with.
   *
   * `setAsks` **skips rather than reverts** (R29), so "the transaction
   * succeeded" and "the entry landed" are different facts and only an
   * `AsksPublished` log distinguishes them. A stub whose receipt always carries
   * an empty `logs` can express neither the proof nor its absence, and the
   * publisher's whole confirmation rule would be untestable — R64/R65's lesson
   * one door further along.
   */
  receiptLogs?: () => unknown[];
  /**
   * Answer `eth_getTransactionReceipt` with `null`, as an endpoint does for a
   * transaction that was accepted and has not mined.
   *
   * The state every "no receipt in time" door is about, and until this existed
   * the suite could not enter it: the stub always answered with a mined receipt,
   * so a broadcast transaction that never confirms — the one case where
   * retryability is a promise about bytes already on the wire — was not
   * expressible at all (R64/R65). viem keeps polling and its own timeout is what
   * ends the wait, so a test drives this with fake timers rather than by
   * waiting a minute.
   */
  receiptMissing?: boolean;
  /**
   * How long `eth_sendRawTransaction` takes to answer.
   *
   * The relayer queue's depth and wait bounds (R76) are properties of a *serial*
   * resource, and a send that answers immediately leaves no queue to observe:
   * with a zero-cost send the second caller never waits and the deadline never
   * fires. This is the send RTT R71 measured the queue's latency against.
   */
  sendDelayMs?: number;
}

export interface StubChain {
  chain: Chain;
  /** Every JSON-RPC request the node made, in order. */
  requests: { method: string; params: unknown }[];
  /** Just the broadcasts. Empty means nothing was relayed. */
  broadcasts: string[];
  /**
   * The **calldata** of every broadcast, in order — the raw bytes parsed back
   * into the `data` the node put on the wire.
   *
   * Asserting on this rather than on a recorded intent is what makes "the
   * publisher encodes calldata from the stored values" (R54) a testable claim
   * instead of a promise: the bytes here are the ones a chain would execute.
   */
  relayed: Hex[];
  /**
   * The **gas limit** of every broadcast, likewise parsed back off the wire, and
   * `undefined` where the node let viem estimate one.
   *
   * Read rather than dropped because for `postMany` the estimate is the wrong
   * question: that call succeeds however many of its lines it skipped, so
   * `eth_estimateGas` converges on a limit at which the tail of a chunk runs out
   * of gas and is silently refused. Only an explicit limit is observable, and only
   * from the signed transaction.
   */
  relayedGas: (bigint | undefined)[];
  /** The `data` of every `eth_call` that decoded to a mutating function. */
  simulated: Hex[];
  /**
   * The **sender** of every `eth_call` that decoded to a mutating function.
   *
   * R64/R65 again, on the claim the pre-relay simulate rests on: *"the simulate
   * runs from the relayer's address, not from the signer's — a simulate from any
   * other sender is a simulate of a different transaction."* This stub used to
   * destructure `const [call] = params as [{ to, data }]` and drop `from` on the
   * floor, so no assertion in this suite could observe the sender: changing
   * `account: chain.account.address` to anything at all, or deleting it, left
   * every test green. A property no test can see is held up by its comment.
   *
   * `undefined` where the node sent no `from` — which is itself the failure, and
   * is what an assertion here catches.
   */
  simulatedFrom: (string | undefined)[];
  /**
   * The greatest number of requests this stub had in flight at one instant.
   *
   * **This is what makes the event-loop hop below testable** (R67). Every
   * concurrency property in this suite depends on the hop, and until this
   * counter existed the hop was held up by nothing but a comment: swapping it
   * for a microtask left all 15 `api-ops` tests green, and with the hop gone the
   * per-subject queue could be deleted and the suite was *still* green. A test
   * that asserts this exceeds 1 goes red the moment the hop goes.
   */
  maxInFlight: number;
}

/**
 * The hash the `n`th broadcast (1-based) is answered with.
 *
 * **Distinct per broadcast, and that is not cosmetic.** A constant hash
 * deadlocks any concurrency test above two in-flight relays: viem's
 * `waitForTransactionReceipt` dedupes observers by hash, so at N ≥ 8 all N
 * broadcasts happen, exactly one `eth_getTransactionReceipt` is issued, and
 * nothing else ever resolves. A future test that tried three would hang rather
 * than fail — the worst failure mode for a CI job.
 */
export const stubTxHash = (index: number): Hex => `0x${index.toString(16).padStart(64, "e")}`;

const ABIS: { abi: Abi; names: Set<string> }[] = [
  { abi: jobRegistryAbi as Abi, names: new Set<string>() },
  { abi: providerRegistryAbi as Abi, names: new Set<string>() },
  { abi: askRegistryAbi as Abi, names: new Set<string>() },
];

/**
 * The relayed mutations. An `eth_call` naming one of these is the simulate.
 *
 * `post` and `cancel` joined the five ops when the client's write doors landed:
 * without them here an `eth_call` carrying `post` calldata is taken for a view,
 * and `POST /v1/jobs` cannot be driven off the happy path at all — its simulate
 * would fail with `no stub for view post` and every relay test would be
 * measuring the stub's own guard instead of the door (R64, R65).
 */
const MUTATIONS = new Set([
  "claim",
  "submitAndSettle",
  "fail",
  "setIdentity",
  "requestCapacity",
  "post",
  // The batch worker's posting door. Here for `post`'s reason one level up: a
  // `postMany` taken for a view would make the whole worker undrivable, and its
  // interesting behaviour — a line skipped with a receipt while its neighbours
  // land — is only observable through a real relay and a real receipt.
  "postMany",
  "cancel",
  // The ask publisher's one call. Present for the same reason `post` is: without
  // it an `eth_call` carrying `setAsks` calldata is taken for a view and answered
  // `no stub for view setAsks`, so a test would measure the stub's own guard
  // (R64, R65). The publisher deliberately does not simulate — `setAsks` skips
  // rather than reverts, so a simulate proves nothing (R29) — but the stub must
  // be able to express the call either way.
  "setAsks",
  // The reclaim keeper's one call. Here for the same reason as the rest: it is a
  // mutation the node simulates before relaying, and a stub that answered it as
  // a view would make the keeper's whole lost-race path — the case where a
  // provider settles between the projection read and the relay — undrivable.
  "reclaim",
]);

function decodeCall(data: Hex): { abi: Abi; functionName: string; args: readonly unknown[] } {
  for (const { abi } of ABIS) {
    try {
      const decoded = decodeFunctionData({ abi, data });
      return { abi, functionName: decoded.functionName, args: decoded.args ?? [] };
    } catch {
      // Not this ABI's selector.
    }
  }
  throw new Error(`stub-chain: no ABI decodes ${data.slice(0, 10)}`);
}

const hexQuantity = (value: bigint | number): Hex => `0x${BigInt(value).toString(16)}`;

export function stubChain(config: Config, options: StubOptions = {}): StubChain {
  const requests: { method: string; params: unknown }[] = [];
  const broadcasts: string[] = [];
  const simulated: Hex[] = [];
  const simulatedFrom: (string | undefined)[] = [];
  // Assigned before it is read: the handler only runs once a caller has the
  // object back and has made a request through it.
  const relayed: Hex[] = [];
  const relayedGas: (bigint | undefined)[] = [];
  const stub = {
    requests,
    broadcasts,
    simulated,
    simulatedFrom,
    relayed,
    relayedGas,
    maxInFlight: 0,
  } as StubChain;
  let inFlight = 0;

  const latest = options.latestBlock ?? 1000n;
  const receiptStatus = options.receiptStatus ?? "success";

  const block = (numberValue: bigint) => ({
    number: hexQuantity(numberValue),
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`,
    timestamp: hexQuantity(1_800_000_000n),
    baseFeePerGas: hexQuantity(1_000_000_000n),
    gasLimit: hexQuantity(30_000_000n),
    gasUsed: "0x0",
    miner: `0x${"00".repeat(20)}`,
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    transactions: [],
    uncles: [],
    sha3Uncles: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    size: "0x0",
    nonce: "0x0000000000000000",
    mixHash: `0x${"00".repeat(32)}`,
  });

  const handler = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      requests.push({ method, params });
      inFlight += 1;
      if (inFlight > stub.maxInFlight) stub.maxInFlight = inFlight;
      try {
        return await answer(method, params);
      } finally {
        inFlight -= 1;
      }
    },
  };

  const answer = async (method: string, params?: unknown): Promise<unknown> => {
      // **Cross the event loop, exactly once, before answering anything.**
      //
      // A real transport is a socket: every call yields to the event loop, so two
      // in-flight requests interleave. A stub that resolves in a microtask does
      // not, and the difference is not cosmetic — it silently removes all
      // concurrency from this suite. Measured: without this hop, two `inject`
      // calls made together run strictly one after the other, because the first
      // request's whole pipeline drains inside one macrotask turn while the
      // second is still waiting on `inject`'s own dispatch. A test for the
      // per-subject op queue then passes with the queue deleted, because the
      // harness was doing the serialising.
      //
      // **This is enforced by a test, not by this comment** (R67):
      // `api-ops.test.ts` asserts {@link StubChain.maxInFlight} exceeds 1.
      // Replacing this line with a microtask makes that assertion read 1 and go
      // red. The file already carried a "not needed here" comment about
      // `retryCount` that was exactly backwards, which is how much a comment is
      // worth as enforcement.
      await new Promise((resolve) => setImmediate(resolve));

      switch (method) {
        case "eth_chainId":
          return hexQuantity(config.addresses.chainId);

        case "eth_blockNumber":
          return hexQuantity(latest);

        case "eth_getCode": {
          const [address] = params as [string, string];
          return options.code?.[address.toLowerCase()] ?? "0x";
        }

        case "eth_getBalance":
          return hexQuantity(options.balance ?? 10n ** 18n);

        case "eth_gasPrice":
          return hexQuantity(2_000_000_000n);

        case "eth_maxPriorityFeePerGas":
          return hexQuantity(1_000_000_000n);

        case "eth_estimateGas":
          return hexQuantity(200_000n);

        case "eth_getTransactionCount":
          // **Advanced by every broadcast**, which is what a `pending` count
          // does on a real endpoint. A constant here cannot express a nonce
          // collision at all: two concurrent relays both read it, both sign the
          // same nonce, and the suite sees two happy 201s (R66).
          return hexQuantity((options.transactionCount ?? 7) + broadcasts.length);

        case "eth_getBlockByNumber": {
          const [tag] = params as [string, boolean];
          // `finalized` is refused rather than served: this node indexes at
          // `latest`, so a reader that still resolves that tag is a leftover and
          // fails here instead of being answered.
          if (tag === "finalized") {
            throw new Error("stub-chain: this node indexes at latest, not finalized");
          }
          if (tag === "latest" || tag === "pending") return block(latest);
          return block(BigInt(tag));
        }

        case "eth_call": {
          // `from` and `blockNumber` are read rather than dropped: both carry a
          // load-bearing claim (see `simulatedFrom`).
          const [call] = params as [{ to: Hex; data: Hex; from?: string }];
          const { abi, functionName, args } = decodeCall(call.data);
          const mutating = MUTATIONS.has(functionName);
          // Recorded before it can fail: the node *did* make this call, and a
          // test that asserts nothing was relayed must still be able to see that
          // the simulate was attempted.
          if (mutating) {
            simulated.push(call.data);
            simulatedFrom.push(call.from);
          }

          if (options.callError !== undefined) throw options.callError();

          if (mutating) {
            const outcome = options.simulate?.() ?? { kind: "ok" as const };
            if (outcome.kind === "revert") {
              throw revertError(
                encodeErrorResult({ abi, errorName: outcome.errorName }),
              );
            }
            if (outcome.kind === "opaque") throw revertError(outcome.data);
            return "0x";
          }

          const views = options.views ?? {};
          if (!(functionName in views)) {
            throw new Error(`stub-chain: no stub for view ${functionName}`);
          }
          const stubbed = views[functionName];
          const result =
            typeof stubbed === "function"
              ? (stubbed as (args: readonly unknown[]) => unknown)(args)
              : stubbed;
          return encodeFunctionResult({ abi, functionName, result: result as never });
        }

        case "eth_sendRawTransaction": {
          const [raw] = params as [string];
          // Refused *before* anything is recorded: an endpoint that rejects the
          // bytes has not broadcast them, and a test asserting "nothing was
          // relayed" must be able to see that.
          // Called per broadcast, and `undefined` means "not this one" — the
          // same per-call shape `simulate` has. A sweep that relays several
          // transactions in one pass needs to fail exactly one of them: the
          // property under test is that the pass *continues*, which a stub that
          // could only fail all of them or none cannot express.
          const sendFailure = options.sendError?.();
          if (sendFailure !== undefined) throw sendFailure;
          if (options.sendDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.sendDelayMs));
          }
          broadcasts.push(raw);
          // A parse failure records nothing rather than turning this stub into
          // a validator the real endpoint is not: tests hand the broadcast path
          // strings that are deliberately not transactions.
          try {
            const parsed = parseTransaction(raw as Hex);
            relayed.push(parsed.data ?? "0x");
            relayedGas.push(parsed.gas);
          } catch {
            relayed.push("0x");
            relayedGas.push(undefined);
          }
          return stubTxHash(broadcasts.length);
        }

        case "eth_getTransactionReceipt":
          // Not mined. viem turns this into `TransactionReceiptNotFoundError`
          // and keeps polling until its own timeout fires.
          if (options.receiptMissing === true) return null;
          return {
            transactionHash: (params as [Hex])[0],
            transactionIndex: "0x0",
            blockHash: `0x${"ab".repeat(32)}`,
            blockNumber: hexQuantity(latest),
            from: `0x${"00".repeat(20)}`,
            to: config.addresses.jobRegistry,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: hexQuantity(2_000_000_000n),
            contractAddress: null,
            logs: options.receiptLogs?.() ?? [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: receiptStatus === "success" ? "0x1" : "0x0",
            type: "0x2",
          };

        case "eth_getTransactionByHash":
          return {
            hash: (params as [Hex])[0],
            nonce: "0x7",
            blockHash: `0x${"ab".repeat(32)}`,
            blockNumber: hexQuantity(latest),
            transactionIndex: "0x0",
            from: `0x${"99".repeat(20)}`,
            to: config.addresses.jobRegistry,
            value: "0x0",
            gas: hexQuantity(200_000n),
            gasPrice: hexQuantity(2_000_000_000n),
            input: "0x",
            type: "0x2",
            chainId: hexQuantity(config.addresses.chainId),
            v: "0x1",
            r: `0x${"11".repeat(32)}`,
            s: `0x${"22".repeat(32)}`,
          };

        default:
          throw new Error(`stub-chain: unexpected RPC ${method}`);
      }
  };

  // `retryCount: 0`, per R42, because this stub is what every call count in this
  // suite is measured against. viem retries **three** times by default, and its
  // `shouldRetry` retries anything it could not classify: an error that is not
  // an `RpcRequestError` is wrapped as `UnknownRpcError` with code `-1`, which
  // is in the retry set. Without this, a stub error raised for any reason at all
  // — `no stub for view X`, `unexpected RPC` — is counted four times, and a test
  // asserting on the number of upstream calls measures viem's retry loop rather
  // than the node's behaviour.
  const transport = custom(handler, { retryCount: 0 });

  stub.chain = makeChain(config, transport);
  return stub;
}

/**
 * A refused broadcast, shaped the way an endpoint refuses one.
 *
 * `RpcRequestError` with the endpoint's own code, for the same reason
 * {@link revertError} uses it (R64): the class is what decides whether viem
 * retries, and a bare `Error` would be wrapped as `UnknownRpcError` with code
 * `-1` and retried three times. `-32000` is the generic server-error code
 * go-ethereum returns for "nonce too low", "already known",
 * "replacement transaction underpriced" and "insufficient funds" alike — which
 * is exactly why the node classifies those four on the *message* and the two
 * that have codes of their own (`-32603`, `-32005`) on the code (R70).
 *
 * `data` is optional and additive (R64/R65): a broadcast an endpoint refuses
 * because the transaction *executed and reverted* comes back with the revert
 * bytes, and without them the suite could express a send-stage revert only as an
 * undecodable one. R80 turns that case into a `409` carrying the contract's own
 * error name on the relayer-funded door, so the name has to be expressible at
 * the send exactly as it is at the simulate.
 */
export function refusedBroadcast(message = "nonce too low", code = -32000, data?: Hex): Error {
  return new RpcRequestError({
    body: { method: "eth_sendRawTransaction" },
    error: data === undefined ? { code, message } : { code, message, data },
    url: "http://stub-chain.invalid",
  });
}

/**
 * An `eth_call` the endpoint refused, shaped the way it refuses one.
 *
 * The same class as {@link refusedBroadcast} and for the same reason (R64) — the
 * class is what decides whether viem retries — but with `eth_call` in the body,
 * because that is the request the node actually made and the error is what the
 * node's *simulate* and *floor read* stages see. `-32000` is go-ethereum's
 * generic server-error code; pass `-32005`, `-32603` or `3` to be specific.
 *
 * `data` is the revert bytes, for the endpoints that return them under a code of
 * their own invention rather than under `3` — the bytes are then the only
 * evidence that the call executed at all.
 */
export function refusedCall(message: string, code = -32000, data?: Hex): Error {
  return new RpcRequestError({
    body: { method: "eth_call" },
    error: data === undefined ? { code, message } : { code, message, data },
    url: "http://stub-chain.invalid",
  });
}

/**
 * A bare `revert()` — code `3`, data `0x`.
 *
 * The shape that makes "did the endpoint answer with a revert" and "is `raw`
 * null" different questions (R72). A contract that reverts with no reason string
 * and no custom error returns **empty** data, so there is nothing to decode and
 * nothing to hand back; the endpoint still pronounced on the transaction, and
 * this is still a `409`. Classifying on the absence of data would have turned
 * every bare `require(false)` on either registry into a retryable `503`, and a
 * daemon would retry it forever.
 */
export function bareRevert(): Error {
  return new RpcRequestError({
    body: { method: "eth_call" },
    error: { code: 3, message: "execution reverted", data: "0x" },
    url: "http://stub-chain.invalid",
  });
}

/**
 * A transport failure: nothing answered, so there is **no numeric code anywhere
 * in the `cause` chain**.
 *
 * This is the only shape that reaches `sendFailure`'s `503` branch, and it is
 * the production one: viem's http transport reports a refused connection or a
 * dead endpoint as an `HttpRequestError`, which is a `BaseError` and so is
 * rethrown by `buildRequest` unwrapped, carrying `status`/`url` and no `code`.
 * The branch had no test on either door until R70 asked for one.
 */
export function unreachableEndpoint(): Error {
  return new HttpRequestError({
    url: "http://stub-chain.invalid",
    details: "connect ECONNREFUSED 127.0.0.1:8545",
  });
}

/**
 * A revert shaped the way an endpoint reports one, so `decodeRevert`'s walk over
 * `cause` finds the data where it really lives rather than where a test put it.
 *
 * `RpcRequestError`, and not a bare `Error` carrying `code`/`data`, because the
 * class is what decides whether viem retries. `buildRequest` has no case for
 * code `3`, so an unrecognised error object falls to `UnknownRpcError`, whose
 * `code` is `-1` — and `-1` is in `shouldRetry`'s set. An `RpcRequestError`
 * keeps the endpoint's own code, so it is rethrown as-is and answered once.
 * Measured, on this viem: a bare `Error` produced **4** `eth_call`s over 1 059 ms
 * for one revert; an `RpcRequestError` produces 1. A real endpoint reports a
 * revert as HTTP 200 plus a JSON-RPC error object, which is exactly what viem's
 * http transport turns into this class — so this is the production shape, not a
 * convenience.
 */
function revertError(data: Hex): Error {
  return new RpcRequestError({
    body: { method: "eth_call" },
    error: { code: 3, message: "execution reverted", data },
    url: "http://stub-chain.invalid",
  });
}
