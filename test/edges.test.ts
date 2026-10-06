import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import type { Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { stubChain, testConfig } from "./support/stub-chain.js";
import { MAX_QUOTES, PushBody, parseStoredSnapshot } from "../src/asks/push.js";
import { loadConfig, NUMERIC } from "../src/config.js";
import { PAGE_MAX_LIMIT, PAGE_MAX_OFFSET, Paging } from "../src/api/paging.js";
import { bodyAjv, compileSchema, validationFailure } from "../src/api/schemas/ajv.js";
import { Type, type TSchema } from "typebox";
import { base64Bytes, integer, UINT32_MAX, UINT64_MAX } from "../src/api/params.js";
import { MarketProbe } from "../src/api/routes/post.js";
import { Uint32 } from "../src/api/schemas/common.js";
import { capOf, CapOverflowError, MAX_CAP, MAX_SLA_SECONDS } from "../src/orders.js";
import { MAX_BODY_BYTES } from "../src/api/limits.js";
import { HANDOVER_MAX_PAYLOAD_BYTES } from "../src/escrow/handover.js";

/**
 * **R78's sweep, discharged: every node-side cap, tested AT its edge.**
 *
 * A bound whose edge cannot be moved by one without a test going red is not
 * defended. The whole-branch review flipped 47 comparisons one at a time and 25
 * survived; the fail-open ones and the two that restate a frozen contract
 * comparison are defended in the files that own them (`api-ops`, `api-reads`,
 * `asks`, `reducer`). What is left is this: thirteen node-side caps, each a
 * one-value hole at the boundary, none of them worth a test file of its own —
 * so they are one table, and the table is the point.
 *
 * Each row states the bound, the value **at** it (which must be accepted) and
 * the value **one past** it (which must be refused). Both halves matter and for
 * different reasons: the *past* half is the cap doing its job, and the *at* half
 * is the node not refusing something the chain would take.
 *
 * Where a cap is enforced by a route rather than by a function, the row drives
 * the route. Where it is a pure function, the row calls it — no app, no
 * database, no stub, which is what makes thirteen of these cost one file.
 */

/** A body through the route validator, or the refusal the route would answer. */
function body(schema: TSchema, data: unknown): unknown {
  const validate = bodyAjv.compile(schema);
  if (!validate(data)) throw validationFailure(validate.errors ?? [], "body");
  return data;
}

/** A query string through the route validator, digits and all. */
function query(schema: TSchema, data: Record<string, string>): unknown {
  const validate = compileSchema({ schema: schema as never, httpPart: "querystring", method: "GET", url: "/" }) as (
    data: unknown,
  ) => { value?: unknown; error?: never[] };
  const result = validate({ ...data });
  if (result.error !== undefined) throw validationFailure(result.error, "querystring");
  return result.value;
}

const paging = (data: Record<string, string>) => query(Type.Object(Paging), data);
const probe = (slaSecs: number) => ({ model_id: 1, sla_secs: slaSecs, units_in: 1, units_out: 1 });

type Edge = {
  /** What is bounded, and where the bound is written. */
  bound: string;
  /** The value at the boundary. Must be accepted. */
  at: () => unknown;
  /** One past it. Must be refused. */
  past: () => unknown;
  /** How a refusal shows itself. */
  refusal?: RegExp;
};

const quotes = (n: number): unknown[] =>
  Array.from({ length: n }, () => ({ model_id: 1, sla: 60, rate_in: "0.000001", rate_out: "0.000001" }));
/** Stored, the rates are the atomic decimal strings the wire's USD converts to. */
const storedSnapshot = (count: number): string =>
  JSON.stringify({
    provider_id: "7",
    signed_at: "1",
    quotes: Array.from({ length: count }, () => ({ model_id: "1", sla: "60", rate_in: "1", rate_out: "1" })),
  });

const EDGES: readonly Edge[] = [
  {
    bound: "schemas.Uint32 — a chain id in a path or query is a uint32 (common.ts)",
    at: () => query(Type.Object({ provider_id: Uint32() }), { provider_id: UINT32_MAX.toString() }),
    past: () => query(Type.Object({ provider_id: Uint32() }), { provider_id: (UINT32_MAX + 1n).toString() }),
    refusal: /must be an integer in \[0, 4294967295\]/,
  },
  {
    bound: "params.integer — the declared [min, max], upper edge (params.ts)",
    at: () => integer(UINT64_MAX.toString(), "issued_at", 0n, UINT64_MAX),
    past: () => integer((UINT64_MAX + 1n).toString(), "issued_at", 0n, UINT64_MAX),
    refusal: /must be an integer in/,
  },
  {
    bound: "params.integer — the declared [min, max], lower edge (params.ts)",
    at: () => integer("1", "provider_id", 1n, UINT32_MAX),
    past: () => integer("0", "provider_id", 1n, UINT32_MAX),
    refusal: /must be an integer in/,
  },
  {
    bound: "paging.limit — PAGE_MAX_LIMIT (paging.ts)",
    at: () => paging({ limit: String(PAGE_MAX_LIMIT) }),
    past: () => paging({ limit: String(PAGE_MAX_LIMIT + 1) }),
    refusal: /limit must be an integer in/,
  },
  {
    bound: "paging.limit — the lower edge, where 0 is not a page",
    at: () => paging({ limit: "1" }),
    past: () => paging({ limit: "0" }),
    refusal: /limit must be an integer in/,
  },
  {
    bound: "paging.offset — PAGE_MAX_OFFSET (paging.ts)",
    at: () => paging({ offset: String(PAGE_MAX_OFFSET) }),
    past: () => paging({ offset: String(PAGE_MAX_OFFSET + 1) }),
    refusal: /offset must be an integer in/,
  },
  {
    bound: "orders.capOf — MAX_CAP, the largest amount the wire carries (orders.ts)",
    // `cap = ceil(rateIn*unitsIn / 1e6)`, so this lands exactly on MAX_CAP.
    at: () =>
      capOf({
        rateIn: MAX_CAP * 1_000_000n,
        unitsIn: 1n,
        rateOut: 0n,
        unitsOut: 0n,
      } as never),
    past: () =>
      capOf({
        rateIn: MAX_CAP * 1_000_000n + 1_000_000n,
        unitsIn: 1n,
        rateOut: 0n,
        unitsOut: 0n,
      } as never),
    refusal: /cap exceeds/,
  },
  {
    bound: "push.PushBody — MAX_QUOTES, the count the chain skips past (push.ts)",
    at: () => body(PushBody, pushBody(quotes(MAX_QUOTES))),
    past: () => body(PushBody, pushBody(quotes(MAX_QUOTES + 1))),
    refusal: /at most 64 quotes/,
  },
  {
    bound: "push.parseStoredSnapshot — the SAME bound, on the boot-sweep path (push.ts)",
    // The duplicated half. It was written out separately and only one of the two
    // was defended; they are one function now, and this row is why.
    at: () => parseStoredSnapshot(storedSnapshot(MAX_QUOTES)),
    past: () => parseStoredSnapshot(storedSnapshot(MAX_QUOTES + 1)),
    refusal: /at most 64 quotes/,
  },
  {
    bound: "orders.MAX_SLA_SECONDS — the market probe's sla, the one the chain will accept (post.ts)",
    // Read through the constant rather than a literal: the bound and the test
    // cannot disagree about what the number is, only about the comparison.
    at: () => body(MarketProbe, probe(Number(MAX_SLA_SECONDS))),
    past: () => body(MarketProbe, probe(Number(MAX_SLA_SECONDS) + 1)),
    refusal: /must be an integer in/,
  },
];

/** A `*` environment with every required variable present. */
function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://vorq:vorq@localhost:5433/vorq",
    RELAYER_KEY: `0x${"11".repeat(32)}`,
    ADDRESSES_FILE: fileURLToPath(new URL("./fixtures/addresses.json", import.meta.url)),
    // Required since pinning moved onto the request path of both write doors —
    // `loadConfig` refuses to start without the group (`test/config.test.ts`).
    PIN_S3_ENDPOINT: "https://pin.example.invalid",
    PIN_S3_KEY: "key-id",
    PIN_S3_SECRET: "secret-value",
    PIN_S3_BUCKET: "vorq-pins",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

/** The one session these tests hold, so `/evm/ops` reaches its parse at all. */
const SESSION = "vorq_sess_0123456789abcdef0123456789abcdef";

/**
 * A database that answers the session lookup and refuses everything else.
 *
 * Refusing the rest is the assertion: every bound below is checked while parsing,
 * before any projection read, so a query here would mean the parse had already
 * been passed.
 */
const refusingDb = (): Db =>
  ({
    query: (async (text: string, params?: readonly unknown[]) => {
      if (text.includes("FROM sessions")) {
        return {
          rows:
            params?.[0] === SESSION
              ? [
                  {
                    token: SESSION,
                    address: Buffer.alloc(20, 0x77),
                    role: "client",
                    provider_id: null,
                    expires_at: 4_102_444_800n,
                  },
                ]
              : [],
        };
      }
      throw new Error(`no query expected before the bound is checked: ${text}`);
    }) as unknown as Db["query"],
    tx: () => Promise.reject(new Error("no transaction expected")),
    migrate: () => Promise.reject(new Error("no migration expected")),
    close: async () => undefined,
  }) as unknown as Db;

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

/** A push body whose only interesting field is the quote count. */
function pushBody(list: unknown[]): unknown {
  return {
    snapshot: { provider_id: 7, signed_at: 1, quotes: list },
    signature: `0x${"11".repeat(65)}`,
  };
}

describe("every node-side cap is defended at its edge (R78)", () => {
  it.each(EDGES)("$bound", ({ at, past, refusal }) => {
    // At the bound: accepted. A cap that refuses its own boundary value refuses
    // something the chain accepts, which costs a caller a request it cannot fix.
    expect(() => at()).not.toThrow();

    // One past it: refused, and with the message that names the bound.
    expect(() => past()).toThrow(refusal ?? /./);
  });

  it("covers every cap the review's sweep left green", () => {
    // The list is the deliverable, not the count — but the count is what makes a
    // silently dropped row visible.
    // Ten, not twelve: the two `config.integer` rows moved into the generated
    // block at the foot of this file, which asserts the same property at every
    // declared variable rather than at `GETLOGS_CAP` alone.
    expect(EDGES).toHaveLength(10);
  });
});

/**
 * The four caps a **route** owns rather than a function, at their edges.
 *
 * Driven through the shipped app because that is where they live. Each is
 * checked during parsing, before any signature is recovered, so a placeholder
 * signature is enough to reach them — which is also why the accepted half lands
 * on a later refusal (`403`/`402`/`409`) rather than on a `201`: what is being
 * asserted is that the **length** was not the objection.
 */
describe("the route-level length caps, at their edges (R78)", () => {
  const app = (): FastifyInstance => {
    const config = testConfig();
    return buildApp({
      db: refusingDb(),
      indexer: stubIndexer(),
      config,
      chain: stubChain(config, {}).chain,
    });
  };

  const notAboutLength = (body: unknown, param: string): void => {
    const error = (body as { error?: { param?: string } }).error;
    expect(error?.param).not.toBe(param);
  };

  /**
   * The two doors' body limits, at the bound and one past it.
   *
   * These are `bodyLimit`s rather than field caps, so the refusal is Fastify's
   * `413` before the body is parsed, and the accepted half lands on a later
   * refusal — which is the point: what is asserted is that the **size** was not
   * the objection. Each door carries a cap on the *encoded* body and nothing
   * behind it, because a decoded cap applied after `JSON.parse` has already
   * spent the allocation it existed to prevent.
   *
   * Both doors read the one ceiling, so the bound and the test cannot disagree
   * about the number — only about the comparison.
   */
  const bodyLimits: readonly { door: string; url: string; bound: number; body: (pad: string) => unknown }[] = [
    {
      door: "POST /v1/jobs",
      url: "/v1/jobs",
      bound: MAX_BODY_BYTES,
      body: (pad) => ({ c: `0x${"0c".repeat(32)}`, padding: pad }),
    },
    {
      door: "POST /evm/ops",
      url: "/evm/ops",
      bound: MAX_BODY_BYTES,
      body: (pad) => ({ op: "claim", padding: pad }),
    },
  ];

  it.each(bodyLimits)("takes a body at $door's limit and 413s one past it", async ({ url, bound, body }) => {
    const server = app();
    // The JSON envelope around the padding, measured rather than guessed: the
    // "at" case has to land exactly on the bound, not near it.
    const envelope = JSON.stringify(body("")).length;
    const send = (pad: number) =>
      server.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${SESSION}`, "content-type": "application/json" },
        payload: JSON.stringify(body("x".repeat(pad))),
      });

    const at = await send(bound - envelope);
    const past = await send(bound - envelope + 1);

    expect(at.statusCode).not.toBe(413);
    expect(past.statusCode).toBe(413);
    // The frozen envelope, not a bare Fastify 413 and not a 500: a caller told
    // "internal error" for its own oversized body would retry it.
    expect(past.json().error.type).toBe("invalid_request_error");
    expect(past.headers["x-vorq-retryable"]).toBe("false");
    // Named, so a client can tell "your body is too large" from every other
    // refusal without matching on Fastify's English. This is the one 4xx a
    // client answers by uploading first and re-posting a cid, so it is the one
    // it most needs to recognise.
    expect(past.json().error.code).toBe("body_too_large");
    await server.close();
  });

  it("takes 32 768 bytes of evidence and refuses 32 769 (ops.ts)", async () => {
    const server = app();
    const op = (size: number) => ({
      op: "set_identity",
      box_key: `0x${"22".repeat(32)}`,
        evidence: `0x${"ab".repeat(size)}`,
        issued_at: Math.floor(Date.now() / 1000),
      signature: `0x${"11".repeat(65)}`,
    });

    const post = (size: number) =>
      server.inject({
        method: "POST",
        url: "/evm/ops",
        headers: { authorization: `Bearer ${SESSION}` },
        payload: op(size),
      });
    const at = await post(32_768);
    const past = await post(32_769);

    notAboutLength(at.json(), "evidence");
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toMatchObject({ param: "evidence" });
    await server.close();
  });

  it("takes a 128-character nonce and refuses 129 (auth.ts)", async () => {
    const server = app();
    const handshake = (size: number) => ({
      method: "POST" as const,
      url: "/auth/session",
      payload: {
        address: `0x${"cc".repeat(20)}`,
        nonce: "a".repeat(size),
        signature: `0x${"11".repeat(65)}`,
      },
    });

    // At the bound the nonce is looked up, which needs the database this app
    // refuses — so anything but a `400 param:"nonce"` proves the length passed.
    const at = await server.inject(handshake(128));
    const past = await server.inject(handshake(129));

    notAboutLength(at.json(), "nonce");
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toMatchObject({ param: "nonce" });
    await server.close();
  });
});

/** `capOf`'s overflow is its own error class, not a generic one. */
describe("the cap overflow keeps its own type", () => {
  it("throws CapOverflowError past MAX_CAP", () => {
    expect(() =>
      capOf({
        rateIn: MAX_CAP * 1_000_000n + 1_000_000n,
        unitsIn: 1n,
        rateOut: 0n,
        unitsOut: 0n,
      } as never),
    ).toThrow(CapOverflowError);
  });
});

/**
 * **R78, made structural for the one family of bounds where it can be.**
 *
 * The residual the Plan 2 re-review named is that `EDGES` above is *transcribed*:
 * a brand-new bound is defended only if somebody remembers to write a row, and a
 * new bound with a one-value hole left the whole suite green. That is
 * unavoidable for a cap enforced by a route, which has to be driven.
 *
 * It is entirely avoidable for `config.integer`, because every operator-settable
 * numeric in this node is a **declaration** — a row in `NUMERIC` carrying its own
 * `min` and `max`. So the table below is generated from that declaration, and a
 * new numeric env variable carries four assertions from the moment it is
 * declared, without anybody writing a test at all. The two hand-written
 * `config.integer` rows in `EDGES` were removed when this landed: they tested the
 * function at one variable, and this tests it at every one.
 *
 * **No count assertion here, deliberately.** A transcribed row count is the
 * ratchet this block exists to replace — it defends against a deleted row and
 * says nothing about a new one, which is the exact residual R78 named. The
 * generation covers additions on its own, and the added row is already visible in
 * the `src/config.ts` diff beside it.
 *
 * `ESCROW_MODE: "mock"` is in the base environment because the dev-only
 * offset is refused at any other mode by a guard that is not a range check —
 * the point here is the range, and the guard has its own tests in
 * `test/config.test.ts`.
 */
describe("every declared numeric env is defended at both of its edges (R78)", () => {
  const mockEnv = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
    env({ ESCROW_MODE: "mock", OPERATOR_KEY: `0x${"d4".repeat(32)}`, ...overrides });

  const declared: [string, { fallback: number; min: number; max: number }][] =
    Object.entries(NUMERIC);

  it.each(declared)("%s", (name, { min, max }) => {
    const range = new RegExp(`${name} must be an integer in \\[${min}, ${max}\\]`);

    // At each edge: accepted. A declared range that refuses its own boundary
    // value refuses a setting an operator read out of the documentation.
    expect(() => loadConfig(mockEnv({ [name]: String(min) }))).not.toThrow();
    expect(() => loadConfig(mockEnv({ [name]: String(max) }))).not.toThrow();

    // One past each edge: refused, with the message that names the range. For a
    // `min` of 0 that is "-1", which the digit pattern refuses before the
    // comparison does — the same message, and the same answer.
    expect(() => loadConfig(mockEnv({ [name]: String(min - 1) }))).toThrow(range);
    expect(() => loadConfig(mockEnv({ [name]: String(max + 1) }))).toThrow(range);
  });
});

/**
 * `HANDOVER_MAX_PAYLOAD_BYTES` — the largest sealed key set a joiner will accept.
 *
 * Added with the hosted escrow and never edge-tested. `HANDOVER_BODY_LIMIT_BYTES`
 * beside it *is* pinned (`test/handover.test.ts`), which is exactly the
 * pattern R78 is about: the bound next to the defended one, missed.
 *
 * Driven through `base64Bytes`, the function the join calls
 * (`src/escrow/handover.ts`), because that is where the bound is enforced —
 * reaching it through `POST /handover` would need evidence that verifies and
 * would be measuring the attestation path, not this cap.
 */
describe("the handover payload cap, at its edge (R78)", () => {
  // Base64 of `n` zero bytes. Both sizes are multiples of 3, so `decodedLength`
  // is exact and the encoding carries no padding to argue about.
  const payload = (size: number): string => Buffer.alloc(size).toString("base64");

  it("takes exactly HANDOVER_MAX_PAYLOAD_BYTES and refuses three bytes more", () => {
    expect(() =>
      base64Bytes(payload(HANDOVER_MAX_PAYLOAD_BYTES), "keys_sealed", HANDOVER_MAX_PAYLOAD_BYTES),
    ).not.toThrow();
    expect(() =>
      base64Bytes(
        payload(HANDOVER_MAX_PAYLOAD_BYTES + 3),
        "keys_sealed",
        HANDOVER_MAX_PAYLOAD_BYTES,
      ),
    ).toThrow(/keys_sealed must decode to at most 32768 bytes, and this is 32771/);
  });
});
