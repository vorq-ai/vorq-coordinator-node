import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { EXPOSED_HEADERS } from "../src/api/cors.js";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import type { Addresses, Config } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";

/**
 * Cross-origin access (spec 02).
 *
 * **Everything asserted here fails only in a browser.** A missing
 * `Access-Control-Expose-Headers` leaves this node's responses byte-identical
 * on the wire and leaves every server-side suite in this repository green,
 * while `fetch` quietly refuses to hand the page a header it can plainly see.
 * That is the reason this file exists at all.
 *
 * No database and no chain: `/healthz` and the readiness gate are the whole
 * surface under test, and `unreachableDb` proves neither is reached.
 */

/** A valid secp256k1 scalar. Not a credential — no chain has ever used it. */
const DUMMY_KEY = `0x${"11".repeat(32)}` as const;

const ALLOWED = "https://app.vorq.co";
const UNLISTED = "https://not-vorq.example";

const ADDRESSES: Addresses = {
  chainId: 97,
  deployBlock: 0,
  jobRegistry: "0x1111111111111111111111111111111111111111",
  providerRegistry: "0x2222222222222222222222222222222222222222",
  askRegistry: "0x3333333333333333333333333333333333333333",
  usdc: "0x4444444444444444444444444444444444444444",
  decimals: 6,
  tokenDomain: { name: "USDC", version: "2" },
};

const config = (corsOrigins: string[]): Config => ({
  rpcUrl: "http://localhost:8545",
  getLogsCap: 5000,
  dbUrl: "postgres://unused",
  relayerKey: DUMMY_KEY,
  // Long, so the readiness probe is taken once and the gate's answer is stable
  // for the whole of a test.
  blockTimeMs: 60_000,
  port: 8402,
  corsOrigins,
  readyLagBlocks: 30,
  maxBlobBytes: MAX_BLOB_BYTES,
  fileRetentionSeconds: 2_592_000,
  pinS3: {
    endpoint: "http://127.0.0.1:1",
    key: "unused",
    secret: "unused",
    bucket: "unused",
    region: "us-east-1",
  },
  relayMaxDepth: 32,
  relayQueueTimeoutMs: 10_000,
  relayerLowBalanceGwei: 50_000_000,
  match: { leaseMs: 20_000, livenessMs: 15_000, candidates: 3 },
  jobRateLimit: 0,
  escrow: {
    mode: "off",
    releaseOrdinal: 1,
    sweepIntervalMs: 300_000,
    peerUrl: null,
    peerRequired: false,
    peerSyncMs: 300_000,
    rotateIntervalMs: 86_400_000,
    operatorKeys: [],
    clockOffsetMs: 0,
  },
  addresses: ADDRESSES,
});

/** A database no test here may reach: nothing under test reads the index. */
const unreachableDb = (): Db => ({
  query: () => Promise.reject(new Error("no test in this file reads the index")),
  tx: () => Promise.reject(new Error("no test in this file reads the index")),
  migrate: () => Promise.reject(new Error("no test in this file reads the index")),
  close: async () => undefined,
});

const stubIndexer = (ready: boolean): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({
    cursor: 100n,
    head: ready ? 100n : 900n,
    ready,
    forked: null,
  }),
  start: async () => undefined,
  stop: async () => undefined,
});

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(corsOrigins: string[], ready = true): FastifyInstance {
  app = buildApp({
    db: unreachableDb(),
    indexer: stubIndexer(ready),
    config: config(corsOrigins),
  });
  return app;
}

describe("CORS", () => {
  it("answers a preflight for a gated route while the index is still catching up", async () => {
    // **The test that matters.** Registering CORS inside the readiness gate is
    // the likely mistake: the plugin's wildcard `OPTIONS *` route would land in
    // that scope, where it may inherit the gate's `onRequest` hook, so a
    // preflight would be answered 503 for as long as the node trailed the
    // chain. In a browser that arrives as an opaque CORS failure with no status
    // and no body, and sends an integrator hunting their own origin
    // configuration for a node that is merely catching up. It is invisible on a
    // caught-up node, which is why the gate is deliberately shut here.
    //
    // **There are two ways to make that mistake and one assertion does not
    // separate them**, because a Fastify `onRequest` hook added with `addHook`
    // is deferred through `instance.after(...)`: within one scope, hooks and
    // `register()` calls run in avvio queue order, not in source order.
    //
    //   * `registerCors(gated, …)` **after** the gate's `addHook` — the gate
    //     hook runs first and the preflight below comes back 503. Caught by the
    //     preflight assertion.
    //   * `registerCors(gated, …)` as the **first** statement of the gate
    //     plugin — the cors hook is queued first, short-circuits with
    //     `reply.code(204).send()`, and the gate hook never runs at all. The
    //     preflight below is a perfectly good 204 and this test is happy. This
    //     is the *likelier* misplacement, because top-of-scope is exactly where
    //     the call correctly sits today in `buildApp`.
    //
    // **A preflight to an ungated route does not separate them either**, and it
    // is worth knowing why before reaching for one. Fastify's *router* is a
    // single global tree: encapsulation scopes hooks and decorators, not URL
    // matching. The plugin's wildcard `OPTIONS *` route registered inside the
    // gate still matches `OPTIONS /healthz`, and answers it 204 with an origin.
    // Measured, not assumed.
    //
    // What does separate them is a **simple** request to an ungated route. The
    // cors hooks themselves are encapsulated, so under either misplacement they
    // never run for `/healthz`, `/readyz`, or any of the doors registered on the
    // root instance — the session, relay, ops, post, file, ask and escrow routes
    // all of which a browser calls. That is the real damage of misplacement, and
    // it is what the last assertion here pins. Without it the second
    // misplacement surfaces only as test 3 failing on a missing
    // `Access-Control-Expose-Headers`, a message that points nowhere near
    // placement.
    const server = build([ALLOWED], false);

    const gated = await server.inject({ method: "GET", url: "/evm/jobs" });
    expect(gated.statusCode, "the gate must still be shut, or this proves nothing").toBe(503);

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/evm/jobs",
      headers: { origin: ALLOWED, "access-control-request-method": "GET" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(ALLOWED);

    // `/healthz` is registered on the root instance, outside the gate's scope,
    // and this is a plain `GET` rather than a preflight on purpose — see above.
    // The cors `onRequest`/`onSend` pair is encapsulated where it is registered,
    // so an in-gate placement cannot stamp this response at any hook position.
    const ungated = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED },
    });
    expect(
      ungated.headers["access-control-allow-origin"],
      "CORS must be on the root instance: an ungated route needs it too",
    ).toBe(ALLOWED);
  });

  it("lets a browser read the gate's own 503, envelope and retryable header included", async () => {
    // The other half of being outside the gate: the CORS hook runs on the root
    // instance, so it has already stamped the response by the time the gate
    // throws. Without it the browser can see that *something* failed and
    // nothing about what, including the `x-vorq-retryable: true` that says to
    // come back (R57).
    const server = build([ALLOWED], false);

    const res = await server.inject({
      method: "GET",
      url: "/evm/jobs",
      headers: { origin: ALLOWED },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
  });

  it("names every header the SDK reads in Access-Control-Expose-Headers", async () => {
    const server = build([ALLOWED]);

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED },
    });
    expect(res.statusCode).toBe(200);
    // Split rather than string-compared, so the assertion is about the names and
    // not about how the plugin joins them.
    const exposed = String(res.headers["access-control-expose-headers"]).split(/\s*,\s*/);
    expect(exposed).toEqual([...EXPOSED_HEADERS]);
    // `Vary: Origin` has teeth: the answer to "may this origin read?" differs
    // per origin, so a shared cache that keys on the URL alone would hand one
    // origin's `Access-Control-Allow-Origin` to another. The plugin emits it
    // because the allowlist is an array; pinned here so a later switch to a
    // single origin or a function cannot drop it silently.
    expect(res.headers.vary).toBe("Origin");
  });

  it("allows the two request headers a client sends, and no more", async () => {
    const server = build([ALLOWED]);

    const res = await server.inject({
      method: "OPTIONS",
      url: "/v1/files",
      headers: { origin: ALLOWED, "access-control-request-method": "POST" },
    });
    // `authorization` for the session token, `content-type` for both the JSON
    // bodies and the multipart of POST /v1/files.
    const allowed = String(res.headers["access-control-allow-headers"]).split(/\s*,\s*/);
    expect(allowed).toEqual(["authorization", "content-type"]);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    // Ten minutes, and asserted because it is otherwise invisible: a browser
    // silently re-preflighting every request is a latency regression no
    // server-side suite can see.
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("sends no Access-Control-Allow-Origin to an origin that is not on the list", async () => {
    const server = build([ALLOWED]);

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: UNLISTED },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // The positive control. An absence assertion on its own passes just as
    // happily when the plugin was never registered, which is to say it would
    // still pass with this whole feature deleted. `Access-Control-Expose-Headers`
    // goes to every origin, listed or not, so its presence proves the plugin ran
    // and *withheld* the origin header rather than never having had the chance.
    expect(res.headers["access-control-expose-headers"]).toBeDefined();
  });

  it("names no origin on an unlisted origin's preflight either", async () => {
    // The status is the plugin's business and is deliberately not asserted: what
    // makes the browser refuse the real request is the absence of the header,
    // not the code the preflight came back with.
    const server = build([ALLOWED]);

    const res = await server.inject({
      method: "OPTIONS",
      url: "/evm/jobs",
      headers: { origin: UNLISTED, "access-control-request-method": "GET" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // The positive control, for the same reason as above: without it this test
    // passes on a node with no CORS registered at all. The plugin does answer an
    // unlisted preflight — methods, headers, max-age and expose-headers all
    // present — and withholds exactly one header, which is the whole point.
    expect(res.headers["access-control-allow-methods"]).toBe("GET, HEAD, POST, PUT");
  });

  it("never sends Access-Control-Allow-Credentials: no cookie is used anywhere", async () => {
    // A deliberate choice, not an omission. The session token is an
    // `Authorization` header the client sets itself; credentialed mode buys
    // nothing here and forecloses a future wildcard. Turning it on is its own
    // review.
    const server = build([ALLOWED]);

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED },
    });
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    // The positive control. `toBeUndefined()` alone is satisfied by a node that
    // registered no CORS whatsoever, so it would keep passing if this feature
    // were deleted outright. The origin header proves the plugin answered this
    // very response and chose not to send the credentials one.
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("registers nothing at all when the allowlist is empty", async () => {
    // Not "an allowlist that matches nothing" — nothing. The node keeps the
    // exact route table it had before this plugin existed, which is the honest
    // rendering of a deployment no browser calls.
    const server = build([]);

    const res = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ALLOWED },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-expose-headers"]).toBeUndefined();

    const preflight = await server.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: ALLOWED, "access-control-request-method": "GET" },
    });
    expect(preflight.statusCode).toBe(404);
  });

  it('refuses a "*" entry rather than registering the wildcard it would become', () => {
    // `loadCorsOrigins` refuses `"*"` where it is typed, and every deployment
    // goes through it. Nothing else does: `Config` is a plain interface, and the
    // `config()` helper at the top of this file is itself an example of one
    // built by hand, as are `scripts/`. `@fastify/cors` promotes *any* array
    // containing `"*"` to `origin: "*"`, so one entry is the whole distance
    // between an allowlist and open-to-the-internet — and not one assertion
    // above would notice the trip: a wildcard answers `ALLOWED` and `UNLISTED`
    // alike, so the two "sends no Access-Control-Allow-Origin" tests are the
    // only ones that would even change colour, and only if someone read them as
    // being about posture rather than about a header. The posture flips in
    // browsers, where nobody runs this suite.
    //
    // The message is asserted on the name of the loader on purpose: this check
    // is the second line, and a reader who hits it needs to be sent to the first
    // rather than left thinking origin validation lives in the plugin wiring.
    //
    // `build()` is used as it stands — it assigns `app` only on the way back
    // out, so a throw leaves nothing for `afterEach` to close.
    expect(() => build(["*"])).toThrow(/loadCorsOrigins/);
  });
});

/**
 * The exposed-header contract, enforced against the source rather than against
 * somebody's memory.
 *
 * A header added to a response and not to `EXPOSED_HEADERS` is on the wire, is
 * plainly visible in curl, and is refused to `fetch` — so it passes every suite
 * in this repository and fails in exactly one place, a browser, where nobody is
 * running the tests. The scan below is what makes that arrive as a red test on
 * the commit that caused it.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The headers a browser exposes with no help from the server. Setting one of
 * these needs no entry in `EXPOSED_HEADERS`, so the scan ignores them.
 */
const SAFELISTED = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "expires",
  "last-modified",
  "pragma",
]);

/**
 * `source` with its comments removed, because the scan below reads text and not
 * syntax and cannot otherwise tell a call from a sentence about one.
 *
 * This is not hypothetical. `src/api/cors.ts`'s own docblock explains the very
 * contract being enforced here, in the sentence "scans `src/` for every
 * `.header("…")` that sets a response header" — which the pattern matches,
 * capturing a header named `…` and failing both assertions below on a tree where
 * nothing is wrong. Excluding that one file by name would fix that one sentence;
 * stripping comments retires the whole class, and leaves every file free to
 * discuss the calls it makes.
 *
 * Crude on purpose: block comments first, then to-end-of-line, with `://`
 * spared so a URL literal is not mistaken for a comment. It does not tokenise,
 * so a `//` inside some other string literal truncates the rest of that line.
 * The guard test below is what makes that visible — a call lost to over-eager
 * stripping changes the scanned set, and the pinned list goes red.
 *
 * **What the tree proves, and what it does not.** Every specimen in `src/` that
 * discusses a header call — the `cors.ts` docblock above all — is written as a
 * doc comment, so the tree exercises the block-comment replace and nothing else.
 * Delete the to-end-of-line replace, and the `://` sparing with it, and all of
 * this file stays green: the stripper would be half dead, the contract half
 * enforced, and the first line-commented `.header(` anyone writes in `src/`
 * would fail two tests on a tree where nothing was wrong. That is this change's
 * own failure shape wearing different clothes, so the branch is exercised
 * directly by "strips both comment forms" below, on an input written here.
 * Feeding it a fixture through `src/` instead would mean adding prose to
 * production source for no reason but this test — prose the next reader is
 * entitled to delete, taking the coverage with it and saying nothing.
 *
 * One case stays unproven, and is stated rather than disclaimed: a `//` inside a
 * string literal that is not a URL still eats the rest of its line, and nothing
 * here asserts otherwise because there is nothing better to assert. The pinned
 * list in the guard test is what stands under that.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every non-safelisted header name a call under `src/` sets.
 *
 * **Wider than the way this repo happens to write them today, on purpose.** All
 * nine call sites are `.header("name", …)` with double quotes; the scan is not
 * for those, it is for the tenth, and the tenth is the one that reaches a
 * response without anyone reviewing it as a header change. A Fastify reply also
 * takes `.headers({ "x-a": …, "x-b": … })`, and TypeScript is indifferent to
 * quote style — a pattern that knows only `.header("` lets either of those put a
 * header on the wire that this contract never sees, with both tests below still
 * green and the header refused to `fetch` in a browser. The scan has to be at
 * least as wide as the ways a header can reach a response, or it manufactures
 * exactly the false green it exists to prevent.
 *
 *   * `.header(` takes its first argument in either quote style. Only the first:
 *     what follows is a value, and `.header("content-type", "application/json;
 *     charset=utf-8")` in `./routes/post.ts` is what a looser pattern would
 *     enrol as a header named after a MIME type.
 *   * `.headers({ … })` takes *every* key of the literal, not the first one.
 *     Keys are the quoted strings followed by a colon, which is also what keeps
 *     the values out. First-key-only would be worse than it sounds: the miss is
 *     silent whenever the first key is already pinned, which is precisely the
 *     shape of adding one header beside `x-request-id`.
 *
 * **What the scan still cannot see.** Measured against it rather than reasoned
 * about, because a limits paragraph that overstates the guard is worse than no
 * paragraph at all — it retires the suspicion that would otherwise do the work:
 *
 *   * `[^}]*` ends the object literal at the first `}`, so a nested literal in a
 *     value truncates the argument, and it does both bad things at once rather
 *     than either. `.headers({ "x-request-id": JSON.stringify({ "inner-key": 1 }),
 *     "x-dropped": "b" })` invents `inner-key` out of a value *and* loses
 *     `x-dropped` — the invented name changes the scanned set, so that one lands
 *     red. The quiet case is the same shape with an unquoted nested key:
 *     `.headers({ "x-request-id": fmt({ pad: 2 }), "x-gone": "b" })` invents
 *     nothing, and the only key it does find is already pinned, so the whole
 *     suite passes green while `x-gone` goes out unexposed to a browser. That is
 *     precisely the failure this contract exists to catch, surviving inside it.
 *   * An unquoted key is not matched at all — the key pattern wants quotes.
 *     Most header names contain `-` and cannot be written bare, which is what
 *     narrows this to the few that can: `.headers({ etag: "abc" })`, and `age`
 *     and `location` beside it.
 *   * `reply.raw.setHeader("x-any", …)` writes to the Node response directly and
 *     never touches Fastify's reply API. No scan anchored on `.header(` can ever
 *     see it — widening the pattern does not reach it, and nothing but review
 *     does. It is the escape hatch, and worth knowing exists before someone
 *     reaches for it to work around a serializer.
 *   * A name held in a variable — `.header(HEADER_NAME, …)` — is invisible to
 *     any scan of text, here as it was before.
 *
 * None of these exists in the tree today; the first and third would be found by
 * a reader and by nothing else. That is the standing limit of reading source as
 * text: this raises the cost of putting a header on the wire without exposing
 * it, and does not make it impossible. The pinned list below is what stands
 * under the cases above.
 */
function headersSetInSource(): string[] {
  const found = new Set<string>();
  const add = (name: string): void => {
    const lowered = name.toLowerCase();
    if (!SAFELISTED.has(lowered)) found.add(lowered);
  };

  for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    const source = withoutComments(readFileSync(join(SRC, entry), "utf8"));
    for (const [, name] of source.matchAll(/\.header\(\s*["']([^"']+)["']/g)) add(name);
    for (const [, literal] of source.matchAll(/\.headers\(\s*\{([^}]*)\}/g)) {
      for (const [, name] of literal.matchAll(/["']([^"']+)["']\s*:/g)) add(name);
    }
  }

  return [...found].sort();
}

describe("the exposed-header contract", () => {
  it("strips both comment forms, so the scan cannot go half-blind", () => {
    // `withoutComments` is what lets every file under `src/` discuss the calls
    // it makes without failing the scan, and only its block-comment half is
    // exercised by the tree — see the docblock above. This is the other half,
    // fed directly rather than through a fixture planted in production source.
    const source = [
      '// reply.header("x-line-commented", "1")',
      '/** documented: reply.header("x-block-commented", "1") */',
      'reply.header("x-real", "1"); // reply.header("x-trailing", "1")',
      'const base = "https://vorq.example/v1"; // the allowlisted origin',
    ].join("\n");

    const stripped = withoutComments(source);

    // One survivor, and it is the only line that actually sets a header.
    expect([...stripped.matchAll(/"(x-[^"]+)"/g)].map(([, name]) => name)).toEqual(["x-real"]);
    // The `://` sparing, pinned on its own: without it this line is truncated at
    // the scheme, and a call written after a URL on the same line disappears
    // from the scan while the scan goes on reporting itself green.
    expect(stripped).toContain('"https://vorq.example/v1"');
  });

  it("is the four headers a client reads, plus the paging cursor one of them implies", () => {
    // Pinned, so a change to this list is a decision and never a side effect. A
    // name removed here is a browser client that silently stops being able to
    // read it.
    expect([...EXPOSED_HEADERS]).toEqual([
      "x-request-id",
      "x-vorq-retryable",
      "x-vorq-page-truncated",
      "x-vorq-next-offset",
      "x-should-retry",
    ]);
  });

  it("finds the headers it scans for, so a broken scan cannot pass by finding nothing", () => {
    // Guards the assertion below, which is vacuously true against an empty set —
    // a moved file or a changed call style would otherwise turn the whole check
    // off without failing anything.
    expect(headersSetInSource()).toEqual([
      "x-request-id",
      "x-vorq-next-offset",
      "x-vorq-page-truncated",
      "x-vorq-retryable",
    ]);
  });

  it("names every non-safelisted header src/ actually sets", () => {
    const exposed = new Set<string>(EXPOSED_HEADERS);
    const missing = headersSetInSource().filter((name) => !exposed.has(name));

    expect(missing, "add these to EXPOSED_HEADERS in src/api/cors.ts").toEqual([]);
  });
});
