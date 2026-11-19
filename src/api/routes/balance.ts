import { Type } from "typebox";
import { encodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import { jobRegistryAbi } from "../../abi/jobRegistry.js";
import { atFloor, chainParams, type Chain, type ChainParams } from "../../chain/client.js";
import { decodeRevert, isVerdict } from "../../chain/revert.js";
import type { Address } from "../../config.js";
import { formatUsd } from "../../money.js";
import { UINT128_MAX } from "../../orders.js";
import { sendFailure, viewRead } from "../chain-failure.js";
import { chainGate, requireChain, sessionGate, type App, type RouteDeps } from "../deps.js";
import { ApiError, badRequest } from "../errors.js";
import { fundsOf, underOwnerFunds } from "../funding.js";
import { moneyLimiter } from "../rate-limit.js";
import {
  Address as AddressIn,
  BEARER,
  errors,
  Hex32,
  HexOut,
  SafeUint,
  Sig65,
  Usd,
  UsdOut,
} from "../schemas/common.js";
import { usdParam } from "../usd.js";

/**
 * The prepaid balance: `GET /v1/balance`, `POST /v1/deposits` and
 * `POST /v1/withdrawals`.
 *
 * A client pays for jobs from a balance `JobRegistry` holds for it. A claim
 * locks the job's `cap + feeCap + gasFee` out of it; settlement returns what
 * the job did not use. These doors are how money gets in and out, and both
 * writes are **gasless for the client**: each carries one signature the
 * contract verifies, and this node's relayer pays the gas, exactly as for every
 * other relayed op.
 *
 *   * **deposit** — an EIP-3009 `ReceiveWithAuthorization` from the owner to the
 *     registry, under the payment token's own domain, `validAfter = 0`, a random
 *     nonce. `JobRegistry.deposit` pulls it and credits `value − depositFee`.
 *   * **withdraw** — `Withdraw(uint128 amount,uint64 issuedAt)` on the "VORQ Jobs"
 *     domain, signed by the owner; the registry transfers to the owner.
 *
 * **Authority is the signature; the session is a transport gate only**, as on
 * every other door. The owner is in the body because the chain needs it, and a
 * session for one wallet relaying another's signed deposit is as harmless as a
 * stranger relaying it: the contract only ever moves the signer's own funds.
 *
 * Both writes simulate the exact transaction from the relayer before any gas is
 * spent, and run under the owner's funds queue (`underOwnerFunds`), so a
 * withdrawal reads a balance no concurrent deposit, withdrawal, post or batch
 * hold of the same owner is about to change.
 *
 * ```
 * 200 {owner, balance, reserved, available, deposit_fee}   all three
 * 400 invalid_request_error             malformed                   not retryable
 * 400 payer_has_code                    deposit from a code account not retryable
 * 401 authentication_error              no session                  not retryable
 * 409 {error:{code:"<ContractError>"}}  THE CHAIN REFUSED IT        not retryable
 * 409 insufficient_balance              withdrawal past available   not retryable
 * 429 busy / rate_limit_exceeded        see `api/queue.ts`, `rate-limit.ts`
 * 503 relay_unavailable / chain_unreachable                             RETRYABLE
 * 504 receipt_timeout                   broadcast, no receipt in time not retryable
 * ```
 *
 * `balance` is `JobRegistry.balanceOf` at the node's floor — already net of every
 * claimed job's lock — `reserved` is what this owner's open orders will lock when
 * they are claimed, and `available` is the difference: what a new order or a
 * withdrawal can draw on.
 */

/** How long the node waits for a relayed deposit's or withdrawal's receipt. */
const RECEIPT_TIMEOUT_MS = 60_000;

/** The withdraw op's freshness window, the contract's `_freshJobOp`: ±600 s inclusive. */
const OP_WINDOW_SECONDS = 600n;

const ABIS: readonly Abi[] = [jobRegistryAbi as Abi];

/**
 * EIP-3009's `authorizationState(authorizer, nonce)` — whether a deposit
 * authorization has been used. Not a vendored ABI: the payment token is not one
 * of the three contracts this node vendors, and this is the one member of it
 * besides `DOMAIN_SEPARATOR` it reads.
 */
export const authorizationStateAbi = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const BalanceBody = Type.Object({
  owner: HexOut("The owner, checksummed."),
  balance: UsdOut("JobRegistry.balanceOf: the prepaid balance, net of every claimed job's lock."),
  reserved: UsdOut("What this owner's open orders will lock when they are claimed."),
  available: UsdOut("balance − reserved, floored at 0: what a new order or a withdrawal can draw on."),
  deposit_fee: UsdOut("The flat fee the registry takes from each deposit."),
});

export function balanceRoutes(app: App, deps: RouteDeps): void {
  const limiter = moneyLimiter(deps.config.moneyRateLimit);
  const gate = [chainGate(deps.chain), sessionGate(deps.db)];

  // Built on first use, as in `post.ts`: the app is constructible without a
  // chain, and the cache must outlive the request.
  let params: ChainParams | null = null;
  const configOf = (chain: Chain): ChainParams =>
    (params ??= chainParams(chain, deps.config.addresses));

  /** The balance body for `owner`, read at the node's floor. */
  async function balanceBody(chain: Chain, owner: Address) {
    const config = configOf(chain);
    const [feeBps, depositFee] = await Promise.all([
      viewRead("config_read", () => config.feeBps()),
      viewRead("config_read", () => config.depositFee()),
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const funds = await fundsOf(chain, deps.db, deps.config.addresses.jobRegistry, owner, feeBps, now);
    const { decimals } = deps.config.addresses;
    return {
      owner,
      balance: formatUsd(funds.balance, decimals),
      reserved: formatUsd(funds.reserved, decimals),
      available: formatUsd(funds.available, decimals),
      deposit_fee: formatUsd(depositFee, decimals),
    };
  }

  app.get(
    "/v1/balance",
    {
      onRequest: gate,
      schema: {
        tags: ["balance"],
        summary: "Read a prepaid balance",
        security: BEARER,
        querystring: Type.Object({ owner: AddressIn() }),
        response: { 200: BalanceBody, ...errors(400, 401, 503) },
      },
    },
    async (request) => {
    const chain = requireChain(deps.chain);
    return balanceBody(chain, getAddress(request.query.owner) as Address);
    },
  );

  app.post(
    "/v1/deposits",
    {
      onRequest: gate,
      schema: {
        tags: ["balance"],
        summary: "Deposit into a prepaid balance",
        description:
          "Relays one EIP-3009 `ReceiveWithAuthorization` from `owner` to the JobRegistry " +
          "(`validAfter` 0). The registry credits `value − deposit_fee`. An authorization already " +
          "used answers the current balance.",
        security: BEARER,
        body: Type.Object({
          owner: AddressIn({ description: "The depositor, who signs the authorization." }),
          value: Usd({ description: "What the authorization moves, in USD, deposit fee included." }),
          valid_before: SafeUint({ description: "The authorization's deadline, unix seconds." }),
          nonce: Hex32({ description: "The authorization's random nonce." }),
          auth_sig: Sig65({ description: "EIP-3009 `ReceiveWithAuthorization` under the token's domain." }),
        }),
        response: { 200: BalanceBody, ...errors(400, 401, 409, 429, 503, 504) },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const { addresses } = deps.config;
    const owner = getAddress(request.body.owner) as Address;
    const value = usdParam(request.body.value, addresses.decimals, "value");
    const validBefore = BigInt(request.body.valid_before);
    const nonce = request.body.nonce.toLowerCase() as Hex;

    // The payment token validates `receiveWithAuthorization` through
    // `SignatureChecker`: an owner carrying code is routed to ERC-1271, and its
    // plain EOA signature fails inside the token however well it recovers off
    // chain. Refused here with the cause named, rather than by a revert in the
    // token's own words.
    if (await viewRead("payer_code_read", () => chain.hasCode(owner))) {
      throw new ApiError(
        400,
        "invalid_request",
        `owner ${owner} carries contract code, and this deposit cannot be collected: the ` +
          "payment token validates a code-bearing authorizer through ERC-1271, not ecrecover. " +
          "Deposit from an account with no code — an undelegated EOA — or remove the account's " +
          "EIP-7702 delegation and deposit again",
        "owner",
        "payer_has_code",
      );
    }

    const used = () =>
      viewRead("authorization_state_read", () =>
        atFloor(chain, (pin) =>
          chain.publicClient.readContract({
            address: addresses.usdc,
            abi: authorizationStateAbi,
            functionName: "authorizationState",
            args: [owner, nonce],
            ...pin,
          }),
        ),
      );

    const data = encodeFunctionData({
      abi: jobRegistryAbi,
      functionName: "deposit",
      args: [owner, value, validBefore, nonce, request.body.auth_sig as Hex],
    });

    return underOwnerFunds(owner, async () => {
      // An authorization is single-use on the token. One already spent — a
      // retried request whose first attempt landed — is answered with the
      // balance it produced, and nothing is relayed.
      if (await used()) return reply.code(200).send(await balanceBody(chain, owner));
      const release = limiter.take(owner, 0n);
      try {
        await simulateThenRelay(chain, addresses.jobRegistry, data);
      } catch (error) {
        release();
        // The same authorization landed between the read above and here.
        if (error instanceof ApiError && error.status === 409 && (await used())) {
          return reply.code(200).send(await balanceBody(chain, owner));
        }
        throw error;
      }
      return reply.code(200).send(await balanceBody(chain, owner));
    });
    },
  );

  app.post(
    "/v1/withdrawals",
    {
      onRequest: gate,
      schema: {
        tags: ["balance"],
        summary: "Withdraw from a prepaid balance",
        description:
          "Relays `withdraw(owner, amount, issuedAt, signature)`, signed by the owner over " +
          "`Withdraw {amount, issuedAt}` on the JobRegistry's domain. Refused `409 " +
          "insufficient_balance` past `available`; `issued_at` within ±600 s and above the owner's " +
          "last withdrawal.",
        security: BEARER,
        body: Type.Object({
          owner: AddressIn({ description: "The owner, who signs the withdrawal." }),
          amount: Usd({ description: "What to transfer to the owner, in USD." }),
          issued_at: SafeUint({ description: "Unix seconds." }),
          signature: Sig65({ description: "EIP-712 `Withdraw` over the JobRegistry's v2 domain." }),
        }),
        response: { 200: BalanceBody, ...errors(400, 401, 409, 429, 503, 504) },
      },
    },
    async (request, reply) => {
    const chain = requireChain(deps.chain);
    const { addresses } = deps.config;
    const owner = getAddress(request.body.owner) as Address;
    const amount = usdParam(request.body.amount, addresses.decimals, "amount");
    if (amount === 0n || amount > UINT128_MAX) {
      throw badRequest("amount must be more than 0 and fit a uint128", "amount");
    }
    const issuedAt = BigInt(request.body.issued_at);

    // The contract's own ±600 s, refused before an `eth_call` is spent on it.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (issuedAt + OP_WINDOW_SECONDS < now || issuedAt > now + OP_WINDOW_SECONDS) {
      throw refusal("StaleOp", "issued_at is not within 600 s of this node's clock", "issued_at");
    }

    const data = encodeFunctionData({
      abi: jobRegistryAbi,
      functionName: "withdraw",
      args: [owner, amount, issuedAt, request.body.signature as Hex],
    });

    return underOwnerFunds(owner, async () => {
      // What the owner's open orders will lock stays: an order this node holds
      // was accepted against this balance, and a withdrawal under it would
      // leave the order unclaimable.
      const body = await balanceBody(chain, owner);
      const available = usdParam(body.available, addresses.decimals, "available");
      if (amount > available) {
        throw new ApiError(
          409,
          "invalid_request",
          `owner ${owner} has ${body.available} USD available — its balance less what its open ` +
            `orders will lock — and this withdrawal asks for ${request.body.amount}`,
          "amount",
          "insufficient_balance",
        );
      }
      const release = limiter.take(owner, 0n);
      try {
        await simulateThenRelay(chain, addresses.jobRegistry, data);
      } catch (error) {
        release();
        throw error;
      }
      return reply.code(200).send(await balanceBody(chain, owner));
    });
    },
  );
}

/** `409`, refused, with the reason as `code`. Not retryable (R57). */
function refusal(code: string, message: string, param: string | null): ApiError {
  return new ApiError(409, "invalid_request", message, param, code);
}

/**
 * `eth_call` the exact transaction from the relayer, then send it, then wait for
 * its receipt.
 *
 * At the node's floor, like every op the relayer sends: a withdrawal follows
 * the deposit or settlement this node just relayed, and `latest` on a
 * load-balanced endpoint can be a node that has not seen it.
 *
 * A refusal is a verdict only if the endpoint actually returned one (R72): an
 * unreachable endpoint, a rate limit or an empty relayer wallet is the node's
 * failure and answers `503`, retryably, through `sendFailure`.
 */
async function simulateThenRelay(chain: Chain, to: Address, data: Hex): Promise<void> {
  const classify = (error: unknown): ApiError => {
    if (!isVerdict(error)) return sendFailure(error);
    const revert = decodeRevert(error, ABIS);
    const detail = revert.reason === "unknown" && revert.raw !== null ? ` (${revert.raw})` : "";
    return refusal(revert.reason, `the chain refused this transaction: ${revert.reason}${detail}`, null);
  };

  let gas: bigint;
  try {
    await atFloor(chain, (pin) => chain.publicClient.call({ account: chain.account.address, to, data, ...pin }));
    gas = await atFloor(chain, (pin) =>
      chain.publicClient.estimateGas({ account: chain.account, to, data, ...pin }),
    );
  } catch (error) {
    throw classify(error);
  }

  let txHash: Hex;
  try {
    txHash = await chain.relay({ to, data, gas });
  } catch (error) {
    throw classify(error);
  }

  let status: "success" | "reverted";
  try {
    status = (await chain.receipt(txHash, RECEIPT_TIMEOUT_MS)).status;
  } catch {
    throw new ApiError(
      504,
      "receipt_timeout",
      `transaction ${txHash} was relayed but no receipt arrived within ${RECEIPT_TIMEOUT_MS} ms; ` +
        "read GET /v1/balance rather than sending it again",
      null,
      txHash,
    );
  }
  if (status !== "success") {
    throw refusal("reverted", `transaction ${txHash} was mined and reverted`, null);
  }
}
