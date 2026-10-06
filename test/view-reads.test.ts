import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **R77's guard, enumerated from the source rather than from memory.**
 *
 * A failed view read is never a verdict on the caller's request. That rule was
 * ruled once, implemented on one door (`configRead` in `routes/post.ts`), and
 * then missed on four others — the advisory gate's six reads, `resolveProviderId`
 * on the request path of three doors, and the ask floor read — because nothing
 * connected the rule to the act of writing a `readContract`. Every one of those
 * answered a dead endpoint `500 internal_error, retryable=false`, or told a
 * caller its request was invalid because this node could not read its own chain
 * configuration.
 *
 * So the guard is hung here, on the **act**: a chain read on a request path is
 * written inside `viewRead(...)` or this test fails. It fails in both directions
 * that matter — an unwrapped read in a file that already has guarded ones, and a
 * read in a file nobody thought about at all — so a door added later cannot
 * quietly acquire an unclassified `eth_call`.
 *
 * **The exemption is per read, not per file** (Plan 3's correctness review, §2.2).
 * It used to be a file-level skip, and Plan 3 then moved three genuine
 * request-path authorisation reads — `getJob`, `idOf`, `allowlistStatus` — into
 * `chain/client.ts`, a file the skip covered whole. The reads were wrapped
 * correctly and the guard could no longer see whether they were: an unwrapped
 * `readContract` added to that file was invisible, measured. A file-level skip
 * is a blast radius nobody re-reads, so the escape is now a
 * {@link OFF_MARKER} comment in the read's own statement — next to the read, in
 * the diff that adds it, naming the reason.
 *
 * The two ways to satisfy this test are: wrap the read, or write the marker at
 * it. Both are deliberate acts, which is the whole point.
 */

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every `.ts` under `src/`, relative to it. */
function sources(dir = "", found: string[] = []): string[] {
  for (const entry of readdirSync(join(SRC, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(SRC, rel)).isDirectory()) sources(rel, found);
    else if (entry.endsWith(".ts")) found.push(rel);
  }
  return found;
}

/**
 * The marker that says one read is **not** on a request path, with the reason.
 *
 * Not an exemption from the rule — a statement that no HTTP response depends on
 * how *this* failure is classified. It is written in the read's own statement, so
 * a read that later moves onto a request path has to have its marker deleted,
 * which is a code review rather than an accident.
 */
const OFF_MARKER = "R77-off-request-path:";

/**
 * The prose written after the marker — its own comment, and nothing else.
 *
 * Stops at the first line that is not a comment continuation, so the reason is
 * what somebody wrote and not the code that follows it. A marker with nothing
 * after it is an empty reason, and the assertion below rejects it.
 */
const reasonAfter = (statement: string): string => {
  const [first = "", ...rest] = statement
    .slice(statement.indexOf(OFF_MARKER) + OFF_MARKER.length)
    .split("\n");
  const lines = [first.trim()];
  for (const line of rest) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) break;
    lines.push(trimmed.replace(/^(\/\/|\*)\s?/, "").replace(/\*\/\s*$/, "").trim());
  }
  return lines.join(" ").trim();
};

/**
 * `readContract`, in **both** the spellings viem offers — the client method
 * (`publicClient.readContract({…})`) and the standalone action
 * (`readContract(publicClient, {…})` from `viem/actions`), which is the same
 * `eth_call` and which a `\.readContract\(` pattern silently let through. A
 * guard that only recognises one way of writing the thing it guards is a guard
 * a new door escapes by importing differently, so the boundary is the identifier
 * rather than the member access.
 *
 * `publicClient.call` is deliberately **not** matched: the only one in the tree
 * is the pre-relay simulate in `routes/ops.ts`, which simulates the exact
 * transaction that is about to be broadcast. A refusal there really is the
 * endpoint pronouncing on that transaction, so it is `chainFailure`'s to
 * classify (R80) and R77 does not reach it.
 */
const READS = /(?<![A-Za-z0-9_$])readContract\s*\(/g;

/**
 * The text a declaration may live in: everything since the previous statement
 * ended.
 *
 * Back to the last `;` rather than a character count, so the window is the
 * read's own statement and the comment block attached to it — a `viewRead` two
 * statements earlier cannot be mistaken for this read's wrapper, and a marker
 * comment of any length is still found.
 */
const statementOf = (text: string, at: number): string =>
  text.slice(text.lastIndexOf(";", at) + 1, at);

/**
 * Files whose reads are classified as a chain verdict on purpose — **none**.
 *
 * The escape hatch below is live and detected; it simply has no user. The one
 * read that ever claimed it, `registryFloor` in `routes/ops.ts`, was ruled back
 * under R77: a reverting storage getter is this node's fault, not a verdict on
 * the op, so it answers a retryable `503` like every other view read. The
 * mechanism stays so that a future opt-out has to be written down and shows up
 * here, rather than being invisible.
 */
const DECLARED_VERDICT_READS: readonly string[] = [];

describe("every request-path chain read is classified (R77)", () => {
  const offenders: string[] = [];
  const guarded: string[] = [];
  const declared: string[] = [];
  const offRequestPath: { file: string; reason: string }[] = [];

  for (const file of sources()) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const match of text.matchAll(READS)) {
      const at = match.index ?? 0;
      // The file, not the line: an inventory keyed by line number is a test that
      // fails when a comment above it grows, and this one has to survive being
      // edited or nobody will keep it.
      const where = file;
      const before = statementOf(text, at);
      if (before.includes("viewRead(")) guarded.push(where);
      // Off the request path, said at the read rather than about the file: no
      // HTTP response depends on how *this* failure is classified.
      else if (before.includes(OFF_MARKER)) {
        offRequestPath.push({ file: where, reason: reasonAfter(before) });
      }
      // The escape hatch, and it is a sentence somebody has to write: this
      // read's failure is classified as a chain verdict on purpose, naming the
      // assertion that pins it. Nothing uses it — the marker is still matched so
      // that if anything ever does, the assertion below names the file.
      else if (before.includes("R77-verdict:")) declared.push(where);
      else offenders.push(where);
    }
  }

  it("wraps every one of them in viewRead", () => {
    expect(offenders).toEqual([]);
  });

  /**
   * The inventory, so deleting a wrapper cannot pass by deleting its read too,
   * and so a file that quietly loses its guarded read is visible.
   */
  it("still has the three doors the rule was missing from, and the escrow's three reads", () => {
    expect(guarded).toEqual([
      // `resolveProviderId` — `POST /evm/ops`, `PUT /evm/asks`, the handshake.
      "api/deps.ts",
      // The advisory gate's six reads, through one wrapped helper.
      "api/routes/ops.ts",
      // `registryFloor` — `lastIdentityAt` / `lastCapacityAt`, the registry ops'
      // monotonic floor. Wrapped by the ruling that ended the one opt-out, which
      // is why `ops.ts` is counted twice.
      "api/routes/ops.ts",
      // `AskRegistry.lastSignedAt`, the ask door's floor.
      "asks/publisher.ts",
      // Plan 3's three authorisation reads — `getJob`, `idOf`,
      // `allowlistStatus`. They were invisible to this guard for as long as the
      // skip was per file, which is the finding that made it per read.
      "chain/client.ts",
      "chain/client.ts",
      "chain/client.ts",
    ]);
  });

  it("has no read that is classified as a verdict on purpose", () => {
    // If this grows, R77 is being opted out of rather than applied.
    expect(declared).toEqual(DECLARED_VERDICT_READS);
  });

  /**
   * The other inventory, and the reason it is a list of **reads** rather than of
   * files: `chain/client.ts` holds six off-request-path reads and three guarded
   * ones, and the whole point of the change that produced this test is that
   * those two sets are counted separately.
   */
  it("knows every read that is off the request path, one by one", () => {
    expect(offRequestPath.map((read) => read.file)).toEqual([
      // `chainParams`' four cells — `feeBps`, `gasFee`, `treasury`, `allowedSla`
      // — each wrapped by its caller rather than at the cell: `post.ts`'s
      // `configRead`, and for `feeBps` the `viewRead`s in `routes/relay.ts` and
      // `routes/jobs.ts`.
      // Plus `slaFacts`' two boot-time reads.
      "chain/client.ts",
      "chain/client.ts",
      "chain/client.ts",
      "chain/client.ts",
      "chain/client.ts",
      "chain/client.ts",
      // `tryReconcileJob`'s best-effort repair: its `getJob`, and the `feeBps`
      // a settled row's fee is priced at.
      "index/reconcile.ts",
      "index/reconcile.ts",
      // The boot-time deployment check, `assertDomains`. One read because the
      // four contracts — the three registries and the payment token — are read
      // through a single call site.
      "orders.ts",
    ]);
  });

  it("names a reason at every one of them", () => {
    // A marker with nothing after it is a skip nobody justified, which is the
    // thing the file-level list turned out to be.
    expect(offRequestPath.filter((read) => read.reason.length < 20)).toEqual([]);
  });
});
