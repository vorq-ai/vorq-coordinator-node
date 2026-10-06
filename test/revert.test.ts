import { describe, expect, it } from "vitest";
import { causeChain, isVerdict, revertData } from "../src/chain/revert.js";

/**
 * `isVerdict` on its own, against raw error shapes.
 *
 * The door tests in `api-ops.test.ts` drive this predicate through viem, and
 * viem is helpful in a way that hides one of its three clauses: it rewrites
 * *every* code-3 error into an `ExecutionRevertedError` whose message begins
 * "Execution reverted", so through that path the wording clause happens to catch
 * everything the code clause would have. That is precisely the dependency this
 * predicate must not have — the whole point of testing the JSON-RPC code is to
 * not depend on a message string nobody standardised, and a clause held up only
 * by another library's phrasing is one release away from being held up by
 * nothing.
 *
 * So the shapes here are the ones an endpoint really sends, unwrapped. No
 * network, no chain, no database — this file runs in every `npm test`.
 */

/** An endpoint's own JSON-RPC error object, as it arrives on the wire. */
const rpcError = (fields: Record<string, unknown>) =>
  Object.assign(new Error("RPC Request failed."), { cause: fields });

describe("isVerdict", () => {
  it("is true when revert data actually came back, whatever the endpoint calls it", () => {
    // The strongest evidence and the only one that cannot be imitated: nothing
    // but an executed revert produces data. Endpoints exist that return the
    // bytes under a code of their own invention and never say "reverted".
    expect(isVerdict(rpcError({ code: -32015, message: "VM execution error.", data: "0xdeadbeef" })))
      .toBe(true);
  });

  it("is true on JSON-RPC code 3 alone, with no recognisable wording anywhere", () => {
    // The clause the door tests cannot reach, because viem rewrites every code-3
    // error into "Execution reverted …" before this ever sees it. Code 3 *is*
    // the statement that the call executed and reverted; the wording varies
    // between endpoints and between versions of one endpoint.
    expect(isVerdict(rpcError({ code: 3, message: "reverted" }))).toBe(true);
    // And a bare `revert()` — code 3, data `0x` — is still a verdict. The test
    // is "did the endpoint answer with a revert", never "is `raw` null": empty
    // data means there was nothing to decode, not that nothing was decided.
    expect(revertData(rpcError({ code: 3, message: "reverted", data: "0x" }))).toBe(null);
    expect(isVerdict(rpcError({ code: 3, message: "reverted", data: "0x" }))).toBe(true);
  });

  it("is true on the endpoint's own wording under a code that is not 3", () => {
    // go-ethereum answers a reverted `eth_call` with code 3; that is not
    // universal, and some endpoints report the identical refusal under -32000
    // where only the wording distinguishes it. Requiring code 3 there would
    // answer every `NotOpen` as a retryable 503, forever.
    expect(isVerdict(rpcError({ code: -32000, message: "execution reverted" }))).toBe(true);
  });

  it("is FALSE when nothing answered, even if the words are in the text", () => {
    // The guard that makes the wording clause safe. A transport failure carries
    // no JSON-RPC code anywhere in the chain, and its text is the node's own
    // account of a socket — not the chain speaking. Without this, a message
    // quoting the request (which can contain anything) could talk the node into
    // reporting a verdict nobody pronounced.
    const dead = Object.assign(new Error("HTTP request failed. execution reverted"), {
      status: 500,
    });
    expect(causeChain(dead).some((node) => typeof node.code === "number")).toBe(false);
    expect(isVerdict(dead)).toBe(false);
  });

  it("is FALSE for the endpoint's own failures, which are the node's to fix", () => {
    // Everything R70 and R72 exist for: the endpoint answered and refused, but
    // it never ran the op. On a relayer-funded door these are `503`, retryable.
    expect(isVerdict(rpcError({ code: -32005, message: "limit exceeded" }))).toBe(false);
    expect(isVerdict(rpcError({ code: -32603, message: "internal error" }))).toBe(false);
    expect(isVerdict(rpcError({ code: -32000, message: "insufficient funds for gas * price + value" })))
      .toBe(false);
    expect(isVerdict(rpcError({ code: -32000, message: "txpool is full" }))).toBe(false);
  });

  it("walks the whole cause chain, not just the error it was handed", () => {
    // The evidence is spread over the chain — viem puts its own class on top and
    // the endpoint's code several `cause`s down — so a predicate that reads only
    // the outermost error reads the wrapper rather than the answer.
    const wrapped = Object.assign(new Error("Call failed."), {
      cause: rpcError({ code: 3, message: "reverted" }),
    });
    expect(isVerdict(wrapped)).toBe(true);
  });
});
