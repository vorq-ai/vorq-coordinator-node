import { decodeErrorResult, type Abi } from "viem";

/**
 * Turning a reverted `eth_call` into the one word a caller can act on.
 *
 * The contracts revert with custom errors — `NotOpen`, `AtCapacity`, `StaleOp` —
 * and that name **is** the vocabulary this API answers with, on
 * `/evm/simulate/claim` and on the pre-relay simulate inside `/evm/ops` alike.
 * Reusing the contract's own name means the node never invents a taxonomy that
 * can drift from the chain's, and a provider daemon can match one set of strings
 * whichever door told it.
 *
 * The other half matters more: **a revert this node cannot decode is reported as
 * `unknown` with the raw bytes attached, never swallowed and never guessed.**
 * The escrow pull inside `claim` calls the payment token, which reverts with
 * errors that are in neither of this node's ABIs — a
 * `FiatTokenV2: authorization is used` string. Mapping those onto
 * the nearest familiar name would tell a provider its claim was refused for a
 * reason that is not why it was refused.
 */

/** A revert, as far as this node can read it. */
export interface Revert {
  /** The custom error's name, or `"unknown"`. */
  reason: string;
  /** The revert data, when the node saw any. `null` when the node saw none. */
  raw: `0x${string}` | null;
}

const HEX_DATA = /^0x[0-9a-fA-F]*$/;

/**
 * The error and everything it was caused by, outermost first.
 *
 * One walk, used by everything that has to classify a chain failure: viem nests
 * the endpoint's own error several `cause`s down — `TransactionExecutionError` →
 * `InsufficientFundsError` → `InvalidInputRpcError` → `RpcRequestError`, or
 * `CallExecutionError` → `ExecutionRevertedError` → `RpcRequestError` — and the
 * evidence is spread over the whole of it: the JSON-RPC code sits at the bottom,
 * the revert data beside it, the human wording anywhere. `seen` guards a cycle
 * rather than trusting that nothing ever sets `cause` to itself.
 */
export function causeChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node !== null && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const record = node as Record<string, unknown>;
    chain.push(record);
    node = record.cause;
  }
  return chain;
}

/**
 * Digs the revert data out of a viem error.
 *
 * viem wraps a revert several layers deep (`CallExecutionError` →
 * `RawContractError`, or `ContractFunctionExecutionError` →
 * `ContractFunctionRevertedError`) and the shape depends on which client method
 * was used and on what the endpoint returned. Rather than depend on one of
 * those chains, this walks `cause` and takes the first `0x…` string it finds on
 * a `data` field — a shape all of them share.
 */
export function revertData(error: unknown): `0x${string}` | null {
  for (const record of causeChain(error)) {
    const data = record.data;
    if (typeof data === "string" && HEX_DATA.test(data) && data.length > 2) {
      return data as `0x${string}`;
    }
    // `RawContractError` carries `{data: {data: "0x…"}}` when the endpoint
    // reports the revert inside its error object rather than beside it.
    if (typeof data === "object" && data !== null) {
      const inner = (data as Record<string, unknown>).data;
      if (typeof inner === "string" && HEX_DATA.test(inner) && inner.length > 2) {
        return inner as `0x${string}`;
      }
    }
  }
  return null;
}

/**
 * The phrase an endpoint uses for "your call ran and the contract reverted".
 *
 * go-ethereum answers a reverted `eth_call` with JSON-RPC code `3`, but the code
 * is not universal — some endpoints report the identical refusal under `-32000`
 * and only the wording distinguishes it — so both are evidence, and neither
 * alone is enough.
 *
 * Matched against **messages only**, deliberately, and not against viem's class
 * names. `ExecutionRevertedError` is constructed only when viem has already
 * found code `3` in the chain or matched this phrase itself, so matching the
 * name would make it a third spelling of two tests that are already here — and,
 * worse, would swallow the code-`3` test below into a branch nothing could then
 * make fail on its own.
 */
const EXECUTION_REVERTED = /execution reverted/i;

/**
 * Did the endpoint answer with a **verdict on this transaction**, or did it fail
 * to answer at all? (R72)
 *
 * This is the whole classification the relayer-funded door turns on. When the
 * node builds and funds the bytes, the only refusal that is the caller's problem
 * is the one the chain itself pronounced: the call executed and reverted. Every
 * other failure — a dead endpoint, a rate limit, the endpoint's own internal
 * error, a full transaction pool — is the node's, and answering it as a verdict
 * tells a provider daemon that the chain refused its op and that retrying is
 * pointless, both of which are false.
 *
 * Three pieces of evidence, in order of strength:
 *
 *   1. **Revert data really came back.** Nothing but an executed revert produces
 *      it, so it is decisive.
 *   2. **JSON-RPC code `3`.** A bare `revert()` returns data `0x` and therefore
 *      no data at all by (1) — but the endpoint still pronounced. The test is
 *      "did the endpoint answer with a revert", never "is `raw` null".
 *   3. **The endpoint's own wording**, but only once *something* answered. With
 *      no numeric code anywhere in the chain nothing answered, and a transport
 *      error's text is not the chain speaking.
 *
 * Deliberately **not** an allowlist of refusal phrases. An allowlist has to be
 * revisited every time an endpoint invents a phrase, and each phrase it has not
 * met yet is answered as a verdict — which is the failure mode, not a gap in it.
 */
export function isVerdict(error: unknown): boolean {
  if (revertData(error) !== null) return true;

  const chain = causeChain(error);
  if (chain.some((node) => node.code === 3)) return true;
  if (!chain.some((node) => typeof node.code === "number")) return false;

  return chain.some(
    (node) => EXECUTION_REVERTED.test(typeof node.message === "string" ? node.message : ""),
  );
}

/**
 * Names the revert behind `error`, trying each ABI in turn.
 *
 * A `Panic(uint256)` or an `Error(string)` decodes through any ABI viem is
 * given, so those are reported under their own names too rather than as
 * `unknown` — a require-string failure is a different diagnosis from a custom
 * error nobody here declares.
 */
export function decodeRevert(error: unknown, abis: readonly Abi[]): Revert {
  const data = revertData(error);
  if (data === null) return { reason: "unknown", raw: null };

  for (const abi of abis) {
    try {
      const { errorName } = decodeErrorResult({ abi, data });
      return { reason: errorName, raw: data };
    } catch {
      // Not this ABI's error. Try the next; `unknown` is the honest fallback.
    }
  }
  return { reason: "unknown", raw: data };
}
