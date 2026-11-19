import type { QueryResult, QueryResultRow } from "pg";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type AbiEvent,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import type { Queryable } from "../src/db/db.js";
import { openDb, type Db } from "../src/db/db.js";
import {
  RECONCILABLE_REVERTS,
  reconcileJob,
  repairOnRefusal,
  tryReconcileJob,
} from "../src/index/reconcile.js";
import { reduceRange } from "../src/index/reducer.js";
import { ADDRESSES, stubChain, testConfig } from "./support/stub-chain.js";

/**
 * Reconcile-on-error, update-only.
 *
 * `getJob` answers a job's status and claimant — found, state, cause, provider,
 * claim time — and nothing else, so a reconcile writes those onto a row that
 * exists and nothing more: it never inserts a row it could only half fill, and
 * it never deletes one (an order nobody claimed has no chain row by design).
 *
 * Two halves. The first drives `reconcileJob` over the stub chain and a
 * recording `Queryable`, which pins the *shape* of what is written. The second
 * is gated on `TEST_DATABASE_URL` (R25) and pins what that write does to a real
 * row, and that it agrees with a rebuild from logs.
 */

const config = testConfig();
const JOB_ID: Hex = `0x${"7a".repeat(32)}`;
const OWNER = `0x${"11".repeat(20)}`;
const C: Hex = `0x${"cc".repeat(32)}`;
/** The hash of whatever block a `reduceRange` here advances the cursor to. */
const BLOCK_HASH: Hex = `0x${"be".repeat(32)}`;
/** The gas fee the job was claimed under, in atomic units. */
const GAS_FEE = 30_000n;
const RELAYER = `0x${"cc".repeat(20)}`;

/** A `getJob` return, in the ABI's order. */
function jobView(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    jobId: JOB_ID,
    state: 1,
    endedBecause: 0,
    providerId: 9,
    claimedAt: 1_800_000_000n,
    ...overrides,
  };
}

/** A `Queryable` that records every statement and answers a canned `rowCount`. */
function recordingDb({ rowCount = 1 }: { rowCount?: number } = {}): Queryable & {
  statements: { text: string; params: unknown[] }[];
} {
  const statements: { text: string; params: unknown[] }[] = [];
  return {
    statements,
    query: async <R extends QueryResultRow>(text: string, params?: readonly unknown[]) => {
      statements.push({ text, params: [...(params ?? [])] });
      return { rows: [], rowCount, command: "", oid: 0, fields: [] } as unknown as QueryResult<R>;
    },
  };
}

function registryLog(eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): Log {
  const abi = jobRegistryAbi as Abi;
  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  )!;
  const body = event.inputs.filter((input) => !input.indexed);

  return {
    address: ADDRESSES.jobRegistry,
    blockHash: `0x${"bb".repeat(32)}`,
    blockNumber,
    data: encodeAbiParameters(
      body,
      body.map((input) => args[input.name as string]),
    ),
    logIndex,
    removed: false,
    topics: encodeEventTopics({ abi, eventName, args }) as [Hex, ...Hex[]],
    transactionHash: `0x${"cc".repeat(32)}`,
    transactionIndex: 0,
  };
}

/** The `Posted` and `Claimed` one `claim` emits, for the job `jobView()` describes. */
function claimLogs(view: ReturnType<typeof jobView>, blockNumber: bigint): Log[] {
  return [
    registryLog(
      "Posted",
      {
        jobId: view.jobId,
        modelId: 1,
        designated: 0,
        owner: OWNER,
        c: C,
        expiresAt: 1_900_000_000n,
        slaSecs: 3600,
        rateIn: 1000n,
        rateOut: 2000n,
        unitsIn: 10,
        unitsOut: 20,
        gasFee: GAS_FEE,
        taskCid: "0x616263",
      },
      blockNumber,
      0,
    ),
    registryLog(
      "Claimed",
      { jobId: view.jobId, provider: view.providerId, relayer: RELAYER, claimedAt: view.claimedAt },
      blockNumber,
      1,
    ),
  ];
}

describe("reconcileJob — shape, over the stub chain", () => {
  it("makes exactly one getJob call, pinned to latest, and stamps as_of_block with it", async () => {
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: jobView() } });
    const db = recordingDb();

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toEqual({ found: true, action: "updated", block: 4242n });
    expect(stub.requests.filter((r) => r.method === "eth_call")).toHaveLength(1);
    expect(stub.requests.some((r) => r.method === "eth_blockNumber")).toBe(true);
    // Pinned: the call names the block explicitly, so it cannot drift between the
    // stamp and the read.
    const [, blockTag] = stub.requests.find((r) => r.method === "eth_call")!.params as [
      unknown,
      string,
    ];
    expect(blockTag).toBe(`0x${(4242n).toString(16)}`);

    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].params[5]).toBe(4242n); // $6 as_of_block
  });

  /**
   * **Every reconcile reads the head itself; none reuses an earlier answer.**
   * viem caches `getBlockNumber` for `cacheTime`, which defaults to the polling
   * interval; `makeChain` sets it to 0 so a second reconcile inside one window
   * cannot pin its `getJob` to a block from before the window.
   */
  it("reads the head again on a second reconcile rather than reusing the first", async () => {
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: jobView() } });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);
    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(stub.requests.filter((r) => r.method === "eth_blockNumber")).toHaveLength(2);
  });

  it("updates the status columns only: never an insert, never a delete", async () => {
    const stub = stubChain(config, {
      views: { getJob: jobView({ state: 3, endedBecause: 4, providerId: 9, claimedAt: 77n }) },
    });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(db.statements).toHaveLength(1);
    const { text, params } = db.statements[0];
    expect(text).toMatch(/^\s*UPDATE jobs SET/);
    expect(text).not.toMatch(/INSERT|DELETE/);
    // Exactly the four the view carries, plus the stamp — nothing `Posted`
    // announces (terms, owner, CIDs, posted_block) is written from a view.
    const assigned = [...text.matchAll(/(\w+)\s*=/g)].map((m) => m[1]).filter((c) => c !== "job_id");
    expect(assigned.sort()).toEqual(
      ["as_of_block", "claimed_at", "ended_because", "provider_id", "state"].sort(),
    );
    expect(text).toMatch(/as_of_block = GREATEST\(as_of_block, \$6\)/);
    expect(params.slice(0, 5)).toEqual([Buffer.from(JOB_ID.slice(2), "hex"), 3, 4, 9, 77n]);
  });

  it("reports `absent` when no row took the write", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });

    const outcome = await reconcileJob(stub.chain, recordingDb({ rowCount: 0 }), JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome.action).toBe("absent");
  });

  it("writes nothing at all when the chain has no row for the job", async () => {
    // An order nobody has claimed lives in this node's database by design: the
    // chain's silence about it is not a reason to delete it.
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });
    const db = recordingDb();

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toEqual({ found: false, action: "absent", block: 1000n });
    expect(db.statements).toEqual([]);
  });

  it("hands a chain failure to the caller, and tryReconcileJob swallows it", async () => {
    const stub = stubChain(config, { callError: () => new Error("endpoint down") });

    await expect(
      reconcileJob(stub.chain, recordingDb(), JOB_ID, ADDRESSES.jobRegistry),
    ).rejects.toThrow();

    const reported: unknown[] = [];
    const outcome = await tryReconcileJob(
      stub.chain,
      recordingDb(),
      JOB_ID,
      ADDRESSES.jobRegistry,
      (error) => reported.push(error),
    );
    expect(outcome).toBeNull();
    expect(reported).toHaveLength(1);
  });
});

describe("repairOnRefusal — which reverts mean the index is stale", () => {
  /**
   * The set is the rule (R67). Widening it would turn every refusal into an RPC
   * amplifier that repairs nothing; narrowing it silently removes the repair.
   */
  it("reconciles on NotOpen and NotClaimed, and on nothing else", async () => {
    expect([...RECONCILABLE_REVERTS].sort()).toEqual(["NotClaimed", "NotOpen"]);

    for (const reason of ["NotOpen", "NotClaimed"]) {
      const stub = stubChain(config, { views: { getJob: jobView() } });
      const db = recordingDb();
      await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)(reason);
      expect(db.statements, reason).toHaveLength(1);
    }

    for (const reason of [
      "AtCapacity",
      "StaleOp",
      "InsufficientDeposit",
      "TermsMismatch",
      "unknown",
      "NotDesignated",
    ]) {
      const stub = stubChain(config, { views: { getJob: jobView() } });
      const db = recordingDb();
      await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)(reason);
      expect(db.statements, reason).toHaveLength(0);
      expect(stub.requests, reason).toHaveLength(0);
    }
  });

  it("does nothing for an op that names no job, or with no chain", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });
    const db = recordingDb();

    await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(null)("NotOpen");
    expect(stub.requests).toHaveLength(0);

    await repairOnRefusal(undefined, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)("NotOpen");
    expect(db.statements).toHaveLength(0);
  });

  it("hands a failed repair to the report and answers nothing different", async () => {
    const stub = stubChain(config, { callError: () => new Error("endpoint down") });
    const reported: string[] = [];

    await repairOnRefusal(stub.chain, recordingDb(), ADDRESSES.jobRegistry, (_e, jobId, reason) =>
      reported.push(`${jobId}:${reason}`),
    )(JOB_ID)("NotOpen");

    expect(reported).toEqual([`${JOB_ID}:NotOpen`]);
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres (R25)
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_reconcile_test";

function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("reconcileJob — against Postgres", () => {
  let db: Db;
  let admin: Db;

  beforeAll(async () => {
    admin = openDb(TEST_DATABASE_URL!);
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    db = openDb(scopedToTestSchema(TEST_DATABASE_URL!));
    await db.migrate();
  });

  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM jobs");
    await db.query("DELETE FROM cursor");
  });

  const key = Buffer.from(JOB_ID.slice(2), "hex");
  const ORDER_SIG = Buffer.alloc(65, 0x0a);

  /** The whole row, whichever writer produced it. */
  async function jobRow(): Promise<Record<string, unknown>> {
    const { rows } = await db.query("SELECT * FROM jobs WHERE job_id = $1", [key]);
    expect(rows).toHaveLength(1);
    return rows[0] as Record<string, unknown>;
  }

  /** The held order `jobView()` is the claim of: open, carrying its signature. */
  async function seedHeld(asOfBlock = 100n): Promise<void> {
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, task_cid, posted_block, as_of_block,
                         gas_fee, order_sig)
       VALUES ($1, $2, $3, 1, 3600, 0, '1000', '2000', 10, 20, 1900000000, '\\x616263', 77, $4, $5, $6)`,
      [key, Buffer.from(OWNER.slice(2), "hex"), Buffer.from(C.slice(2), "hex"), asOfBlock, GAS_FEE, ORDER_SIG],
    );
  }

  it("writes the claim the chain reports onto a held order, and touches nothing else", async () => {
    await seedHeld();
    const before = await jobRow();
    const stub = stubChain(config, { latestBlock: 900n, views: { getJob: jobView() } });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toEqual({ found: true, action: "updated", block: 900n });
    expect(await jobRow()).toEqual({
      ...before,
      state: 1,
      ended_because: 0,
      provider_id: 9n,
      claimed_at: 1_800_000_000n,
      as_of_block: 900n,
    });
  });

  it("writes an ending the chain reports", async () => {
    await seedHeld();
    const stub = stubChain(config, {
      latestBlock: 900n,
      views: { getJob: jobView({ state: 3, endedBecause: 4 }) },
    });

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    const row = await jobRow();
    expect([row.state, row.ended_because]).toEqual([3, 4]);
  });

  it("never walks as_of_block backwards", async () => {
    await seedHeld(5000n);
    const stub = stubChain(config, { latestBlock: 100n, views: { getJob: jobView() } });

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect((await jobRow()).as_of_block).toBe(5000n);
  });

  it("keeps the relayer the indexed Claimed wrote, which getJob does not report", async () => {
    await seedHeld();
    const relayer = Buffer.from(RELAYER.slice(2), "hex");
    await db.query("UPDATE jobs SET relayer = $2 WHERE job_id = $1", [key, relayer]);
    const stub = stubChain(config, {
      latestBlock: 900n,
      views: { getJob: jobView({ state: 3, endedBecause: 4 }) },
    });

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect((await jobRow()).relayer).toEqual(relayer);
  });

  it("creates no row for a job it has none for", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome.action).toBe("absent");
    const { rows } = await db.query("SELECT 1 FROM jobs");
    expect(rows).toEqual([]);
  });

  it("deletes nothing when the chain has no row: neither a held order nor any other", async () => {
    await seedHeld();
    await db.query("UPDATE jobs SET order_sig = NULL WHERE job_id = $1", [key]);
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });

    expect((await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry)).action).toBe("absent");
    expect((await jobRow()).state).toBe(0);
  });

  it("agrees with a rebuild from the claim's logs on every column it writes", async () => {
    const view = jobView();
    await seedHeld();
    const stub = stubChain(config, { latestBlock: 500n, views: { getJob: view } });
    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);
    const reconciled = await jobRow();

    await db.query("DELETE FROM jobs");
    await seedHeld();
    await reduceRange(db, claimLogs(view, 500n), 500n, BLOCK_HASH);
    const rebuilt = await jobRow();

    for (const column of ["state", "ended_because", "provider_id", "claimed_at", "as_of_block"]) {
      expect(reconciled[column], column).toEqual(rebuilt[column]);
    }
  });
});
