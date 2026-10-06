import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { sessionDomain } from "../src/api/routes/auth.js";
import {
  bareRevert,
  refusedBroadcast,
  refusedCall,
  stubChain,
  stubTxHash,
  testConfig,
  unreachableEndpoint,
  type StubOptions,
} from "./support/stub-chain.js";

/**
 * The self-submission door and the handshake that guards the rest.
 *
 * Everything here talks to a canned JSON-RPC endpoint (`test/support/stub-chain.ts`),
 * so the suite reaches no chain — the Global Constraint that `npm test` is
 * network-free is about chain access, and a local Postgres is not that (R25).
 * The handshake half needs a database and takes `describe.skipIf`; the chain
 * half needs none and runs in every `npm test`.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_relay_test";

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

/**
 * A database no test in the chain half ever reaches, with exactly one exception:
 * the `DELETE` that `/evm/simulate/claim` issues to drop a job row the chain
 * does not have. R22 pins where this route's *answer* comes from, and that
 * statement contributes to no answer — so it is recorded rather than refused,
 * and every read still throws.
 */
const unreachableDb = (deletes: unknown[][] = []): Db => ({
  query: ((text: string, params?: readonly unknown[]) => {
    if (text.includes("DELETE FROM jobs")) {
      deletes.push([...(params ?? [])]);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.reject(new Error("this route must not read the index"));
  }) as unknown as Db["query"],
  tx: () => Promise.reject(new Error("this route must not read the index")),
  migrate: () => Promise.reject(new Error("this route must not read the index")),
  close: async () => undefined,
});

/** A complete `JobView`, in the ABI's 20-field decode order (R32). */
const jobView = (overrides: Record<string, unknown> = {}) => ({
  found: true,
  jobId: `0x${"01".repeat(32)}`,
  owner: `0x${"aa".repeat(20)}`,
  c: `0x${"bb".repeat(32)}`,
  state: 0,
  endedBecause: 0,
  providerId: 0,
  designated: 0,
  modelId: 7,
  rateIn: 30_000n,
  rateOut: 90_000n,
  unitsIn: 1000,
  unitsOut: 2000,
  completionTok: 0,
  slaSecs: 3600,
  expiresAt: 4_102_444_800n,
  claimedAt: 0n,
  taskCid: `0x${Buffer.from("bafkreitaskcid", "utf8").toString("hex")}`,
  resultCid: "0x",
  gasFee: 30_000n,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Chain context, nonce, raw relay, advisory simulate — no database
// ---------------------------------------------------------------------------

describe("chain-backed routes", () => {
  let app: FastifyInstance | undefined;

  const build = (options: StubOptions = {}) => {
    const config = testConfig();
    const stub = stubChain(config, options);
    const deletes: unknown[][] = [];
    app = buildApp({ db: unreachableDb(deletes), indexer: stubIndexer(), config, chain: stub.chain });
    return { app, stub, config, deletes };
  };

  afterAll(async () => {
    await app?.close();
  });

  it("serves the chain context, with the head resolved against the chain", async () => {
    const {
      app: server,
      stub,
      config,
    } = build({ latestBlock: 1000n, views: { feeBps: 100 } });

    const res = await server.inject({ method: "GET", url: "/evm/chain" });

    expect(res.statusCode).toBe(200);
    expect(res.json().fee_bps).toBe(100);
    expect(res.json()).toEqual({
      chain_id: 97,
      contracts: {
        job_registry: config.addresses.jobRegistry,
        provider_registry: config.addresses.providerRegistry,
        ask_registry: config.addresses.askRegistry,
        usdc: config.addresses.usdc,
      },
      // What a client renders an amount with, and what it signs a payment
      // authorization under. Both are the deployment's, never this node's.
      decimals: 6,
      token_domain: { name: "USDC", version: "2" },
      // The head the stub's chain reports, resolved on the call.
      head_block: 1000,
      block_time_ms: 60_000,
      // A JSON number, like every other basis-point value on this wire.
      fee_bps: 100,
    });
    // No `as_of_block` (R28): nothing here came from the index.
    expect(Object.keys(res.json())).not.toContain("as_of_block");
    // `fee_bps` came off a cell that is built once and kept, so a second caller
    // on this public door is answered from memory rather than buying another
    // `eth_call`. A `chainParams` rebuilt inside the handler makes this 2.
    const again = await server.inject({ method: "GET", url: "/evm/chain" });
    expect(again.json().fee_bps).toBe(100);
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
    // And it was resolved by asking the endpoint, on this request.
    expect(stub.requests.filter((r) => r.method === "eth_blockNumber")).toHaveLength(2);
  });

  // -- the advisory gate ----------------------------------------------------

  it("answers {ok:false, reason:'NotOpen'} from the view gates", async () => {
    // `getJob` renders an expired-but-open job as state 3 / cause 5 (R3), so one
    // comparison covers a resolved row and an abandoned one — exactly as
    // `claim`'s own `state != Open || now > expiresAt` does.
    const { app: server, stub } = build({ views: { getJob: jobView({ state: 3, endedBecause: 5 }) } });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: "NotOpen" });
    // Chain `eth_call`s only, no index reads (R22) — the database this app was
    // built with rejects every query, so a single read would have thrown.
    expect(stub.requests.every((r) => r.method === "eth_call")).toBe(true);
  });

  it("answers UnknownJob before it looks at any provider gate", async () => {
    const { app: server, stub } = build({ views: { getJob: jobView({ found: false }) } });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.json()).toEqual({ ok: false, reason: "UnknownJob" });
    // One call, and only one: the gates are ordered as the contract orders them,
    // so the answer is the reason `claim` *would* revert with and not merely a
    // reason it would fail.
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
  });

  /**
   * The repair that actually fires for an orphaned write-through row. The daemon
   * simulates before it signs and treats a refusal as a skip, so it never reaches
   * the `/evm/ops` door where `repairOnRefusal` lives — without this the phantom
   * is re-offered to every daemon until its own `expires_at`.
   */
  it("drops the job row when the chain has no such job, without a second call", async () => {
    const jobId = `0x${"01".repeat(32)}`;
    const { app: server, stub, deletes } = build({ views: { getJob: jobView({ found: false }) } });

    await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: jobId, address: `0x${"cc".repeat(20)}` },
    });

    expect(deletes).toEqual([[Buffer.from(jobId.slice(2), "hex")]]);
    // R22 holds: the repair costs no chain method, so the ladder is still the one
    // `getJob` this route is allowed.
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
    expect(stub.requests.every((r) => r.method === "eth_call")).toBe(true);
  });

  /** A repair is bolted to somebody else's request and may not break it. */
  it("still answers UnknownJob when the cleanup write fails", async () => {
    const config = testConfig();
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });
    const failing: Db = {
      query: () => Promise.reject(new Error("database down")),
      tx: () => Promise.reject(new Error("database down")),
      migrate: () => Promise.reject(new Error("database down")),
      close: async () => undefined,
    };
    const server = buildApp({ db: failing, indexer: stubIndexer(), config, chain: stub.chain });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: "UnknownJob" });
    await server.close();
  });

  it("walks the gate ladder in the contract's order down to AtCapacity (R21)", async () => {
    const { app: server } = build({
      views: {
        getJob: jobView(),
        idOf: 5,
        isListed: true,
        modelAllowed: true,
        // Both read from the chain, never from the SQL pair `/evm/providers`
        // computes for display.
        activeJobs: 8,
        effectiveCap: 8,
      },
    });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.json()).toEqual({ ok: false, reason: "AtCapacity" });
  });

  it("answers ok when every gate passes", async () => {
    const { app: server } = build({
      views: {
        getJob: jobView(),
        idOf: 5,
        isListed: true,
        modelAllowed: true,
        activeJobs: 1,
        effectiveCap: 8,
      },
    });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.json()).toEqual({ ok: true });
  });

  /**
   * **R77 on the third door** — and it is the door a provider daemon hits most.
   *
   * Every gate here is a view read. All six were bare `readContract`s, so a dead
   * endpoint, an RPC rate limit and a reverting read alike fell to the default
   * error handler and answered `500 internal_error` with
   * `x-vorq-retryable: false` — which under R57 promises the identical request
   * can never succeed, and stops being true the moment the endpoint answers
   * again. Deleting the `viewRead` wrapper in `ops.ts` turns all three of these
   * red.
   */
  it.each([
    ["a dead endpoint", () => unreachableEndpoint(), "chain_unreachable", null],
    ["an RPC rate limit", () => refusedCall("limit exceeded", -32005), "relay_unavailable", "rate_limited"],
    ["a reverting view read", () => bareRevert(), "relay_unavailable", "claim_simulate_read"],
  ])("503s %s on the advisory gate, never 500 and never a verdict (R77)", async (_name, callError, type, code) => {
    const { app: server } = build({ views: { getJob: jobView() }, callError });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type, code, param: null });
    // The whole point: a daemon that reads this header keeps polling instead of
    // deciding the job is unclaimable forever.
    expect(res.headers["x-vorq-retryable"]).toBe("true");
  });

  it("refuses an unregistered signer before any _rec-gated view", async () => {
    // `isListed`, `modelAllowed` and `effectiveCap` all revert UnknownProviderId
    // on id 0, so asking them first would turn a clean answer into a decode
    // failure. The stub has no view for them, so reaching one is a hard error.
    const { app: server } = build({ views: { getJob: jobView(), idOf: 0 } });

    const res = await server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: `0x${"01".repeat(32)}`, address: `0x${"cc".repeat(20)}` },
    });

    expect(res.json()).toEqual({ ok: false, reason: "UnknownProvider" });
  });
});

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe.skipIf(!TEST_DATABASE_URL)("session handshake", () => {
  let db: Db;
  let app: FastifyInstance;

  const SESSION_TYPES = {
    VorqSession: [
      { name: "address", type: "address" },
      { name: "nonce", type: "string" },
    ],
  } as const;

  /** Two throwaway scalars. Neither has ever held value on any chain. */
  const wallet = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const impostor = privateKeyToAccount(`0x${"33".repeat(32)}`);

  const signSession = (account: typeof wallet, address: string, nonce: string) =>
    account.signTypedData({
      domain: sessionDomain(testConfig().addresses.chainId),
      types: SESSION_TYPES,
      primaryType: "VorqSession",
      message: { address: address as `0x${string}`, nonce },
    });

  const getNonce = async (address: string): Promise<string> => {
    const res = await app.inject({ method: "GET", url: `/auth/nonce?address=${address}` });
    expect(res.statusCode).toBe(200);
    return res.json().nonce;
  };

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();

    const config = testConfig();
    const stub = stubChain(config, { views: { idOf: 0 } });
    app = buildApp({ db, indexer: stubIndexer(), config, chain: stub.chain });
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["sessions", "nonces", "providers"]) await db.query(`DELETE FROM ${table}`);
  });

  it("mints a nonce with a 300 s TTL and trades a signature for a session", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: "GET",
      url: `/auth/nonce?address=${wallet.address}`,
    });
    const { nonce, expires_at: expiresAt } = res.json();

    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    // A JSON **number**, like every integer on the wire.
    expect(typeof expiresAt).toBe("number");
    expect(expiresAt).toBeGreaterThanOrEqual(before + 300);
    expect(expiresAt).toBeLessThanOrEqual(before + 302);

    const session = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: {
        address: wallet.address,
        nonce,
        signature: await signSession(wallet, wallet.address, nonce),
      },
    });

    expect(session.statusCode).toBe(200);
    const body = session.json();
    expect(body.token).toMatch(/^vorq_sess_[0-9a-f]{32}$/);
    expect(typeof body.expires_at).toBe("number");
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 86_400);
    // A client session carries no `provider_id` at all — the emulator's shape,
    // and the provider SDK reads the field's *absence* as "not a provider".
    expect(body).not.toHaveProperty("provider_id");
  });

  it("burns the nonce, so a captured handshake cannot be replayed", async () => {
    const nonce = await getNonce(wallet.address);
    const signature = await signSession(wallet, wallet.address, nonce);
    const payload = { address: wallet.address, nonce, signature };

    expect((await app.inject({ method: "POST", url: "/auth/session", payload })).statusCode).toBe(
      200,
    );

    const replay = await app.inject({ method: "POST", url: "/auth/session", payload });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toMatchObject({
      type: "invalid_request_error",
      param: "nonce",
    });
  });

  it("burns the nonce even when the handshake goes on to fail", async () => {
    // The refusal below is a `403 not_registered`. If the nonce survived it, a
    // captured provider handshake could be re-sent as a *client* handshake for
    // the rest of its 300 s TTL — the same signature, a different role.
    const nonce = await getNonce(wallet.address);
    const signature = await signSession(wallet, wallet.address, nonce);

    const refused = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: { address: wallet.address, nonce, signature, role: "provider" },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: "not_registered" });

    const reused = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: { address: wallet.address, nonce, signature },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toMatchObject({ param: "nonce" });
  });

  it("refuses a signature produced by any other key", async () => {
    const nonce = await getNonce(wallet.address);

    const res = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: {
        address: wallet.address,
        nonce,
        // Signed over the claimed address by a wallet that does not own it.
        signature: await signSession(impostor, wallet.address, nonce),
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({
      type: "authentication_error",
      code: "invalid_signature",
    });
    // Nothing was minted.
    const { rows } = await db.query<{ count: bigint }>("SELECT count(*) AS count FROM sessions");
    expect(rows[0]?.count).toBe(0n);
  });

  it("refuses a nonce that was issued to a different address", async () => {
    const nonce = await getNonce(impostor.address);

    const res = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: {
        address: wallet.address,
        nonce,
        signature: await signSession(wallet, wallet.address, nonce),
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ type: "authentication_error" });
  });

  it("binds a provider session to the registry id from the projection (R14)", async () => {
    await db.query("INSERT INTO providers (provider_id, operator) VALUES ($1, $2)", [
      4_294_967_295n,
      Buffer.from(wallet.address.slice(2), "hex"),
    ]);
    const nonce = await getNonce(wallet.address);

    const res = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: {
        address: wallet.address,
        nonce,
        signature: await signSession(wallet, wallet.address, nonce),
        role: "provider",
      },
    });

    expect(res.statusCode).toBe(200);
    // A uint32 at its maximum, as a JSON **number**.
    expect(res.json().provider_id).toBe(4_294_967_295);
    expect(typeof res.json().provider_id).toBe("number");
    const { rows } = await db.query<{ role: string; provider_id: bigint }>(
      "SELECT role, provider_id FROM sessions",
    );
    expect(rows[0]).toEqual({ role: "provider", provider_id: 4_294_967_295n });
  });

  it("400s an unknown role rather than silently defaulting it to client", async () => {
    const nonce = await getNonce(wallet.address);
    const res = await app.inject({
      method: "POST",
      url: "/auth/session",
      payload: {
        address: wallet.address,
        nonce,
        signature: await signSession(wallet, wallet.address, nonce),
        role: "admin",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ param: "role" });
  });
});

/**
 * **C-1, provoked the way C provoked it: a real socket, a real Postgres, one
 * keypair.**
 *
 * `app.inject()` would have been enough to see the row count here, but R79(b)
 * says a limiter is proved on the wire, and the thing being disproved is a
 * measurement taken on the wire — *400 sessions accepted from ONE keypair at
 * 90/s with no refusal*. So this listens on a loopback port and drives `fetch`
 * at it, handshake after handshake, exactly as the measurement did.
 *
 * The assertion is not "the 33rd handshake fails" — it must not, a client is
 * entitled to a session — but that the **table** stops growing while the door
 * keeps working. That is the difference between a cap and a refusal.
 */
describe.skipIf(!TEST_DATABASE_URL)("the session table is bounded per address (R68, C-1)", () => {
  const SCHEMA = "vorq_session_cap_test";
  const wallet = privateKeyToAccount(`0x${"44".repeat(32)}`);
  let db: Db;
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${SCHEMA}`);
    await db.migrate();

    const config = testConfig();
    const stub = stubChain(config, { views: { idOf: 0 } });
    app = buildApp({ db, indexer: stubIndexer(), config, chain: stub.chain });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.close();
  });

  /** One complete handshake over the wire. Returns the HTTP status. */
  async function handshake(): Promise<number> {
    const minted = await fetch(`${base}/auth/nonce?address=${wallet.address}`);
    const { nonce, chain_id } = (await minted.json()) as { nonce: string; chain_id: number };
    const signature = await wallet.signTypedData({
      domain: sessionDomain(chain_id),
      types: { VorqSession: [{ name: "address", type: "address" }, { name: "nonce", type: "string" }] },
      primaryType: "VorqSession",
      message: { address: wallet.address, nonce },
    });
    const session = await fetch(`${base}/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: wallet.address, nonce, signature }),
    });
    return session.status;
  }

  it("holds one keypair to 32 live sessions however many it asks for", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push(await handshake());

    // Every one succeeded: the cap evicts this address's oldest, it does not
    // start refusing a caller that is using the API correctly.
    expect(new Set(statuses)).toEqual(new Set([200]));

    const { rows } = await db.query<{ count: bigint }>(
      "SELECT count(*) FROM sessions WHERE address = $1",
      [Buffer.from(wallet.address.slice(2), "hex")],
    );
    // Before the cap this was 40, and at C's measured 90/s it was 7.8 M rows a
    // day from one free keypair.
    expect(rows[0]?.count).toBe(32n);
  }, 30_000);
});
