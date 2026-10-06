import type { FastifyReply } from "fastify";
import { Type } from "typebox";
import { Uint32 } from "./schemas/common.js";
import { toJsonText } from "./serialize.js";

/**
 * Every listing here is unauthenticated and every one of them grows with the
 * chain, so the row count is chosen by whoever is calling: anyone can register a
 * provider, post a job, or have an allowlist entry curated. An unbounded listing
 * is therefore the same failure as an unbounded `uint32` or an unbounded `jsonb`
 * — a value the chain does not bound reaching a limit the node does not bound —
 * and it is answered the same way, with a bound (R56).
 *
 * `limit` defaults to 100 and caps at 1000. `offset` defaults to 0 and caps at
 * 1 000 000: `OFFSET n` costs O(n) inside Postgres however good the index is, so
 * leaving it open would just move the same unbounded work one layer down. Past a
 * million rows the answer is to narrow the query — `/evm/jobs` takes `state`,
 * `model`, `provider`, `owner`, `min_rate_in`, `min_rate_out` and
 * `posted_before` — not to page further into it.
 *
 * The last three are there because narrowing is not always optional. This
 * listing is ordered `posted_block, job_id`, so the *oldest* rows fill the first
 * page: a provider reading one default page of a large open book sees the
 * cheapest stale bids and never the profitable ones behind them. `min_rate_in` /
 * `min_rate_out` bound the page by price and `posted_before` by age, both
 * evaluated in Postgres, which is the only way to move the interesting rows onto
 * page one at all.
 *
 * This is additive to the frozen route inventory: a caller that sends neither
 * paging parameter gets the first page, in a documented total order. There is no
 * `has_more` field, because the response shapes are frozen and asserted
 * exactly; the paging signals travel as `x-vorq-*` headers instead (R57, R58).
 *
 * **The stop condition has two halves and both are required** (R61): keep paging
 * while `returned === limit` **OR** `x-vorq-page-truncated` is `true`. The header
 * means "the byte budget cut this page", not "there is more data" — a 150-row
 * table answers a default page with 100 rows and `truncated: false`, and a client
 * that stops there silently reads 100 of 150.
 */
export const PAGE_DEFAULT_LIMIT = 100;
export const PAGE_MAX_LIMIT = 1000;
export const PAGE_MAX_OFFSET = 1_000_000;

/**
 * The byte budget for one page (R58). **A row bound is not a size bound.**
 *
 * `providers.evidence` and `allowlist.entry` are arbitrary provider-written
 * bytes, bounded by nothing but gas: about 32 kB per value is reachable for
 * roughly 1 M gas (R50a found 32 730 bytes of nesting reachable at that price).
 * A full 1000-row page of maximal values is therefore a ~32 MB body built
 * synchronously on the event loop — `limit` alone leaves the same
 * unbounded-value-meets-unbounded-limit shape that produced the `int4` overflow,
 * both `jsonb` wedges, and the quadratic splice.
 *
 * 4 MiB is chosen against that reality rather than by taste:
 *
 *   * it holds a full 1000-row page of ~4 kB rows, which is far above anything
 *     the projection produces in normal use (a job row is ~600 B, an allowlist
 *     entry a few hundred), so no legitimate caller ever meets it;
 *   * it still admits ~128 rows of *maximal* 32 kB evidence, so a page of
 *     worst-case rows is a page, not a single row at a time;
 *   * it is 8× below the 32 MB worst case, which keeps one synchronous
 *     serialisation in the low milliseconds.
 */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What the envelope around a page is charged, before a single row is measured.
 *
 * The budget has to bound the **body**, and `budgeted()` only ever sees the rows
 * (R60). Everything else in the body is the wrapper — `{"entries":[`, the closing
 * bracket, `"as_of_block":"…"` — and the largest such wrapper in this API is
 * `/v1/models`' `{"object":"list","data":[],"as_of_block":"18446744073709551615"}`
 * at 62 bytes. 256 is that with room for a route this task has not written yet,
 * and being an over-estimate it errs towards a *smaller* page, which is the
 * direction that cannot break the bound.
 */
export const PAGE_ENVELOPE_BYTES = 256;

export interface Page {
  limit: number;
  offset: number;
}

/** The two paging parameters, spread into a listing's `querystring` schema. */
export const Paging = {
  limit: Type.Optional(
    Uint32({
      minimum: 1,
      maximum: PAGE_MAX_LIMIT,
      default: PAGE_DEFAULT_LIMIT,
      description:
        "Rows per page. Keep paging while a page is full **or** `x-vorq-page-truncated` is `true`.",
    }),
  ),
  offset: Type.Optional(
    Uint32({
      minimum: 0,
      maximum: PAGE_MAX_OFFSET,
      default: 0,
      description: "Rows to skip; after a truncated page, the `x-vorq-next-offset` header.",
    }),
  ),
};

/** The page a validated query asks for; the schema has filled both defaults. */
export const pageOf = (query: { limit?: number; offset?: number }): Page => ({
  limit: query.limit ?? PAGE_DEFAULT_LIMIT,
  offset: query.offset ?? 0,
});

/**
 * Converts `rows` to their wire shape, stopping once the page reaches
 * {@link PAGE_MAX_BYTES}, and reports what it did in headers.
 *
 * **The headers are the load-bearing half of this, not decoration.** Without
 * them "a short page is the last page" — true while `limit` was the only bound —
 * becomes silently wrong the moment a byte budget can end a page early, and a
 * client would stop reading mid-list believing it had everything. A body that is
 * quietly incomplete is worse than the denial of service the budget prevents,
 * because nothing about it looks wrong. So:
 *
 *   * `x-vorq-page-truncated: true|false` on **every** listing response, so the
 *     signal is present rather than inferred from its own absence;
 *   * `x-vorq-next-offset: <n>` when truncated — where to resume. It is
 *     `offset + rows returned`, so ordinary offset paging continues correctly
 *     with no row skipped and none repeated.
 *
 * A caller keeps paging while `returned === limit` **or** the page was truncated
 * (R61). Neither condition alone is the end of the list.
 *
 * **What is charged, and why it is not only the rows** (R60). The budget is a
 * bound on the emitted **body**, so the count starts at
 * {@link PAGE_ENVELOPE_BYTES} and every row after the first is charged one byte
 * for the comma that separates it from the previous one. Charging rows alone
 * made the assertion `byteLength(body) <= PAGE_MAX_BYTES` true of the *fixture*
 * and not of the *code*: 1000 rows summing to 4 194 303 row-bytes emitted a
 * 4 195 336-byte body, 1 032 bytes over, being 999 commas and a 34-byte envelope.
 * The overshoot was bounded by `(limit − 1) + envelope` and so was never a denial
 * of service — but a budget that can be exceeded is not a budget, and Plan 4 may
 * now read 4 MiB as a real response-size ceiling.
 *
 * **Cost.** Each row is serialised once, on its own, and its size added to a
 * running integer. That is deliberately not "serialise the page so far and
 * measure it", which is the quadratic shape that already cost this API one fix
 * round. The total work is linear in the bytes emitted and bounded by the budget
 * — measuring stops when filling stops.
 *
 * **An oversized row is still served.** The first row of a page is admitted
 * whatever its size: a value larger than the whole budget would otherwise be
 * permanently unreachable, and — because offset paging cannot step over what it
 * never returned — so would every row behind it. One 5 MB row is a bad response;
 * a list that can never be read past position n is a broken one.
 */
export function budgeted<R, T>(
  rows: readonly R[],
  page: Page,
  reply: FastifyReply,
  toWire: (row: R) => T,
): T[] {
  const items: T[] = [];
  let bytes = PAGE_ENVELOPE_BYTES;

  for (const row of rows) {
    const item = toWire(row);
    // Measured, not estimated. A bespoke size model would be a second
    // serialiser that can drift from the real one — and it would drift towards
    // under-counting, which is the direction that does not fail safe. The `+1`
    // is the separating comma this row brings with it.
    const size = Buffer.byteLength(toJsonText(item)) + (items.length > 0 ? 1 : 0);

    if (items.length > 0 && bytes + size > PAGE_MAX_BYTES) break;

    items.push(item);
    bytes += size;
  }

  const truncated = items.length < rows.length;
  reply.header("x-vorq-page-truncated", String(truncated));
  if (truncated) reply.header("x-vorq-next-offset", String(page.offset + items.length));

  return items;
}
