import type { FastifyInstance } from "fastify";
import { toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { openDb, type Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { sessionDomain } from "../src/api/routes/auth.js";
import {
  bareRevert,
  refusedCall,
  stubChain,
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

/** One held order, as `/evm/simulate/claim` reads it from this node's own row. */
interface HeldRowStub {
  owner: Buffer;
  c: Buffer;
  model_id: bigint;
  sla_secs: bigint;
  designated: bigint;
  rate_in: bigint;
  rate_out: bigint;
  units_in: bigint;
  units_out: bigint;
  expires_at: bigint;
  task_cid: Buffer;
  gas_fee: bigint;
  order_sig: Buffer;
}

const OWNER = `0x${"aa".repeat(20)}`;

/**
 * A held order whose lock is `cap + feeCap + gasFee` = 210 + 2 + 30 000 =
 * 30 212 atomic at 100 bps: cap `ceil((30 000·1000 + 90 000·2000) / 1e6)`.
 */
const heldRow = (overrides: Partial<HeldRowStub> = {}): HeldRowStub => ({
  owner: Buffer.from(OWNER.slice(2), "hex"),
  c: Buffer.alloc(32, 0xbb),
  model_id: 7n,
  sla_secs: 3600n,
  designated: 0n,
  rate_in: 30_000n,
  rate_out: 90_000n,
  units_in: 1000n,
  units_out: 2000n,
  expires_at: 4_102_444_800n,
  task_cid: Buffer.from("bafkreitaskcid", "utf8"),
  gas_fee: 30_000n,
  order_sig: Buffer.alloc(65, 0xab),
  ...overrides,
});

/**
 * The one read `/evm/simulate/claim` makes of this node's database: the held
 * order under the id, recorded so a test can count it. An unclaimed order exists
 * only here, so that is where its terms come from; every verdict on them is a
 * chain view read. Every other statement throws.
 */
const heldDb = (row: HeldRowStub | null = heldRow(), reads: unknown[][] = []): Db => ({
  query: ((text: string, params?: readonly unknown[]) => {
    if (text.includes("FROM jobs") && text.includes("order_sig IS NOT NULL")) {
      reads.push([...(params ?? [])]);
      return Promise.resolve({ rows: row === null ? [] : [row] });
    }
    return Promise.reject(new Error("this route reads the held order and nothing else"));
  }) as unknown as Db["query"],
  tx: () => Promise.reject(new Error("this route opens no transaction")),
  migrate: () => Promise.reject(new Error("this route runs no migration")),
  close: async () => undefined,
});

/** `getJob`'s return: found, id, state, cause, claimant and claim time. */
const jobView = (overrides: Record<string, unknown> = {}) => ({
  found: false,
  jobId: `0x${"00".repeat(32)}`,
  state: 0,
  endedBecause: 0,
  providerId: 0,
  claimedAt: 0n,
  ...overrides,
});

/** Every view the gate ladder reads, each answering "pass". */
const passing = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  allowedSla: true,
  modelExists: true,
  modelEnabled: true,
  getJob: jobView(),
  idOf: 5,
  isListed: true,
  modelAllowed: true,
  activeJobs: 1,
  effectiveCap: 8,
  gasFee: 30_000n,
  feeBps: 100,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Chain context, nonce, raw relay, advisory simulate — no database
// ---------------------------------------------------------------------------

describe("chain-backed routes", () => {
  let app: FastifyInstance | undefined;

  const build = (options: StubOptions = {}, row: HeldRowStub | null = heldRow()) => {
    const config = testConfig();
    const stub = stubChain(config, options);
    const reads: unknown[][] = [];
    app = buildApp({ db: heldDb(row, reads), indexer: stubIndexer(), config, chain: stub.chain });
    return { app, stub, config, reads };
  };

  const ask = (server: FastifyInstance, jobId = `0x${"01".repeat(32)}`) =>
    server.inject({
      method: "POST",
      url: "/evm/simulate/claim",
      payload: { job_id: jobId, address: `0x${"cc".repeat(20)}` },
    });

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

  it("answers NotOpen for an order this node does not hold, without a chain call", async () => {
    // Claimed already, cancelled, or never accepted: there is no order to claim.
    const { app: server, stub, reads } = build({ views: passing() }, null);

    const res = await ask(server);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: false, reason: "NotOpen" });
    expect(reads).toEqual([[Buffer.from("01".repeat(32), "hex")]]);
    expect(stub.requests.filter((r) => r.method === "eth_call")).toEqual([]);
  });

  it("answers ok when every gate passes, reading only the held order and chain views (R22)", async () => {
    const { app: server, stub, reads } = build({ views: passing() });

    const res = await ask(server);

    expect(res.json()).toEqual({ ok: true });
    // One database read — the held order — and chain `eth_call`s for every
    // verdict: the database this app was built with refuses anything else.
    expect(reads).toHaveLength(1);
    expect(stub.requests.every((r) => r.method === "eth_call")).toBe(true);
  });

  /**
   * The ladder in the contract's own order: the order's gates (`_admitOrder`),
   * then the provider's (`_admitProvider`), then the lock (`_lock`). Each case
   * fails exactly one gate, so the answer names the first one `claim` would
   * revert on, and not merely a reason it would fail.
   */
  it.each<[string, Record<string, unknown>, Partial<HeldRowStub>]>([
    ["SlaNotAllowed", { allowedSla: false }, {}],
    ["AlreadyExpired", {}, { expires_at: 1_000n }],
    ["UnknownModel", { modelExists: false }, {}],
    ["ModelDisabled", { modelEnabled: false }, {}],
    // An id the chain has a row for is spent: claimed through a relay this
    // node has not indexed yet, or cancelled on chain by its owner.
    ["NotOpen", { getJob: jobView({ found: true, state: 1 }) }, {}],
    ["UnknownProvider", { idOf: 0 }, {}],
    ["NotListed", { isListed: false }, {}],
    ["ModelNotAllowed", { modelAllowed: false }, {}],
    ["NotDesignated", {}, { designated: 9n }],
    // Both read from the chain (R21), never from the SQL pair `/evm/providers` computes.
    ["AtCapacity", { activeJobs: 8, effectiveCap: 8 }, {}],
    // `claim` locks the live gas fee; the client accepted the quoted one.
    ["GasFeeChanged", { gasFee: 30_001n }, {}],
    ["InsufficientDeposit", { balanceOf: 30_211n }, {}],
  ])("answers %s from its own gate", async (reason, views, row) => {
    const { app: server } = build({ views: passing(views) }, heldRow(row));
    expect((await ask(server)).json()).toEqual({ ok: false, reason });
  });

  it("passes a designated order for the designated provider", async () => {
    const { app: server } = build({ views: passing() }, heldRow({ designated: 5n }));
    expect((await ask(server)).json()).toEqual({ ok: true });
  });

  it("refuses an unregistered signer before any _rec-gated view", async () => {
    // `isListed`, `modelAllowed` and `effectiveCap` all revert UnknownProviderId
    // on id 0, so asking them first would turn a clean answer into a decode
    // failure. The stub has no view for them, so reaching one is a hard error.
    const { isListed: _l, modelAllowed: _m, effectiveCap: _e, activeJobs: _a, ...views } = passing({ idOf: 0 });
    const { app: server } = build({ views });

    expect((await ask(server)).json()).toEqual({ ok: false, reason: "UnknownProvider" });
  });

  /**
   * The lock, `cap + feeCap + gasFee` = 30 212 atomic, against
   * `JobRegistry.balanceOf(owner)`: one unit short is refused, exactly the lock
   * claims.
   */
  it("refuses InsufficientDeposit a unit under the lock, and ok at exactly the lock", async () => {
    const short = build({ views: passing(), tokenBalance: { [OWNER]: 30_211n } });
    expect((await ask(short.app)).json()).toEqual({ ok: false, reason: "InsufficientDeposit" });

    const exact = build({ views: passing(), tokenBalance: { [OWNER]: 30_212n } });
    expect((await ask(exact.app)).json()).toEqual({ ok: true });
  });

  /**
   * A batch's lines are claimed in a burst, one simulate per line. At one floor
   * block the owner balance, the fees and the provider gates are one read each,
   * however many lines ask; `getJob` is per job and stays per call. A new floor
   * reads again — the memo is exact per block, not a TTL.
   */
  it("reads the balance, the fees and the provider gates once per floor block across a claim burst", async () => {
    const { app: server, stub } = build({ views: passing() });
    const claim = (n: number) => ask(server, `0x${n.toString(16).padStart(64, "0")}`);
    const calls = (signature: string) => {
      const selector = toFunctionSelector(signature);
      return stub.requests.filter(
        (r) => r.method === "eth_call" && (r.params as [{ data: string }])[0].data.startsWith(selector),
      ).length;
    };

    stub.chain.saw(10n);
    const burst = await Promise.all([1, 2, 3, 4, 5].map(claim));
    expect(burst.map((r) => r.json())).toEqual(Array(5).fill({ ok: true }));
    expect(calls("getJob(bytes32)")).toBe(5);
    for (const gate of [
      "balanceOf(address)",
      "gasFee()",
      "feeBps()",
      "allowedSla(uint32)",
      "idOf(address)",
      "isListed(uint32)",
      "modelAllowed(uint32,uint32)",
      "activeJobs(uint32)",
      "effectiveCap(uint32)",
    ]) {
      expect(calls(gate), gate).toBe(1);
    }

    stub.chain.saw(11n);
    expect((await claim(6)).json()).toEqual({ ok: true });
    expect(calls("balanceOf(address)")).toBe(2);
    expect(calls("activeJobs(uint32)")).toBe(2);
  });

  /**
   * **R77 on the third door** — and it is the door a provider daemon hits most.
   *
   * Every gate here is a view read, so a dead endpoint, an RPC rate limit and a
   * reverting read must answer `503`, retryably, never `500` and never a
   * verdict. Deleting the `viewRead` wrapper in `ops.ts` turns all three of
   * these red.
   */
  it.each([
    ["a dead endpoint", () => unreachableEndpoint(), "chain_unreachable", null],
    ["an RPC rate limit", () => refusedCall("limit exceeded", -32005), "relay_unavailable", "rate_limited"],
    ["a reverting view read", () => bareRevert(), "relay_unavailable", "claim_simulate_read"],
  ])("503s %s on the advisory gate, never 500 and never a verdict (R77)", async (_name, callError, type, code) => {
    const { app: server } = build({ views: passing(), callError });

    const res = await ask(server);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ type, code, param: null });
    // The whole point: a daemon that reads this header keeps polling instead of
    // deciding the job is unclaimable forever.
    expect(res.headers["x-vorq-retryable"]).toBe("true");
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
