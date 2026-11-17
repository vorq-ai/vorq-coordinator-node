import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  stringToHex,
  type Abi,
  type AbiEvent,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { OPEN } from "../src/api/routes/jobs.js";
import type { Chain } from "../src/chain/client.js";
import type { Address } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import { cancelHeld, holdOrder, publishHeld, type HeldOrder } from "../src/match/held.js";
import { leaseOpenJobs } from "../src/match/lease.js";

/**
 * Held orders: a paid order no live ask clears is an open `jobs` row off chain,
 * and the provider poll that leases it posts it.
 *
 * Driven against the real projection, because the parts that can be wrong are
 * the SQL's: which rows a poll publishes, and what is left of a row and its
 * lease after each outcome of the `postMany`.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_held_test";

const JOB_REGISTRY: Address = "0x1111111111111111111111111111111111111111";
const OWNER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MODEL = 7n;
const EXPIRES = 4_102_444_800n;
const TASK_CID = "bafkreitaskcid";
const POSTED_BLOCK = 1000n;

const word = (fill: string): Hex => `0x${fill.repeat(32)}`;
const sig = (fill: string): Hex => `0x${fill.repeat(65)}`;
const bytes = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");

function scoped(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

const order = (fill: string, overrides: Partial<HeldOrder["terms"]> = {}): HeldOrder => ({
  jobId: word(fill),
  owner: OWNER,
  terms: {
    c: word(fill),
    modelId: MODEL,
    slaSecs: 3600n,
    rateIn: 30_000n,
    rateOut: 90_000n,
    unitsIn: 1000n,
    unitsOut: 2000n,
    designated: 0n,
    expiresAt: EXPIRES,
    ...overrides,
  },
  taskCid: TASK_CID,
  gasFee: 5n,
  orderSig: sig("0a"),
  authSig: sig("0b"),
});

/** Encodes one event off the vendored ABI: indexed members to topics, the rest to data. */
function eventLog(eventName: string, args: Record<string, unknown>): Log {
  const event = (jobRegistryAbi as Abi).find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  ) as AbiEvent;
  const body = event.inputs.filter((input) => !input.indexed);
  return {
    address: JOB_REGISTRY,
    topics: encodeEventTopics({ abi: jobRegistryAbi, eventName, args } as never) as [Hex, ...Hex[]],
    data: encodeAbiParameters(body, body.map((input) => args[input.name as string])),
    blockHash: word("bb"),
    blockNumber: POSTED_BLOCK,
    logIndex: 0,
    removed: false,
    transactionHash: word("cc"),
    transactionIndex: 0,
  };
}

const postedLog = (held: HeldOrder): Log =>
  eventLog("Posted", {
    jobId: held.jobId,
    modelId: Number(held.terms.modelId),
    designated: Number(held.terms.designated),
    owner: held.owner,
    c: held.terms.c,
    expiresAt: held.terms.expiresAt,
    slaSecs: Number(held.terms.slaSecs),
    rateIn: held.terms.rateIn,
    rateOut: held.terms.rateOut,
    unitsIn: Number(held.terms.unitsIn),
    unitsOut: Number(held.terms.unitsOut),
    gasFee: 30_000n,
    taskCid: stringToHex(held.taskCid),
  });

const skippedLog = (index: number, reason: Hex): Log =>
  eventLog("PostSkipped", { index: BigInt(index), reason });

/** The two calls `publishHeld` makes on the chain, recorded. */
function chainOf(logs: () => Log[], relayError?: Error, status: "success" | "reverted" = "success") {
  const relayed: { data: Hex; gas?: bigint }[] = [];
  const chain = {
    relay: async (request: { data: Hex; gas?: bigint }) => {
      if (relayError !== undefined) throw relayError;
      relayed.push(request);
      return word("cc");
    },
    receipt: async () => ({ logs: logs(), blockNumber: POSTED_BLOCK, status }) as unknown as TransactionReceipt,
  } as unknown as Chain;
  return { chain, relayed };
}

describe.skipIf(!TEST_DATABASE_URL)("held orders", () => {
  let db: Db;

  beforeAll(async () => {
    db = openDb(scoped(TEST_DATABASE_URL as string));
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["job_leases", "jobs"]) await db.query(`DELETE FROM ${table}`);
  });

  /** One provider poll's lease step, as the route issues it. */
  const lease = (providerId: bigint, free: bigint, extra = "", params: unknown[] = []) =>
    db.tx((tx) =>
      leaseOpenJobs(tx, {
        providerId,
        free,
        leaseMs: 20_000,
        filter: `${OPEN} AND model_id = $1${extra}`,
        params: [MODEL.toString(), ...params],
      }),
    );

  const publish = (chain: Chain | undefined, providerId = 1n) =>
    publishHeld({ db, chain, jobRegistry: JOB_REGISTRY }, providerId, MODEL);

  const row = async (held: HeldOrder) => {
    const { rows } = await db.query<{ state: number; posted_block: bigint; auth_sig: Buffer | null; order_sig: Buffer | null }>(
      "SELECT state, posted_block, auth_sig, order_sig FROM jobs WHERE job_id = $1",
      [bytes(held.jobId)],
    );
    return rows[0];
  };

  const leased = async (held: HeldOrder): Promise<boolean> => {
    const { rows } = await db.query("SELECT 1 FROM job_leases WHERE job_id = $1", [bytes(held.jobId)]);
    return rows.length === 1;
  };

  it("writes a held order as an open row carrying both signatures, once", async () => {
    const held = order("a1");

    expect(await holdOrder(db, held)).toBe(true);
    expect(await holdOrder(db, held)).toBe(false);

    expect(await row(held)).toEqual({
      state: 0,
      posted_block: 0n,
      order_sig: bytes(held.orderSig),
      auth_sig: bytes(held.authSig),
    });
  });

  it("posts the held orders a poll leased in one postMany and clears their signatures", async () => {
    const [first, second] = [order("a1"), order("a2")];
    await holdOrder(db, first);
    await holdOrder(db, second);
    expect(await lease(1n, 5n)).toBe(2);
    const { chain, relayed } = chainOf(() => [postedLog(first), postedLog(second)]);

    expect(await publish(chain)).toBe(2);

    expect(relayed).toHaveLength(1);
    const call = decodeFunctionData({ abi: jobRegistryAbi, data: relayed[0]!.data });
    expect(call.functionName).toBe("postMany");
    const [orders, owners, orderSigs, authSigs] = call.args as unknown as [
      { c: Hex; rateIn: bigint; taskCid: Hex }[], Address[], Hex[], Hex[],
    ];
    expect(orders.map((o) => o.c)).toEqual([first.terms.c, second.terms.c]);
    expect(orders[0]!.rateIn).toBe(first.terms.rateIn);
    expect(orders[0]!.taskCid).toBe(stringToHex(TASK_CID));
    expect(owners.map((o) => o.toLowerCase())).toEqual([OWNER, OWNER]);
    expect(orderSigs).toEqual([first.orderSig, second.orderSig]);
    expect(authSigs).toEqual([first.authSig, second.authSig]);

    for (const held of [first, second]) {
      expect(await row(held)).toEqual({ state: 0, posted_block: POSTED_BLOCK, order_sig: null, auth_sig: null });
      expect(await leased(held)).toBe(true);
    }
    // Nothing is held any more, so a second poll relays nothing.
    expect(await publish(chain)).toBe(0);
    expect(relayed).toHaveLength(1);
  });

  it("leaves a held order a provider's floor refuses unleased and unposted", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    const { chain, relayed } = chainOf(() => []);

    expect(await lease(1n, 5n, " AND rate_out >= $2", ["90001"])).toBe(0);
    expect(await publish(chain)).toBe(0);

    expect(relayed).toEqual([]);
    expect((await row(held))?.auth_sig).not.toBeNull();
  });

  it("publishes only the caller's own leases", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    await lease(2n, 5n);
    const { chain, relayed } = chainOf(() => [postedLog(held)]);

    expect(await publish(chain, 1n)).toBe(0);
    expect(relayed).toEqual([]);
  });

  it("deletes a held order the contract refused and keeps one it gave no verdict on", async () => {
    const [refused, undecided, landed] = [order("a1"), order("a2"), order("a3")];
    for (const held of [refused, undecided, landed]) await holdOrder(db, held);
    await lease(1n, 5n);
    const { chain } = chainOf(() => [skippedLog(0, "0x12345678"), skippedLog(1, "0x"), postedLog(landed)]);

    expect(await publish(chain)).toBe(1);

    expect(await row(refused)).toBeUndefined();
    expect(await leased(refused)).toBe(false);
    expect((await row(undecided))?.auth_sig).not.toBeNull();
    expect(await leased(undecided)).toBe(false);
    expect((await row(landed))?.auth_sig).toBeNull();
    expect(await leased(landed)).toBe(true);
  });

  it("keeps the row of an order the chain already has, and stops holding it", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    await lease(1n, 5n);
    const duplicate = encodeErrorResult({ abi: jobRegistryAbi, errorName: "DuplicateJob" });
    const { chain } = chainOf(() => [skippedLog(0, duplicate)]);

    expect(await publish(chain)).toBe(0);

    expect(await row(held)).toEqual({ state: 0, posted_block: 0n, order_sig: null, auth_sig: null });
    expect(await leased(held)).toBe(true);
  });

  it("treats a reverted postMany as nothing posted: leases dropped, rows still held", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    await lease(1n, 5n);
    const { chain } = chainOf(() => [], undefined, "reverted");

    await expect(publish(chain)).rejects.toThrow("reverted");

    expect(await leased(held)).toBe(false);
    expect((await row(held))?.auth_sig).not.toBeNull();
  });

  it("drops the leases on held orders past one transaction's worth", async () => {
    const all = Array.from({ length: 52 }, (_, n) => order((0x10 + n).toString(16)));
    for (const held of all) await holdOrder(db, held);
    expect(await lease(1n, 60n)).toBe(52);
    const posted: HeldOrder[] = [];
    const { chain, relayed } = chainOf(() => posted.map(postedLog));
    // The receipt answers for exactly the lines the call carried.
    const original = chain.relay;
    chain.relay = (async (request: { data: Hex }) => {
      const [orders] = decodeFunctionData({ abi: jobRegistryAbi, data: request.data }).args as unknown as [{ c: Hex }[]];
      posted.push(...orders.map((o) => all.find((held) => held.terms.c === o.c) as HeldOrder));
      return original(request as never);
    }) as never;

    expect(await publish(chain)).toBe(50);

    expect(relayed).toHaveLength(1);
    const stillLeased = (await Promise.all(all.map(leased))).filter(Boolean).length;
    expect(stillLeased).toBe(50);
    for (const held of all) {
      expect(await leased(held)).toBe((await row(held))?.auth_sig === null);
    }
  });

  it("cancels an unleased held order in its row, for its owner only", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    const seen: string[] = [];

    expect(await cancelHeld(db, held.jobId, async () => false)).toBe("not_owner");
    expect((await row(held))?.state).toBe(0);

    expect(await cancelHeld(db, held.jobId, async (owner) => (seen.push(owner), true))).toBe("cancelled");
    expect(seen).toEqual([OWNER]);
    expect(await row(held)).toEqual({ state: 3, posted_block: 0n, order_sig: null, auth_sig: null });
    // Cancelled, so no poll leases it.
    expect(await lease(1n, 5n)).toBe(0);
  });

  it("leaves a leased held order, and a job that is not held, to the chain's cancel", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    await lease(1n, 5n);

    expect(await cancelHeld(db, held.jobId, async () => true)).toBe("on_chain");
    expect((await row(held))?.state).toBe(0);
    expect(await cancelHeld(db, word("ee"), async () => true)).toBe("on_chain");
  });

  it("drops the leases and keeps the rows when the relay fails or there is no chain", async () => {
    const held = order("a1");
    await holdOrder(db, held);
    await lease(1n, 5n);

    await expect(publish(chainOf(() => [], new Error("rpc down")).chain)).rejects.toThrow("rpc down");
    expect(await leased(held)).toBe(false);
    expect((await row(held))?.auth_sig).not.toBeNull();

    await lease(1n, 5n);
    expect(await publish(undefined)).toBe(0);
    expect(await leased(held)).toBe(false);
    expect((await row(held))?.auth_sig).not.toBeNull();
  });
});
