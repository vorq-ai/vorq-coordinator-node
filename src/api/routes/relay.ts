import { Type } from "typebox";
import { chainParams, headBlockOf, type Chain, type ChainParams } from "../../chain/client.js";
import { viewRead } from "../chain-failure.js";
import { chainGate, requireChain, type App, type RouteDeps } from "../deps.js";
import { errors, HexOut, Int } from "../schemas/common.js";

/**
 * `GET /evm/chain` — the chain context, and this file is now only that.
 *
 * It answers the four contract addresses, the payment token's decimals and
 * domain, the chain id, the gas price, the protocol's `fee_bps` and the **head**
 * this node indexes at: a cheap, honest read a client may want for its own
 * accounting.
 *
 * It is a **read** and this file has no other kind (R84). Every write path in
 * this node is relayer-funded: the caller signs an order or an op, the node
 * builds the transaction, and the relayer account pays for it — there is no door
 * anywhere that forwards bytes a caller signed and funded, and no caller that
 * builds its own transaction, which is why `api/chain-failure.ts` carries no
 * funding parameter and why nothing here answers a nonce.
 *
 * This route reads the chain and not the index, so it is registered outside the
 * readiness gate and carries no `as_of_block` (R28).
 */

const ChainContext = Type.Object({
  chain_id: Type.Integer(),
  contracts: Type.Object({
    job_registry: HexOut(),
    provider_registry: HexOut(),
    ask_registry: HexOut(),
    usdc: HexOut("The payment token."),
  }),
  decimals: Type.Integer({ description: "The payment token's decimals." }),
  token_domain: Type.Object(
    { name: Type.String(), version: Type.String() },
    { description: "The EIP-712 domain a payment authorization is signed under." },
  ),
  head_block: Int(),
  block_time_ms: Type.Integer(),
  fee_bps: Type.Integer({ description: "Basis points charged on top of every settled charge." }),
});

export function relayRoutes(app: App, deps: RouteDeps): void {
  // Built on first use and kept, exactly as `post.ts` keeps its own: the app is
  // constructible without a chain, and `feeBps`' 60 s cell has to outlive the
  // request or this public door pays for an `eth_call` on every hit.
  let params: ChainParams | null = null;
  const configOf = (chain: Chain): ChainParams =>
    (params ??= chainParams(chain, deps.config.addresses));

  app.get(
    "/evm/chain",
    {
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["chain"],
        summary: "Chain context",
        description: "Contract addresses, the payment token, head block and `fee_bps`.",
        response: { 200: ChainContext, ...errors(503) },
      },
    },
    async () => {
    const chain = requireChain(deps.chain);
    const { addresses } = deps.config;

    // The head this node indexes at; see `headBlockOf`.
    const [headBlock, feeBps] = await Promise.all([
      headBlockOf(chain.publicClient),
      // The first request-path caller of a `chainParams` cell outside `post.ts`,
      // so it classifies the failure itself (R77): a `feeBps` that cannot be
      // read is an unreachable endpoint, never a verdict on this GET.
      viewRead("config_read", () => configOf(chain).feeBps()),
    ]);

    return {
      chain_id: addresses.chainId,
      contracts: {
        job_registry: addresses.jobRegistry,
        provider_registry: addresses.providerRegistry,
        ask_registry: addresses.askRegistry,
        usdc: addresses.usdc,
      },
      // The payment token's own two facts, both from the address book: what an
      // amount on this wire is denominated in, and the EIP-712 name and version
      // a client signs its payment authorization under.
      decimals: addresses.decimals,
      token_domain: addresses.tokenDomain,
      head_block: headBlock,
      block_time_ms: deps.config.blockTimeMs,
      // basis points charged on top of every settled charge; what a UI shows as its fee line
      fee_bps: feeBps,
    };
    },
  );
}
