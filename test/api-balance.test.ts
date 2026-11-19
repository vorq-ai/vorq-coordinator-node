import type { FastifyInstance } from "fastify";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { buildApp } from "../src/api/app.js";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import {
  stubChain,
  testConfig,
  unreachableEndpoint,
  type Simulate,
  type StubChain,
  type StubOptions,
} from "./support/stub-chain.js";

/**
 * `GET /v1/balance`, `POST /v1/deposits` and `POST /v1/withdrawals` — the
 * prepaid balance.
 *
 * Driven against the canned endpoint and an in-memory store, so every assertion
 * is about what the node read and what it would have sent: "nothing was
 * relayed" is the absence of an `eth_sendRawTransaction`, and the calldata is
 * decoded back out of the signed transaction.
 */

const OWNER = getAddress(`0x${"66".repeat(20)}`);
const SESSION = "vorq_sess_0123456789abcdef0123456789abcdef";
const SIG = `0x${"ab".repeat(65)}` as Hex;
const NONCE = `0x${"5e".repeat(32)}` as Hex;

/** A held order of {@link OWNER}'s: cap 6000, so it locks 6000 + 60 (100 bps) + 10 000 gas fee. */
const HELD_LOCK = 6000n + 60n + 10_000n;

const stubIndexer = (): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async (): Promise<IndexerStatus> => ({ cursor: 9n, head: 9n, ready: true, forked: null }),
  start: async () => undefined,
  stop: async () => undefined,
});

/** Sessions, and the open-orders sum `openObligations` reads. */
function stubDb(held: number): Db {
  const query = (async (text: string, params?: readonly unknown[]) => {
    if (text.includes("FROM sessions")) {
      return {
        rows:
          params?.[0] === SESSION
            ? [
                {
                  token: SESSION,
                  address: Buffer.from(OWNER.slice(2), "hex"),
                  role: "client",
                  provider_id: null,
                  expires_at: 4_102_444_800n,
                },
              ]
            : [],
      };
    }
    if (text.includes("FROM jobs") && text.includes("order_sig IS NOT NULL")) {
      const owner = params?.[0] as Buffer;
      const mine = owner.equals(Buffer.from(OWNER.slice(2), "hex"));
      return {
        rows: mine
          ? Array.from({ length: held }, () => ({
              rate_in: "2000000",
              rate_out: "8000000",
              units_in: "1000",
              units_out: "500",
              gas_fee: "10000",
            }))
          : [],
      };
    }
    throw new Error(`stubDb: unexpected query ${text}`);
  }) as unknown as Db["query"];
  return {
    query,
    tx: (fn) => fn({ query }),
    migrate: () => Promise.reject(new Error("stubDb: no migration expected")),
    close: async () => undefined,
  };
}

interface Built {
  app: FastifyInstance;
  stub: StubChain;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(
  options: {
    balance?: bigint;
    held?: number;
    used?: () => boolean;
    simulate?: () => Simulate;
    chain?: Partial<StubOptions>;
    config?: Partial<Config>;
  } = {},
): Built {
  const config = testConfig(options.config);
  const stub = stubChain(config, {
    tokenBalance: { [OWNER.toLowerCase()]: options.balance ?? 50_000n },
    views: {
      feeBps: 100,
      gasFee: 10_000n,
      depositFee: 2_000n,
      authorizationState: () => options.used?.() ?? false,
    },
    simulate: options.simulate,
    ...options.chain,
  });
  app = buildApp({ db: stubDb(options.held ?? 0), indexer: stubIndexer(), config, chain: stub.chain });
  return { app, stub };
}

const auth = { authorization: `Bearer ${SESSION}` };

const depositBody = (overrides: Record<string, unknown> = {}) => ({
  owner: OWNER,
  value: "0.05",
  valid_before: Math.floor(Date.now() / 1000) + 3600,
  nonce: NONCE,
  auth_sig: SIG,
  ...overrides,
});

const withdrawBody = (overrides: Record<string, unknown> = {}) => ({
  owner: OWNER,
  amount: "0.01",
  issued_at: Math.floor(Date.now() / 1000),
  signature: SIG,
  ...overrides,
});

const decoded = (data: Hex) => decodeFunctionData({ abi: jobRegistryAbi, data });

describe("GET /v1/balance", () => {
  it("answers the chain's balance, the open orders' reservation and what is left", async () => {
    const { app, stub } = build({ balance: 50_000n, held: 2 });
    const res = await app.inject({ method: "GET", url: `/v1/balance?owner=${OWNER}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      owner: OWNER,
      balance: "0.05",
      reserved: "0.03212",
      available: "0.01788",
      deposit_fee: "0.002",
    });
    // The balance is the registry's, never the token's.
    const reads = stub.requests.filter((r) => r.method === "eth_call");
    const balanceRead = reads.find((r) => {
      const [call] = r.params as [{ to: Hex; data: Hex }];
      return call.data.startsWith("0x70a08231");
    });
    expect((balanceRead?.params as [{ to: Hex }])[0].to.toLowerCase()).toBe(
      testConfig().addresses.jobRegistry.toLowerCase(),
    );
    expect(2n * HELD_LOCK).toBe(32_120n);
  });

  it("floors available at 0 when the open orders reserve more than the balance", async () => {
    const { app } = build({ balance: 10_000n, held: 1 });
    const res = await app.inject({ method: "GET", url: `/v1/balance?owner=${OWNER}`, headers: auth });
    expect(res.json()).toMatchObject({ balance: "0.01", reserved: "0.01606", available: "0" });
  });

  it("refuses a caller with no session", async () => {
    const { app, stub } = build();
    const res = await app.inject({ method: "GET", url: `/v1/balance?owner=${OWNER}` });
    expect(res.statusCode).toBe(401);
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });

  it("answers 503 retryably when the balance cannot be read", async () => {
    const { app } = build({ chain: { callError: unreachableEndpoint } });
    const res = await app.inject({ method: "GET", url: `/v1/balance?owner=${OWNER}`, headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
  });
});

describe("POST /v1/deposits", () => {
  it("relays deposit(owner, value, validBefore, nonce, sig) from the relayer and answers the balance", async () => {
    const body = depositBody();
    const { app, stub } = build();
    const res = await app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: OWNER, balance: "0.05", deposit_fee: "0.002" });
    expect(stub.simulated).toHaveLength(1);
    expect(stub.simulatedFrom[0]?.toLowerCase()).toBe(stub.chain.account.address.toLowerCase());
    expect(stub.relayed).toHaveLength(1);
    const call = decoded(stub.relayed[0] as Hex);
    expect(call.functionName).toBe("deposit");
    expect(call.args).toEqual([OWNER, 50_000n, BigInt(body.valid_before), NONCE, SIG]);
  });

  it("answers the balance and relays nothing for an authorization already used", async () => {
    const { app, stub } = build({ used: () => true });
    const res = await app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: OWNER, available: "0.05" });
    expect(stub.simulated).toHaveLength(0);
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("answers the balance when the authorization landed between the read and the simulate", async () => {
    let reads = 0;
    const { app, stub } = build({
      used: () => (reads += 1) > 1,
      simulate: () => ({ kind: "opaque", data: "0x08c379a0" }),
    });
    const res = await app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    expect(res.statusCode).toBe(200);
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("409s the chain's refusal by name and relays nothing", async () => {
    const { app, stub } = build({ simulate: () => ({ kind: "revert", errorName: "BadDepositValue" }) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/deposits",
      headers: auth,
      payload: depositBody({ value: "0.002" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.headers["x-vorq-retryable"]).toBe("false");
    expect(res.json().error).toMatchObject({ type: "invalid_request_error", code: "BadDepositValue" });
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("refuses an owner carrying code before it simulates anything", async () => {
    const { app, stub } = build({ chain: { code: { [OWNER.toLowerCase()]: "0xef0100" } } });
    const res = await app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "payer_has_code", param: "owner" });
    expect(stub.simulated).toHaveLength(0);
  });

  it("503s an endpoint that answers nothing, retryably, and relays nothing", async () => {
    const { app, stub } = build({ chain: { callError: unreachableEndpoint } });
    const res = await app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    expect(res.statusCode).toBe(503);
    expect(res.headers["x-vorq-retryable"]).toBe("true");
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("refuses a value finer than the token's decimals", async () => {
    const { app, stub } = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/deposits",
      headers: auth,
      payload: depositBody({ value: "0.0000001" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe("value");
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });

  it("refuses a caller with no session", async () => {
    const { app, stub } = build();
    const res = await app.inject({ method: "POST", url: "/v1/deposits", payload: depositBody() });
    expect(res.statusCode).toBe(401);
    expect(stub.requests).toHaveLength(0);
  });

  it("counts relayed deposits against MONEY_RATE_LIMIT, and gives a refused one back", async () => {
    let refuse = true;
    const { app } = build({
      config: { moneyRateLimit: 1 },
      simulate: () => (refuse ? { kind: "revert", errorName: "BadDepositValue" } : { kind: "ok" }),
    });
    const send = () => app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    expect((await send()).statusCode).toBe(409);
    refuse = false;
    expect((await send()).statusCode).toBe(200);
    const third = await send();
    expect(third.statusCode).toBe(429);
    expect(third.json().error.type).toBe("rate_limit_exceeded");
  });
});

describe("POST /v1/withdrawals", () => {
  it("relays withdraw(owner, amount, issuedAt, sig) and answers the balance", async () => {
    const body = withdrawBody();
    const { app, stub } = build({ balance: 50_000n, held: 1 });
    const res = await app.inject({ method: "POST", url: "/v1/withdrawals", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: OWNER, reserved: "0.01606" });
    const call = decoded(stub.relayed[0] as Hex);
    expect(call.functionName).toBe("withdraw");
    expect(call.args).toEqual([OWNER, 10_000n, BigInt(body.issued_at), SIG]);
  });

  it("refuses more than available — the balance less what open orders reserve — and simulates nothing", async () => {
    // 50 000 held, 16 060 reserved: 33 940 available.
    const { app, stub } = build({ balance: 50_000n, held: 1 });
    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: auth,
      payload: withdrawBody({ amount: "0.033941" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "insufficient_balance", param: "amount" });
    expect(stub.simulated).toHaveLength(0);

    const exact = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: auth,
      payload: withdrawBody({ amount: "0.03394" }),
    });
    expect(exact.statusCode).toBe(200);
  });

  it("refuses an issued_at outside ±600 s as StaleOp, before any chain call", async () => {
    const { app, stub } = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: auth,
      payload: withdrawBody({ issued_at: Math.floor(Date.now() / 1000) - 601 }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("StaleOp");
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(0);
  });

  it("409s a signature the chain refuses, by the contract's own name", async () => {
    const { app, stub } = build({ simulate: () => ({ kind: "revert", errorName: "InvalidWithdrawSignature" }) });
    const res = await app.inject({ method: "POST", url: "/v1/withdrawals", headers: auth, payload: withdrawBody() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("InvalidWithdrawSignature");
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("counts withdrawals and deposits against one MONEY_RATE_LIMIT, apart from JOB_RATE_LIMIT", async () => {
    // JOB_RATE_LIMIT unlimited: the money limit is its own.
    const { app, stub } = build({ config: { moneyRateLimit: 2, jobRateLimit: 0 } });
    const deposit = () => app.inject({ method: "POST", url: "/v1/deposits", headers: auth, payload: depositBody() });
    const withdraw = () =>
      app.inject({ method: "POST", url: "/v1/withdrawals", headers: auth, payload: withdrawBody() });

    expect((await deposit()).statusCode).toBe(200);
    expect((await withdraw()).statusCode).toBe(200);
    const third = await withdraw();
    expect(third.statusCode).toBe(429);
    expect(third.json().error.type).toBe("rate_limit_exceeded");
    expect((await deposit()).statusCode).toBe(429);
    expect(stub.broadcasts).toHaveLength(2);
  });

  it("refuses a zero amount", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals",
      headers: auth,
      payload: withdrawBody({ amount: "0" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe("amount");
  });
});
