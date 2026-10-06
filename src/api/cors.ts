import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

/**
 * Cross-origin access, for the one caller that cannot help itself.
 *
 * Every caller before the JavaScript SDK was a server — the Python SDK, the
 * provider daemon, the e2e harness — and a server sends whatever headers it
 * likes and reads whatever comes back. A browser does neither: it will not issue
 * a single cross-origin request until a preflight is answered, and it hands the
 * page only the seven CORS-safelisted response headers — `Cache-Control`,
 * `Content-Language`, `Content-Length`, `Content-Type`, `Expires`,
 * `Last-Modified`, `Pragma` — unless the server names the rest. Both halves are
 * here, and the second is the one that fails quietly.
 */

/**
 * The non-safelisted response headers a browser client is allowed to read.
 *
 * **This list is the browser half of three contracts**, and each of them
 * degrades silently without it — in a browser and nowhere else. Node, the Python
 * suite and the e2e stack stay green through all three, which is the worst
 * available failure shape:
 *
 *   * `x-vorq-retryable` (R57) is how a client decides whether to retry.
 *     Unreadable, it reads as absent, and the client stops retrying anything at
 *     all — including the `503`s this node answers for the seconds its index
 *     spends catching up.
 *   * `x-request-id` is what every raised error is reported with. Unreadable,
 *     every browser-side failure becomes untraceable in this node's own logs.
 *   * `x-vorq-page-truncated` and `x-vorq-next-offset` are `budgeted()`'s stop
 *     condition and its resume cursor (R61, `./paging.ts`). Unreadable, a page
 *     cut short by the byte budget reads as the end of the list, and a caller
 *     receives a partial answer that looks complete.
 *
 * **`x-should-retry` is named here and this node never sets it.** It is the
 * openai package's own retry opt-out, minted inside each SDK's compatibility
 * shim on a response manufactured in-process that never crosses a network. It
 * stays on the list because naming a header the server does not send costs a
 * browser nothing, and because the day a forwarded response does carry one it is
 * already readable. Do not go looking for the `reply.header` that sets it.
 *
 * `test/api-cors.test.ts` scans `src/` for every header-setting call — the
 * `.header("…")` form this node writes today, in either quote style, and every
 * key of a `.headers({ … })` literal — and asserts each name appears here, so a
 * sixth header cannot reach a response without arriving in this list first. What
 * that scan cannot see is written down beside it, `reply.raw.setHeader` first
 * among them: it bypasses Fastify's reply API and therefore every pattern
 * anchored on it.
 *
 * **That scan must match chained call sites, not just `reply.header(`.** Only
 * three of the nine call sites today are written with that receiver
 * (`./app.ts`, and both of `./paging.ts`'s); the other six hang off a reply
 * builder mid-chain, in `./errors.ts`, `./routes/ops.ts` and `./routes/post.ts`.
 * A pattern anchored on the receiver name therefore finds `x-request-id`,
 * `x-vorq-page-truncated` and `x-vorq-next-offset` and misses `x-vorq-retryable`
 * outright — the one header whose loss silently stops a client retrying — while
 * still reporting itself green on the three it did find. Match on `.header(` and
 * let the name literal do the work.
 */
export const EXPOSED_HEADERS = [
  "x-request-id",
  "x-vorq-retryable",
  "x-vorq-page-truncated",
  "x-vorq-next-offset",
  "x-should-retry",
] as const;

/**
 * Registers CORS on `app`, or registers nothing at all.
 *
 * **Called on the root instance, outside the readiness gate, and that placement
 * is load-bearing.** `@fastify/cors` answers a preflight from a wildcard
 * `OPTIONS *` route registered in whatever scope it is handed, and it is
 * `fastify-plugin`-wrapped, so "whatever scope it is handed" is exactly the
 * instance `register` was called on. Inside the gated plugin
 * (`./app.ts`, `app.register(async (gated) => …)`) that route lands in the
 * gate's scope, where it *may* inherit the gate's `onRequest` hook: `addHook`
 * defers through `instance.after(...)`, so within one scope hooks and
 * `register()` calls fire in avvio queue order rather than source order.
 * Register after the gate's `addHook` and the preflight is answered `503` for as
 * long as the index trails the chain; register before it and the cors hook is
 * queued first, short-circuits the preflight with `reply.code(204).send()`, and
 * the gate hook never runs for it — so the preflight looks perfectly healthy.
 * Both are wrong and the second is far quieter.
 *
 * A `503` to a preflight reaches the page as an opaque CORS failure with no
 * status and no body — an integrator would go looking at their own origin
 * configuration for a node that is merely catching up. The quiet one costs
 * something different, and a preflight cannot show it: Fastify's *router* is one
 * global tree, so the wildcard `OPTIONS *` route matches every URL from
 * whichever scope it was registered in, and answers `OPTIONS /healthz` too. What
 * is encapsulated is the pair of hooks that stamp the headers, and those would
 * then never run for anything outside the gate — `/healthz`, `/readyz`, and the
 * session, relay, ops, post, file, ask and escrow doors registered on the root
 * instance, every one of which a browser calls. Only a *simple* request to an
 * ungated route reveals it, which is what `test/api-cors.test.ts`'s first test
 * asserts.
 *
 * Registered here, on the root instance, neither misplacement is reachable: the
 * preflight is answered throughout, every ungated route is covered, and the
 * gated routes' own `503`s carry `Access-Control-Allow-Origin` so a browser can
 * read the envelope and the `x-vorq-retryable` that goes with it.
 *
 * An empty allowlist registers nothing rather than registering an allowlist that
 * matches nothing. The wire effect is the same — no `Access-Control-*` header,
 * ever — and the node keeps the exact route table it had before this plugin
 * existed, which is the honest rendering of "no browser calls this deployment".
 */
export function registerCors(app: FastifyInstance, config: Config): void {
  if (config.corsOrigins.length === 0) return;

  // The second line, and deliberately not the first: a `"*"` typed into
  // `CORS_ORIGINS` is refused by `loadCorsOrigins` (`../config.ts`), with the
  // message that explains why an allowlist has no wildcard. This check exists
  // because `Config` is a plain interface — tests and `scripts/` build one by
  // hand and never pass through the loader — and because of what this plugin
  // does with the value if it ever arrives: `normalizeCorsOptions`
  // (`@fastify/cors`) promotes *any* array containing `"*"` to `origin: "*"`
  // outright, before the array below is ever consulted. One stray entry
  // therefore turns an allowlist into open-to-the-internet, silently, with every
  // suite in this repository still green — the posture flips in a browser and
  // nowhere a server-side test can look. The claim below, that this is never a
  // reflection of whatever arrived, has to be a property of the module that
  // builds the options and not of a validator two files away.
  //
  // Thrown rather than filtered: a config that reached here carrying `"*"` was
  // built by something that meant it, and dropping the entry would hand that
  // caller an allowlist while it believed it had a wildcard.
  if (config.corsOrigins.includes("*")) {
    throw new Error(
      'corsOrigins contains "*", which @fastify/cors promotes to a full wildcard rather than ' +
        "treating as one entry of an allowlist. Origins are validated in loadCorsOrigins " +
        "(src/config.ts); a Config built by hand must carry exact origins too.",
    );
  }

  app.register(cors, {
    // An array: a listed origin is reflected, anything else gets no
    // `Access-Control-Allow-Origin` header at all. Deliberately not a function
    // and never a reflection of whatever arrived — an allowlist that echoes its
    // input is not an allowlist.
    origin: [...config.corsOrigins],
    // The session token is an `Authorization: Bearer vorq_sess_…` header the
    // client sets itself (`./deps.ts`, `requireSession`) and no cookie is used
    // anywhere in this node, so credentialed mode buys nothing — and it would
    // foreclose the wildcard a future public read surface might want. Turning it
    // on is a materially different security posture and needs its own review.
    credentials: false,
    // Every method this API actually serves. `HEAD` because Fastify derives one
    // from each `GET`; `OPTIONS` is the plugin's own and needs no listing.
    methods: ["GET", "HEAD", "POST", "PUT"],
    // `authorization` for the session token, `content-type` for both the JSON
    // bodies and the `multipart/form-data` of `POST /v1/files`. Listed rather
    // than reflected from `Access-Control-Request-Headers`, so what this node
    // accepts is a statement and not an echo.
    allowedHeaders: ["authorization", "content-type"],
    exposedHeaders: [...EXPOSED_HEADERS],
    // Ten minutes of preflight cache. Chrome caps it at 7200 s and Firefox at
    // 86400 s, so this is well inside both, and short enough that an allowlist
    // change takes effect within a coffee break.
    maxAge: 600,
    // `strictPreflight` keeps its default of `true`: an `OPTIONS` missing either
    // `Origin` or `Access-Control-Request-Method` is answered 400 rather than
    // treated as a preflight. No browser sends one of those, and a hand-rolled
    // curl probe that omits them is better told so than silently indulged.
  });
}
