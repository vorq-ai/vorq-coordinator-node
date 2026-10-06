import {
  hashDomain,
  keccak256,
  type Hex,
  type PublicClient,
} from "viem";
import type { Address, Addresses } from "./config.js";

/**
 * The order, the quote and the two signatures — everything about a job's terms
 * that is arithmetic or EIP-712 rather than HTTP.
 *
 * Kept out of the route because every value here is a **restatement of a frozen
 * contract** (R32) and has to be checked against `JobRegistry.sol` line by line:
 * the `Order` typehash member order, the `jobId` preimage, the cap formula, the
 * payment authorization. A member renamed or reordered here recovers a different
 * address and the post is refused — a silent failure — so this file is written
 * against the contract source and the vendored ABI, never from memory, and
 * `test/api-post.test.ts` spells all four out again *literally* rather than
 * importing them, so a wrong order cannot agree with itself.
 */

// ---------------------------------------------------------------------------
// Constants, all of them the contract's own
// ---------------------------------------------------------------------------

/** `JobRegistry.RATE_SCALE`. Rates are per million units. */
export const RATE_SCALE = 1_000_000n;

/** `JobRegistry.MAX_EXPIRY`. An order may not commit escrow for longer (R24). */
export const MAX_EXPIRY_SECONDS = 86_400n;

/** `type(uint128).max` — the width of every rate on chain. */
export const UINT128_MAX = (1n << 128n) - 1n;

/**
 * 2^53 − 1, the largest cap quotable: the 402's `authorization.value` is the
 * atomic amount a wallet signs, and it travels as a JSON integer.
 */
export const MAX_CAP = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The largest `sla_secs` this node will ask the chain about.
 *
 * A bound the chain does not have, and it exists because `chainParams.slaAllowed`
 * memoises **one cell per distinct `secs`** in a `Map` whose keys an
 * unauthenticated caller chooses: without this, a post door open to the internet
 * grows that map by one entry and costs one `eth_call` per request, across 2^32
 * distinct keys. The value is `MAX_EXPIRY` because a job's whole life is at most
 * `MAX_EXPIRY` seconds, so an SLA above it cannot be met inside any order this
 * node will accept. Governance *can* allow a larger SLA on chain and this node
 * would refuse it; raising this constant is the fix if that ever happens. Stated
 * plainly in the task report rather than argued to be unreachable.
 */
export const MAX_SLA_SECONDS = MAX_EXPIRY_SECONDS;

/** The one payment scheme this node quotes and accepts. */
export const PAYMENT_SCHEME = "eip3009";

/**
 * The flat, chain-shaped terms of one order — the only order shape (no `input`,
 * no `enc`).
 *
 * **Exactly the members the order signature covers**, which is why `taskCid` is
 * not here any more. The CID is minted by the pin this node performs *after* the
 * signature is checked, so it is a `post` argument the route supplies (see
 * {@link taskCidHex}) and never a term. Leaving it in a struct whose whole
 * purpose is "what the client signed" is the silent drift this file exists to
 * prevent.
 */
export interface Terms {
  c: Hex;
  modelId: bigint;
  slaSecs: bigint;
  rateIn: bigint;
  rateOut: bigint;
  unitsIn: bigint;
  unitsOut: bigint;
  designated: bigint;
  expiresAt: bigint;
}

/** Raised when `cap` cannot be represented in `Job.cap` — the contract's `CapOverflow`. */
export class CapOverflowError extends Error {}

/**
 * `cap = max(1, ceilDiv(rateIn*unitsIn + rateOut*unitsOut, RATE_SCALE))`.
 *
 * `_atomicCharge`, restated in the same order. The `max(1, …)` is not a rounding
 * nicety: a zero-priced order still escrows the one-atomic-unit floor, so the
 * quote for a dust order is `1`, never `0`. All of it in `bigint` — the products
 * reach ~2^86 and a double would round them silently (R45, R46).
 */
export function capOf(terms: Terms): bigint {
  const raw = terms.rateIn * terms.unitsIn + terms.rateOut * terms.unitsOut;
  const ceiling = (raw + RATE_SCALE - 1n) / RATE_SCALE;
  const cap = ceiling === 0n ? 1n : ceiling;
  if (cap > MAX_CAP) {
    throw new CapOverflowError(
      `cap exceeds ${MAX_CAP}, the largest amount this API carries; lower the rates or the unit counts`,
    );
  }
  return cap;
}

/** The protocol fee on top of `base`, floored — `JobRegistry`'s `base * feeBps / 10000`. */
export function feeOf(base: bigint, feeBps: number): bigint {
  return (base * BigInt(feeBps)) / 10000n;
}

/**
 * `keccak256(abi.encodePacked(owner, c))` — 20 bytes then 32, never re-ordered.
 *
 * `encodePacked`, not `encode`: the contract concatenates the raw address and
 * the raw word with no padding between them, and an ABI-encoded preimage would
 * be 64 bytes and a different id.
 */
export function jobIdOf(owner: Address, c: Hex): Hex {
  return keccak256(`0x${owner.slice(2)}${c.slice(2)}` as Hex);
}

/**
 * The EIP-712 domain both registries declare: `VORQ` version `2` — never the
 * handshake's `1`, which is an off-chain namespace on purpose so a captured
 * login can never be replayed as an order.
 *
 * `Cancel(bytes32 jobId,uint64 issuedAt)` lives in this same domain and has no
 * builder here: the cancel door does not recover that signature locally (the
 * owner is on chain, and the mandatory simulate asks the party that knows), so a
 * second copy of the type string would be a restatement nothing checks.
 */
/**
 * Each registry declares its **own** EIP-712 domain name.
 *
 * They used to share `"VORQ"` and differ only in `verifyingContract`, which left
 * one real failure invisible: a configuration whose two address slots resolve to
 * the same contract produces digests indistinguishable from legitimate ones, and
 * a wrong `verifyingContract` never errors — it recovers a stranger. Distinct
 * names make the separators differ whatever the addresses are, and let a wallet
 * show which contract is being authorised. The contracts publish these via
 * ERC-5267 `eip712Domain()`; `assertDomains` checks them against the live chain
 * at boot.
 */
export const EIP712_NAMES = {
  job: "VORQ Jobs",
  provider: "VORQ Providers",
  ask: "VORQ Asks",
} as const;

const vorqDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: EIP712_NAMES.job, version: "2", chainId, verifyingContract }) as const;

/**
 * `Order(bytes32 c,uint32 modelId,uint32 slaSecs,uint128 rateIn,uint128 rateOut,`
 * `uint32 unitsIn,uint32 unitsOut,uint32 designated,uint64 expiresAt)`
 *
 * `JobRegistry.ORDER_TYPEHASH`, member for member — and **`taskCid` is not one of
 * them**. The client cannot know the name when it signs: it hands the container
 * bytes to this node with the order, the node pins them, and the storage service
 * mints the CID inside the same call. So the CID is a `post` **parameter** (still
 * stored, still in `Posted`, still `EmptyTaskCid` on empty) and not a signed
 * member.
 *
 * The selector did not change when the member left — `post` still takes the same
 * struct — so **regenerating the ABI carries none of this**. The type string
 * below is the whole difference, and a signature made over the old one recovers
 * a different address and is refused. `test/api-post.test.ts` proves both
 * directions.
 *
 * Nothing is lost by dropping it: the signed `c` welds the container to
 * `jobId = keccak256(owner ‖ c)`, every claimant re-derives it from the bytes it
 * fetched, and a locator naming anything else names bytes no claimant accepts.
 */
export function orderTypedData(chainId: number, jobRegistry: Address, terms: Terms) {
  return {
    domain: vorqDomain(chainId, jobRegistry),
    types: {
      Order: [
        { name: "c", type: "bytes32" },
        { name: "modelId", type: "uint32" },
        { name: "slaSecs", type: "uint32" },
        { name: "rateIn", type: "uint128" },
        { name: "rateOut", type: "uint128" },
        { name: "unitsIn", type: "uint32" },
        { name: "unitsOut", type: "uint32" },
        { name: "designated", type: "uint32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "Order" as const,
    message: {
      c: terms.c,
      modelId: terms.modelId,
      slaSecs: terms.slaSecs,
      rateIn: terms.rateIn,
      rateOut: terms.rateOut,
      unitsIn: terms.unitsIn,
      unitsOut: terms.unitsOut,
      designated: terms.designated,
      expiresAt: terms.expiresAt,
    },
  };
}

/**
 * The CID's UTF-8 bytes — what `order.taskCid` is on chain.
 *
 * Still needed, and needed more than before: `taskCid` left the **typehash** and
 * stayed a **parameter**, so this is what encodes the name this node's own pin
 * minted into the struct `post` takes.
 */
export const taskCidHex = (taskCid: string): Hex =>
  `0x${Buffer.from(taskCid, "utf8").toString("hex")}`;

/** Everything the payment signature commits to beyond the deployment itself. */
export interface AuthorizationTerms {
  from: Address;
  to: Address;
  value: bigint;
  /** `expiresAt + 1`: the token requires `now < validBefore`, and a claim may land on `expiresAt`. */
  validBefore: bigint;
  jobId: Hex;
}

/** The payment token's own EIP-712 domain. Name and version differ per network, so they come
 * from the address book and `assertDomains` proves them against the deployed token. */
export const tokenDomain = (addresses: Addresses) =>
  ({
    name: addresses.tokenDomain.name,
    version: addresses.tokenDomain.version,
    chainId: addresses.chainId,
    verifyingContract: addresses.usdc,
  }) as const;

/** EIP-3009 `ReceiveWithAuthorization`. `nonce` is the job id: single-use on the token, bound to the job. */
export function authorizationTypedData(addresses: Addresses, auth: AuthorizationTerms) {
  return {
    domain: tokenDomain(addresses),
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      from: auth.from, to: auth.to, value: auth.value,
      validAfter: 0n, validBefore: auth.validBefore, nonce: auth.jobId,
    },
  };
}

/** `DOMAIN_SEPARATOR()` — the one member of the payment token and of the three
 * registries this check calls. Not a vendored ABI (R32). */
const domainSeparatorAbi = [
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
] as const;

/**
 * The four-member domain of one contract, as this node computes it.
 *
 * The name and the version are the contract's own — the registries no longer
 * share one, and the payment token declares its own pair. `chainId` is widened to
 * `bigint` for the hash only: `EIP712Domain.chainId` is a `uint256` and viem
 * types the value it hashes accordingly. Built from configuration every time,
 * never a quoted separator (R6).
 */
const domainHash = (
  name: string,
  version: string,
  chainId: number,
  verifyingContract: Address,
): Hex =>
  hashDomain({
    domain: { name, version, chainId: BigInt(chainId), verifyingContract },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });

/**
 * Asserts that every contract this node verifies signatures against hashes the
 * domain this node signs and recovers with.
 *
 * This is the only check in the system that is not a fixture. `signing-v3.json`
 * proves the four codebases agree with each other; nothing in it can prove they
 * agree with *the chain this process just booted on*, because `verifyingContract`
 * is deployment data supplied at runtime. A wrong address in configuration does
 * not error — it recovers a stranger, and every op is refused for a reason
 * nothing reports. Reading each deployed separator and comparing it with the
 * locally computed one turns that into a refusal to start.
 *
 * Distinct domain names make this check strictly sharper than it used to be: two
 * address slots resolving to the same contract now produce two different expected
 * separators, so the collision is caught rather than silently agreeing.
 */
export async function assertDomains(client: PublicClient, addresses: Addresses): Promise<void> {
  // The payment token is one row of the same table: its domain is deployment
  // data like any other, every payment this node quotes names it, and a mismatch
  // is invisible until a provider's `claim` reverts inside the token — after the
  // node has already fronted the gas for the post.
  const contracts = [
    ["job registry", EIP712_NAMES.job, "2", addresses.jobRegistry],
    ["provider registry", EIP712_NAMES.provider, "2", addresses.providerRegistry],
    ["ask registry", EIP712_NAMES.ask, "2", addresses.askRegistry],
    ["payment token", addresses.tokenDomain.name, addresses.tokenDomain.version, addresses.usdc],
  ] as const;

  for (const [label, name, version, address] of contracts) {
    const expected = domainHash(name, version, addresses.chainId, address);

    // R77-off-request-path: a boot-time deployment check, run before anything is
    // listening. There is no caller whose request could be misclassified.
    const deployed = (await client.readContract({
      address,
      abi: domainSeparatorAbi,
      functionName: "DOMAIN_SEPARATOR",
    })) as Hex;

    if (deployed.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `the ${label} at ${address} reports domain separator ${deployed}, but chain ` +
          `${addresses.chainId} with domain "${name}" version ${version} computes ${expected}. Every ` +
          `signature this node verified against it would recover a stranger, and every op would ` +
          `be refused with nothing naming the cause. Check that the configured address is the ` +
          `contract you think it is.`,
      );
    }
  }
}
