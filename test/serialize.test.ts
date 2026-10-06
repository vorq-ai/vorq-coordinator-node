import { describe, expect, it } from "vitest";
import { rawJson, toJsonText } from "../src/api/serialize.js";

/**
 * The JSON boundary's own tests. Its *behaviour* is pinned by the read API's
 * suite, where the rows come from Postgres and the assertions are about what a
 * client receives; what is pinned here is the boundary's cost, which no
 * correctness test can see.
 */

describe("toJsonText cost", () => {
  /**
   * A listing of `count` rows, each carrying a `jsonb` value spliced in as raw
   * text — the shape of `/evm/providers` and `/evm/allowlist`.
   */
  const listing = (count: number) => ({
    entries: Array.from({ length: count }, (_, index) => ({
      key: Buffer.alloc(32, index % 256),
      status: 1,
      reputation: BigInt(index),
      entry: rawJson(`{"image":"a","n":${index}}`),
    })),
    as_of_block: 4242n,
  });

  it("splices a whole listing in one pass, not one pass per row", () => {
    // The regression this exists to catch: substituting the placeholders with
    // one `String.replace` per row rescans the entire body once per row, which
    // is quadratic in the row count. Measured on the implementation that did:
    // 500 rows 15 ms, 2000 rows 218 ms, 8000 rows 2420 ms — so 20 000 rows cost
    // roughly 15 s, and every one of those milliseconds is the event loop
    // blocked for every other request, not just this one.
    //
    // The row count is chosen by the caller: these listings are unauthenticated
    // and anyone can register a provider. So the bound below is not a
    // micro-benchmark, it is the difference between a response and an outage.
    //
    // 20 000 rows in under a second is a ~15x margin against the quadratic
    // implementation and a ~10x margin over the linear one on a slow machine,
    // which is what keeps this from being a flaky timing test.
    const rows = 20_000;
    const value = listing(rows);

    const startedAt = performance.now();
    const text = toJsonText(value);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);

    // Asserted as well as timed: a splice that got faster by not splicing would
    // otherwise pass.
    const parsed = JSON.parse(text) as { entries: { n?: number; entry: { n: number } }[] };
    expect(parsed.entries).toHaveLength(rows);
    expect(parsed.entries[rows - 1]?.entry).toEqual({ image: "a", n: rows - 1 });
  });

  it("keeps every placeholder distinct, so no row takes another's value", () => {
    // One regex pass over the text means every placeholder is resolved by its
    // own index rather than by position, and the indices must not collide —
    // `:1` must not match the placeholder for `:19`.
    const text = toJsonText(Array.from({ length: 25 }, (_, index) => rawJson(String(index))));
    expect(JSON.parse(text)).toEqual(Array.from({ length: 25 }, (_, index) => index));
  });

  it("leaves a substitution pattern in spliced text inert", () => {
    // `evidence` is arbitrary bytes written by any registered provider. With the
    // string form of `String.replace`, `$&` and "$`" are substitution patterns
    // and would splice parts of the response body into the value.
    const evidence = '{"raw":"$& $` $\' $1 $$"}';
    const text = toJsonText({ evidence: rawJson(evidence) });
    expect(JSON.parse(text)).toEqual({ evidence: { raw: "$& $` $' $1 $$" } });
  });

  it("refuses text that is not JSON, rather than corrupting the whole body", () => {
    // A malformed splice does not break one field; it breaks the response, and
    // the client sees a parse error with nothing pointing back here.
    expect(() => rawJson("{oops")).toThrow(TypeError);
  });
});
