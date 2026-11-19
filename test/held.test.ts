import {
  encodeAbiParameters,
  encodeEventTopics,
  stringToHex,
  type Abi,
  type AbiEvent,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { OPEN } from "../src/api/routes/jobs.js";
import type { Address } from "../src/config.js";
import { openDb, type Db } from "../src/db/db.js";
import { decodeLog } from "../src/index/decode.js";
import { applyEvent } from "../src/index/reducer.js";
import {
  cancelHeld,
  dropLease,
  HELD,
  holdOrder,
  takeForClaim,
  type HeldOrder,
} from "../src/match/held.js";
import { leaseOpenJobs } from "../src/match/lease.js";

/**
 * Held orders: every accepted order is an open `jobs` row off chain, carrying
 * the order signature `claim` takes, until a provider's claim puts it on chain.
 *
 * Driven against the real projection, because the parts that can be wrong are
 * the SQL's: what the row carries, which rows a claim may take, what a cancel
 * may end, and how the two exclude each other through the row lock and the
 * lease.
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
const CURSOR = 4242n;
const POSTED_BLOCK = 5000n;

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
    for (const table of ["job_leases", "jobs", "cursor"]) await db.query(`DELETE FROM ${table}`);
    await db.query(
      `INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, '0x${"be".repeat(32)}')`,
      [CURSOR],
    );
  });

  /** One provider poll's lease step, as the route issues it. */
  const lease = (providerId: bigint, free: bigint) =>
    db.tx((tx) =>
      leaseOpenJobs(tx, {
        providerId,
        free,
        leaseMs: 20_000,
        filter: `${OPEN} AND model_id = $1`,
        params: [MODEL.toString()],
      }),
    );

  const row = async (held: HeldOrder) => {
    const { rows } = await db.query<{
      state: number;
      ended_because: number;
      posted_block: bigint;
      order_sig: Buffer | null;
      gas_fee: bigint;
    }>(
      "SELECT state, ended_because, posted_block, order_sig, gas_fee FROM jobs WHERE job_id = $1",
      [bytes(held.jobId)],
    );
    return rows[0];
  };

  const leaseOf = async (held: HeldOrder) => {
    const { rows } = await db.query<{ provider_id: bigint; live: boolean; ms: number }>(
      `SELECT provider_id, expires_at > now() AS live,
              (extract(epoch from (expires_at - now())) * 1000)::float8 AS ms
         FROM job_leases WHERE job_id = $1`,
      [bytes(held.jobId)],
    );
    return rows[0];
  };

  const yes = async () => true;
  const no = async () => false;

  it("writes an accepted order as an open row carrying its signature, once", async () => {
    const held = order("a1");

    expect(await holdOrder(db, held)).toBe(true);
    expect(await holdOrder(db, held)).toBe(false);

    // `posted_block` is the cursor at acceptance: the book's age filter, its
    // lease order and the orphan clause read an open order by it.
    expect(await row(held)).toEqual({
      state: 0,
      ended_because: 0,
      posted_block: CURSOR,
      order_sig: bytes(held.orderSig),
      gas_fee: 5n,
    });
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'jobs'`,
      [TEST_SCHEMA],
    );
    expect(columns.rows.map((c) => c.column_name)).not.toContain("auth_sig");
  });

  it("reads 0 for an order accepted before anything was indexed", async () => {
    await db.query("DELETE FROM cursor");
    const held = order("a1");
    await holdOrder(db, held);
    expect((await row(held))?.posted_block).toBe(0n);
  });

  it("marks a held order by its order signature alone", () => {
    expect(HELD).toBe("order_sig IS NOT NULL");
  });

  it("stops holding an order once the claim's Posted is indexed, and keeps the row", async () => {
    const held = order("a1");
    await holdOrder(db, held);

    const event = decodeLog(postedLog(held));
    if (event === null) throw new Error("Posted did not decode");
    await applyEvent(db, event, POSTED_BLOCK);

    // The chain's own block and gas fee win; the signature is cleared.
    expect(await row(held)).toEqual({
      state: 0,
      ended_because: 0,
      posted_block: POSTED_BLOCK,
      order_sig: null,
      gas_fee: 30_000n,
    });
  });

  describe("takeForClaim", () => {
    it("answers the order as claim takes it, and leases it to the claimant over anyone's poll", async () => {
      const held = order("a1", { designated: 3n });
      await holdOrder(db, held);
      expect(await lease(2n, 5n)).toBe(0); // designated to 3: provider 2 is never offered it
      expect(await lease(3n, 5n)).toBe(1);

      const taken = await takeForClaim(db, held.jobId, 3n, 120_000);

      expect(taken).toEqual({
        owner: OWNER,
        terms: held.terms,
        taskCid: TASK_CID,
        gasFee: 5n,
        orderSig: held.orderSig,
      });
      const claimLease = await leaseOf(held);
      expect(claimLease?.provider_id).toBe(3n);
      // Held for the claim's whole relay, past a poll's 20 s.
      expect(claimLease?.ms).toBeGreaterThan(100_000);
    });

    it("takes the lease from another provider's poll", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      expect(await lease(2n, 5n)).toBe(1);

      expect(await takeForClaim(db, held.jobId, 3n, 120_000)).not.toBeNull();
      expect((await leaseOf(held))?.provider_id).toBe(3n);
    });

    it("never shortens a lease already longer than the hold", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await takeForClaim(db, held.jobId, 3n, 120_000);
      await takeForClaim(db, held.jobId, 3n, 1_000);
      expect((await leaseOf(held))?.ms).toBeGreaterThan(100_000);
    });

    it("answers null for no order, a cancelled order and an order the chain already has", async () => {
      const [cancelled, onChain] = [order("a2"), order("a3")];
      await holdOrder(db, cancelled);
      await holdOrder(db, onChain);
      expect(await cancelHeld(db, cancelled.jobId, yes, no)).toBe("cancelled");
      await db.query("UPDATE jobs SET order_sig = NULL, state = 1 WHERE job_id = $1", [bytes(onChain.jobId)]);

      expect(await takeForClaim(db, word("ee"), 3n, 120_000)).toBeNull();
      expect(await takeForClaim(db, cancelled.jobId, 3n, 120_000)).toBeNull();
      expect(await takeForClaim(db, onChain.jobId, 3n, 120_000)).toBeNull();
      // And nothing was leased for any of them.
      const { rows } = await db.query("SELECT 1 FROM job_leases");
      expect(rows).toEqual([]);
    });

    it("gives the lease back with dropLease, the claimant's own only", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await takeForClaim(db, held.jobId, 3n, 120_000);

      await dropLease(db, held.jobId, 2n);
      expect(await leaseOf(held)).toBeDefined();
      await dropLease(db, held.jobId, 3n);
      expect(await leaseOf(held)).toBeUndefined();
      // The order is still open, and the next poller takes it.
      expect(await lease(2n, 5n)).toBe(1);
    });
  });

  describe("cancelHeld", () => {
    it("ends an unleased open order in its row, for its owner only, and keeps its signature", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      const seen: string[] = [];

      expect(await cancelHeld(db, held.jobId, no, yes)).toBe("not_owner");
      expect((await row(held))?.state).toBe(0);

      expect(await cancelHeld(db, held.jobId, async (owner) => (seen.push(owner), true), no)).toBe(
        "cancelled",
      );
      expect(seen).toEqual([OWNER]);
      // The signature stays: no chain event will ever describe this
      // cancellation, so the row stays this node's own — and survives a rebuild.
      expect(await row(held)).toEqual({
        state: 3,
        ended_because: 2,
        posted_block: CURSOR,
        order_sig: bytes(held.orderSig),
        gas_fee: 5n,
      });
      // Cancelled, so no poll leases it, no claim takes it, and a second cancel
      // finds nothing open.
      expect(await lease(1n, 5n)).toBe(0);
      expect(await takeForClaim(db, held.jobId, 1n, 120_000)).toBeNull();
      expect(await cancelHeld(db, held.jobId, yes, no)).toBe("not_open");
    });

    it("answers unknown for an id it holds no row for", async () => {
      expect(await cancelHeld(db, word("ee"), yes, no)).toBe("unknown");
    });

    it("answers not_open for a job the chain already has", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await db.query("UPDATE jobs SET order_sig = NULL, state = 1 WHERE job_id = $1", [bytes(held.jobId)]);

      expect(await cancelHeld(db, held.jobId, yes, no)).toBe("not_open");
      expect((await row(held))?.state).toBe(1);
    });

    it("refuses a leased order and leaves it untouched, without asking the chain", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await lease(1n, 5n);
      let asked = false;

      expect(await cancelHeld(db, held.jobId, yes, async () => ((asked = true), false))).toBe("leased");
      expect(asked).toBe(false);
      expect((await row(held))?.state).toBe(0);
    });

    it("refuses an order whose claim is in flight", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await takeForClaim(db, held.jobId, 3n, 120_000);

      expect(await cancelHeld(db, held.jobId, yes, no)).toBe("leased");
      expect((await row(held))?.state).toBe(0);
    });

    it("refuses an order the chain has a row for once its lease has lapsed", async () => {
      // A claim whose relay outlived its lease: the chain has the job, the index
      // does not yet. The row is not ended under it.
      const held = order("a1");
      await holdOrder(db, held);
      await db.query(
        "INSERT INTO job_leases (job_id, provider_id, offered_at, expires_at) VALUES ($1, 3, now(), now() - interval '1 second')",
        [bytes(held.jobId)],
      );

      expect(await cancelHeld(db, held.jobId, yes, yes)).toBe("not_open");
      expect((await row(held))?.state).toBe(0);
    });

    it("drops a lapsed lease with the order it cancels", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      await db.query(
        "INSERT INTO job_leases (job_id, provider_id, offered_at, expires_at) VALUES ($1, 3, now(), now() - interval '1 second')",
        [bytes(held.jobId)],
      );

      expect(await cancelHeld(db, held.jobId, yes, no)).toBe("cancelled");
      expect(await leaseOf(held)).toBeUndefined();
    });

    it("waits on a claim holding the row lock, then sees its lease", async () => {
      const held = order("a1");
      await holdOrder(db, held);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));

      // A claim's transaction, paused after it locked the row and wrote its lease.
      const claim = db.tx(async (tx) => {
        await tx.query("SELECT 1 FROM jobs WHERE job_id = $1 FOR UPDATE", [bytes(held.jobId)]);
        await tx.query(
          "INSERT INTO job_leases (job_id, provider_id, offered_at, expires_at) VALUES ($1, 3, now(), now() + interval '2 minutes')",
          [bytes(held.jobId)],
        );
        await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancel = cancelHeld(db, held.jobId, yes, no);
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await claim;

      expect(await cancel).toBe("leased");
      expect((await row(held))?.state).toBe(0);
    });
  });
});
