import { RelayUnavailableError, type Chain } from "../chain/client.js";
import { causeChain, isVerdict } from "../chain/revert.js";
import { ApiError } from "./errors.js";

/**
 * How this node classifies a chain failure — the one copy of it.
 *
 * It lives **below** the route layer on purpose. `sendFailure` began inside
 * `routes/relay.ts` and every door that needed it imported it from there, which
 * worked until something underneath the routes needed it too: `resolveProviderId`
 * (`api/deps.ts`) issues an `eth_call` on the request path of three doors and
 * could not reach the classifier without an import cycle, so it had none and
 * answered `500 internal_error, retryable=false` for a dead endpoint. A guard the
 * layer below cannot import is a guard that layer will not have.
 *
 * Two exports, and the difference between them is R77's whole sentence:
 * {@link sendFailure} classifies the failure of a **transaction**, where the
 * endpoint's refusal may genuinely be a verdict on the caller's request, and
 * {@link viewRead} classifies the failure of a **view read**, where it never can
 * be.
 */

/**
 * **Every door is relayer-funded, so there is no funding parameter.**
 *
 * R70's discriminator asked *whose* transaction was refused, and on this node the
 * answer is the same everywhere: the caller signs an order or an op, the node
 * builds the transaction and the relayer account pays for it. So an empty wallet,
 * a nonce race, a full mempool or an RPC quota is the **node's** failure and
 * answers `503`, retryably — never a `400` telling a caller its request was
 * malformed. There is no parameter rather than a parameter with one inhabitant,
 * because a discriminator that cannot discriminate is an invitation to re-derive
 * the wrong half of it later.
 */

/**
 * The `code` on a `relay_unavailable` when the endpoint refused for a reason
 * none of the named classes below recognises.
 *
 * There **is** a default now, and it is retryable: on this door a refusal is a
 * verdict only if the endpoint pronounced one (R72), so an unrecognised refusal
 * is the node's own and needs no row here to be answered correctly. The named
 * rows below survive only to tell an operator *which* failure it is — they no
 * longer decide *whose* it is.
 */
const ENDPOINT_REFUSED = "endpoint_refused";

/**
 * Endpoint refusals that are the **node's** to fix, keyed to the discriminator
 * that goes in `error.code` so a daemon and an operator can tell them apart.
 *
 * **These rows name failures; they do not gate retryability** (R72). They were
 * an allowlist with a caller-blaming default, which answered `txpool is full`,
 * bare `transaction underpriced`, `intrinsic gas too low` and
 * `max fee per gas less than block base fee` — all refusals of the *envelope the
 * node built*, none of them anything the caller signed — as `400`, permanently.
 * The default is now the opposite and this list is a naming table.
 *
 * Matched against the whole `cause` chain, because both spellings of the same
 * refusal live in it and neither is reliably on top: go-ethereum's own wording
 * (`insufficient funds for gas * price + value`) sits on the `RpcRequestError`
 * at the bottom, while `sendTransaction` maps that error through viem's
 * `getNodeError` and puts an `InsufficientFundsError` — whose text says
 * "exceeds the balance of the account" and never says "insufficient funds" — on
 * top. Each pattern therefore names the endpoint phrase **and** viem's class,
 * and the walk sees both. Kept as data rather than a chain of `if`s so the list
 * is the thing under test: one test per class (R67), each red when its row goes.
 */
const NODE_SIDE_MESSAGES: readonly (readonly [RegExp, string])[] = [
  // The relayer wallet is empty. The op is dropped, and nothing else in this
  // response would tell an operator to top it up.
  [/insufficient funds|exceeds the balance of the account|InsufficientFundsError/i, "relayer_funds"],
  // The external-self-submitter residue the design already accepts: another
  // transaction from the same key landed between this node's `pending` count
  // read and its broadcast. A retry a second later reads the new count and
  // works.
  [
    /nonce too low|nonce too high|already known|known transaction|replacement transaction underpriced|NonceTooLowError|NonceTooHighError|NonceMaxValueError/i,
    "nonce_conflict",
  ],
];

/** Endpoint refusals identified by JSON-RPC code rather than by message. */
const NODE_SIDE_CODES: ReadonlyMap<number, string> = new Map([
  // The endpoint's own internal error. Not a verdict on the bytes by definition.
  [-32603, "rpc_internal"],
  // The RPC provider is rate-limiting **the node** — R42's code, which viem
  // itself treats as retryable.
  [-32005, "rate_limited"],
]);

const nodeSideFailure = (code: number, chainText: string): string | null =>
  NODE_SIDE_CODES.get(code) ??
  NODE_SIDE_MESSAGES.find(([pattern]) => pattern.test(chainText))?.[1] ??
  null;

/**
 * A refused broadcast is the caller's problem, the node's, or the endpoint's,
 * and the three need different answers.
 *
 * The first discriminator is JSON-RPC's own: a numeric `code` anywhere in the
 * `cause` chain means the endpoint answered and rejected; no code at all means
 * nothing answered, which is `503 chain_unreachable`, retryable — with viem's
 * real HTTP transport a connection failure arrives as an `HttpRequestError`
 * carrying no code, so this is a production branch and not a theoretical one.
 *
 * The second is **who funded the transaction** (R70), and the answer is always
 * "this node" — every write path here is relayer-funded. `insufficient funds`,
 * the nonce family, `-32603` and `-32005` are therefore its own failures, answered
 * `503 relay_unavailable`, **retryable**, with a `code` naming which. Telling a
 * provider whose `settle` was dropped by an empty relayer that its request was
 * malformed and must never be retried is the false statement R57 forbids.
 *
 * **And the default is retryable** (R72). The named classes above are a naming
 * table, not the gate: what earns a `400` here is {@link isVerdict} — the
 * endpoint pronounced on this transaction — and everything else is
 * `relay_unavailable`. Enumerating the node's failures and blaming the caller
 * for the rest is backwards on a door where the caller signed the *op payload*
 * and the node chose the fees, the gas and the nonce.
 *
 * **One definition, used by every door** (R66), rather than copies of the walk
 * over `cause` that will drift.
 *
 * `param` names the request field at fault and is `null` on every door that is
 * left, since the node built the bytes. The `400` it lands on is not dead: it is
 * the case {@link viewRead} reads to recognise a verdict, and the answer
 * `PUT /evm/asks` gives when the chain itself pronounces.
 */
export function sendFailure(error: unknown, param: string | null = null): ApiError {
  // Before anything JSON-RPC-shaped, because this one never reached an endpoint
  // (R76): the relayer queue refused it here, in this process. The evidence
  // `sendFailure` reads — a numeric `code`, revert data, the endpoint's own
  // wording — is all absent, so without this branch a full queue would be
  // reported as `chain_unreachable` and send an operator to inspect an RPC
  // endpoint that is perfectly healthy. Retryable, and never a `400`: the queue
  // is the node's condition and nothing about the request is wrong.
  if (error instanceof RelayUnavailableError) {
    return new ApiError(503, "relay_unavailable", `the node could not relay this op: ${error.message}`, null, error.code);
  }

  const chain = causeChain(error);
  const code = rpcCode(chain);
  const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
  if (code === null) {
    return new ApiError(503, "chain_unreachable", `could not reach the RPC endpoint: ${message}`);
  }

  {
    // The named classes first, so an operator gets the discriminating `code`
    // rather than the generic one — and so `-32603` keeps beating the wording,
    // which is the recorded ordering: a revert that reaches the *send* stage
    // means the state moved under an op the simulate had already passed, and
    // that is transient.
    const nodeSide = nodeSideFailure(code, chainText(chain));
    if (nodeSide !== null || !isVerdict(error)) {
      const failure = nodeSide ?? ENDPOINT_REFUSED;
      return new ApiError(
        503,
        "relay_unavailable",
        `the node could not relay this op: ${message}. ` +
          (failure === "relayer_funds"
            ? "The relayer account that funds gas for this node is empty and an operator " +
              "must top it up; the op was not broadcast and nothing about the request is wrong."
            : "The op was not broadcast and nothing about the request is wrong; retry it."),
        // No request field is at fault: this is the node's transaction, not the
        // caller's.
        null,
        failure,
      );
    }
  }

  return new ApiError(
    400,
    "invalid_request",
    `the endpoint refused the transaction: ${message}`,
    param,
  );
}

/** The first JSON-RPC code in the chain, or `null` if nothing answered at all. */
function rpcCode(chain: readonly Record<string, unknown>[]): number | null {
  for (const node of chain) {
    if (typeof node.code === "number") return node.code;
  }
  return null;
}

/** Every name and message in the chain, for the message-matched classes. */
const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

const chainText = (chain: readonly Record<string, unknown>[]): string =>
  chain
    .map((node) => `${stringOf(node.name)} ${stringOf(node.message)}`)
    .join("\n");

/**
 * **R77, hung where every view read passes through it.**
 *
 * A failed view read is never a verdict. `sendFailure`'s relayer branch falls
 * through to `400 invalid_request` whenever {@link isVerdict} is true, and a
 * reverting `eth_call` **is** a verdict by that predicate — that is what the
 * predicate is for. But `isVerdict` answers *"did the endpoint pronounce on this
 * transaction"*, and a view read is not a transaction: `gasFee`, `allowedSla`,
 * `idOf`, `lastIdentityAt`, `lastSignedAt`, `getJob` are storage getters on
 * frozen contracts. They cannot revert when the node is configured correctly —
 * they revert when it is **wrong** (an address pointing at some other contract,
 * so the fallback reverts) or when the endpoint reports unavailable historical
 * state as `execution reverted`. Either way the caller's request is fine, and a
 * `400 invalid_request, retryable=false` is the false statement R72 exists to
 * prevent: under R57 it promises the identical request can never succeed, which
 * stops being true the moment the endpoint comes back.
 *
 * So every 400 out of `sendFailure` becomes a retryable `503`, with a `code` an
 * operator can read to see **which** read failed rather than a generic outage.
 * Everything that was already a `503` — a dead endpoint, a rate limit, an empty
 * relayer — passes through untouched, because those classifications are already
 * right and re-deriving them here is how two copies drift.
 *
 * It takes the read rather than the error so a call site cannot obtain the guard
 * and then forget to apply it: there is no way to use this function that leaves
 * the failure unclassified. Every request-path view read in this node is inside
 * one of these, and `test/view-reads.test.ts` enumerates the call sites from
 * the source — **per read**, since Plan 3, rather than per file — so a read
 * added later is a failing test rather than a `500`. The text guard cannot see a
 * `viewRead` that has been made a passthrough, so the three authorisation reads
 * in `chain/client.ts` carry behavioural tests as well: `release.test.ts` and
 * `handover.test.ts` fail each of them at the transport and assert the door
 * answers a retryable `503` naming the read.
 */
export async function viewRead<T>(code: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const failure = sendFailure(error);
    if (failure.status === 400) {
      throw new ApiError(
        503,
        "relay_unavailable",
        "the node could not complete a chain read; nothing about the request is wrong",
        null,
        code,
      );
    }
    throw failure;
  }
}

/**
 * The chain handle, or a truthful 503.
 *
 * A node built without one cannot reach the chain at all, which is the same
 * condition the readiness probe reports as `chain_unreachable` — so it gets the
 * same answer, retryable, rather than a 404 that would make the route look
 * absent from the inventory Plans 3 and 4 code against.
 *
 * **It lives here rather than in `api/deps.ts`, and that is the whole point**
 * (S5). `deps.ts` also houses `requireSession` and `resolveProviderId`, so it
 * imports `src/db/db.ts` — which put a `Db` one `import` line away from
 * `src/api/escrow.ts`, the file whose defining property is that `/release` never
 * reads Postgres (P7). Nothing called into it and the compiler would never have
 * objected. P7 is now enforced by the import graph as well as by the injected
 * dependencies: there is no path from the escrow doors to the store.
 */
export function requireChain(chain: Chain | undefined): Chain {
  if (chain === undefined) {
    throw new ApiError(503, "chain_unreachable", "no chain endpoint is configured");
  }
  return chain;
}

/**
 * {@link requireChain} as a hook, so a node with no chain answers `503` before
 * the body is validated — the same order the handler-side check always gave.
 */
export const chainGate = (chain: Chain | undefined) => async () => {
  requireChain(chain);
};
