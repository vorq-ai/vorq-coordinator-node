import type { QueryResult, QueryResultRow } from "pg";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type AbiEvent,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import type { Queryable } from "../src/db/db.js";
import { openDb, type Db } from "../src/db/db.js";
import {
  RECONCILABLE_REVERTS,
  reconcileJob,
  repairOnRefusal,
  storedState,
  tryReconcileJob,
} from "../src/index/reconcile.js";
import { reduceRange } from "../src/index/reducer.js";
import { ADDRESSES, stubChain, testConfig } from "./support/stub-chain.js";

/**
 * Reconcile-on-error.
 *
 * Two halves, and the split is the same one `db.test.ts` makes. The first needs
 * no database: it drives `reconcileJob` over the stub chain and a recording
 * `Queryable`, which is where the *shape* of what is written is pinned — one
 * `getJob`, pinned to a block, an upsert that carries every NOT NULL column and
 * never `posted_block` (R4a), `GREATEST` on
 * `as_of_block`. The second is gated on `TEST_DATABASE_URL` (R25) and is where the
 * `state 3 / cause 5 → 0/0` mapping is proved against the constraint that
 * actually enforces it: R43 bounds `ended_because` at 4 precisely so a forgotten
 * mapping is a write-time error, and only a real Postgres has that CHECK.
 */

const config = testConfig();
const JOB_ID: Hex = `0x${"7a".repeat(32)}`;
const OWNER = `0x${"11".repeat(20)}`;
const C: Hex = `0x${"cc".repeat(32)}`;
/** The hash of whatever block a `reduceRange` here advances the cursor to. */
const BLOCK_HASH: Hex = `0x${"be".repeat(32)}`;
/** The gas fee the job was posted under, in atomic units. */
const GAS_FEE = 30_000n;

/** A `getJob` return, in the ABI's 20-field order (R32). */
function jobView(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    jobId: JOB_ID,
    owner: OWNER,
    c: C,
    state: 0,
    endedBecause: 0,
    providerId: 0,
    designated: 0,
    modelId: 1,
    rateIn: 1000n,
    rateOut: 2000n,
    unitsIn: 10,
    unitsOut: 20,
    completionTok: 0,
    slaSecs: 3600,
    expiresAt: 1_900_000_000n,
    claimedAt: 0n,
    taskCid: "0x616263" as Hex,
    resultCid: "0x" as Hex,
    gasFee: GAS_FEE,
    ...overrides,
  };
}

/**
 * A `Queryable` that records every statement and answers canned results.
 *
 * `rowCount` is what the DELETE path reads; `inserted` is the `xmax = 0` flag the
 * upsert path reads. Both are settable because the two branches ask the database
 * different questions.
 */
function recordingDb({
  rowCount = 1,
  inserted = false,
}: { rowCount?: number; inserted?: boolean } = {}): Queryable & {
  statements: { text: string; params: unknown[] }[];
} {
  const statements: { text: string; params: unknown[] }[] = [];
  return {
    statements,
    query: async <R extends QueryResultRow>(text: string, params?: readonly unknown[]) => {
      statements.push({ text, params: [...(params ?? [])] });
      return {
        rows: [{ inserted }],
        rowCount,
        command: "",
        oid: 0,
        fields: [],
      } as unknown as QueryResult<R>;
    },
  };
}

/**
 * The `Posted` log the same job would have emitted, encoded off the vendored ABI
 * exactly as the EVM would: indexed members into topics, the rest into the data
 * word. Written here rather than imported from `reducer.test.ts` because it is
 * the *pair* to `jobView()` — the two describe one job through the chain's two
 * windows, and they have to be read together to be checked.
 */
function postedLogOf(view: ReturnType<typeof jobView>, blockNumber: bigint): Log {
  const args = {
    jobId: view.jobId,
    modelId: view.modelId,
    designated: view.designated,
    owner: view.owner,
    c: view.c,
    expiresAt: view.expiresAt,
    slaSecs: view.slaSecs,
    rateIn: view.rateIn,
    rateOut: view.rateOut,
    unitsIn: view.unitsIn,
    unitsOut: view.unitsOut,
    gasFee: view.gasFee,
    taskCid: view.taskCid,
  } as Record<string, unknown>;
  return registryLog("Posted", args, blockNumber);
}

/** The `Settled` log for the same job, carrying the protocol fee settlement took. */
function settledLogOf(view: ReturnType<typeof jobView>, fee: bigint, blockNumber: bigint): Log {
  return registryLog(
    "Settled",
    { jobId: view.jobId, completionTok: view.completionTok, fee, resultCid: view.resultCid },
    blockNumber,
  );
}

function registryLog(eventName: string, args: Record<string, unknown>, blockNumber: bigint): Log {
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
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({ abi, eventName, args }) as [Hex, ...Hex[]],
    transactionHash: `0x${"cc".repeat(32)}`,
    transactionIndex: 0,
  };
}

/**
 * Every column but the two block stamps.
 *
 * `posted_block` and `as_of_block` are the two a reconcile and a rebuild cannot
 * agree on at the moment of the insert, and both are named in the assertions
 * that use this rather than quietly dropped.
 */
function exceptBlocks(row: Record<string, unknown>): Record<string, unknown> {
  const { posted_block: _posted, as_of_block: _asOf, ...rest } = row;
  return rest;
}

describe("storedState — the openness mapping (R3, R43)", () => {
  it("maps getJob's expired-but-open pair back to 0/0", () => {
    expect(storedState({ state: 3, endedBecause: 5 })).toEqual({ state: 0, endedBecause: 0 });
  });

  /**
   * The mutation this exists to catch: deleting the mapping leaves `3/5` on its
   * way to a column whose CHECK stops at 4, so the row would be refused rather
   * than silently wrong — but only against a real database. This assertion goes
   * red without one, which is what R67 asks of a guard.
   */
  it("leaves every other pair exactly as the chain reported it", () => {
    expect(storedState({ state: 0, endedBecause: 0 })).toEqual({ state: 0, endedBecause: 0 });
    expect(storedState({ state: 1, endedBecause: 0 })).toEqual({ state: 1, endedBecause: 0 });
    expect(storedState({ state: 2, endedBecause: 1 })).toEqual({ state: 2, endedBecause: 1 });
    expect(storedState({ state: 3, endedBecause: 2 })).toEqual({ state: 3, endedBecause: 2 });
    expect(storedState({ state: 3, endedBecause: 3 })).toEqual({ state: 3, endedBecause: 3 });
    expect(storedState({ state: 3, endedBecause: 4 })).toEqual({ state: 3, endedBecause: 4 });
  });

  /**
   * Both members, never the cause alone. A looser rule (`endedBecause === 5`)
   * would rewrite a pair arriving some other way instead of letting the CHECK
   * refuse it, and this is the case that tells the two rules apart.
   */
  it("does not rewrite cause 5 under a state getJob never pairs it with", () => {
    expect(storedState({ state: 2, endedBecause: 5 })).toEqual({ state: 2, endedBecause: 5 });
  });
});

describe("reconcileJob — shape, over the stub chain", () => {
  it("makes exactly one getJob call, pinned to latest, and stamps as_of_block with it", async () => {
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: jobView() } });
    const db = recordingDb();

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toEqual({ found: true, action: "updated", block: 4242n });
    // One `eth_call`, and it is the `getJob` (R32's single read). The block came
    // from `eth_blockNumber`, so the stamp is the block that answered rather than
    // one inferred around the call.
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
    const [write] = db.statements;
    expect(write.params[18]).toBe(4242n); // $19 as_of_block
  });

  /**
   * **Every reconcile reads the head itself; none reuses an earlier answer.**
   *
   * viem caches `getBlockNumber` for `cacheTime`, which **defaults to
   * `pollingInterval` — 4000 ms**. On the default client two reconciles inside
   * one window make a single `eth_blockNumber` and the second pins its `getJob`
   * to the first's block, which can be seconds in the past. That is fatal here
   * and nowhere else: this read exists to answer *inside* the finality window,
   * so a block from before the window is the one answer it must never use. Found
   * end to end — a job relayed by this node, with a receipt in hand, came back
   * `404` from `/v1/jobs/{id}` two milliseconds later because the repair behind
   * that route was pinned six blocks back. The `found: false` branch DELETEs, so
   * on {@link repairOnRefusal} a stale read can drop a row that is alive.
   *
   * `makeChain` sets `cacheTime: 0` for this. The counting is the assertion
   * because the staleness is invisible in the outcome: both reconciles return a
   * correct-looking result, and only the request count says whether the second
   * one asked.
   */
  it("reads the head again on a second reconcile rather than reusing the first", async () => {
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: jobView() } });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);
    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(stub.requests.filter((r) => r.method === "eth_blockNumber")).toHaveLength(2);
  });

  /**
   * **R4a's fail-open direction, at the statement level.** R4a permits the INSERT
   * *because* `JobView` satisfies every NOT NULL column; an insert that dropped
   * one of them would be the partial row R4's reasoning forbids. Postgres refuses
   * such a row, so the DB half below is the enforcement — but that half skips
   * without `TEST_DATABASE_URL`, and this one does not: the column list is asserted
   * whole, so deleting a column from the statement goes red in `npm test` alone.
   *
   * `posted_block` is asserted **absent**, in either half of the statement. The
   * view cannot supply it, `DEFAULT 0` is the correct value, and Plan 3's
   * escrow-orphan filter reads that column expecting `0` to mean *"inserted ahead
   * of the log"*.
   */
  it("upserts a complete row and never names posted_block (R4a)", async () => {
    const stub = stubChain(config, { views: { getJob: jobView({ state: 1, providerId: 9 }) } });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(db.statements).toHaveLength(1);
    const sql = db.statements[0].text;
    expect(sql).toMatch(/^\s*INSERT INTO jobs \(/);
    expect(sql).toMatch(/ON CONFLICT \(job_id\) DO UPDATE SET/);

    // Every NOT NULL column of `jobs`, named in the INSERT's column list. This is
    // the list the schema requires; a statement missing any of them cannot insert.
    const columns = /INSERT INTO jobs \(([^)]*)\)/.exec(sql)![1]
      .split(",")
      .map((column) => column.trim());
    expect(columns.sort()).toEqual(
      [
        "as_of_block",
        "c",
        "claimed_at",
        "completion_tok",
        "designated",
        "ended_because",
        "expires_at",
        "fee",
        "gas_fee",
        "job_id",
        "model_id",
        "owner",
        "provider_id",
        "rate_in",
        "rate_out",
        "result_cid",
        "sla_secs",
        "state",
        "task_cid",
        "units_in",
        "units_out",
      ].sort(),
    );
    // One bind per column, and every one supplied: a `$22` or a missing `$7` is
    // a statement Postgres refuses, and the DB half would be the only place that
    // showed up.
    expect(db.statements[0].params).toHaveLength(columns.length);
    for (let i = 1; i <= columns.length; i++) {
      expect(sql, `$${i}`).toMatch(new RegExp(`\\$${i}\\b`));
    }
    expect(sql).not.toMatch(/posted_block/);

    // On conflict, only the mutable columns are written: an existing row keeps
    // the ones the reducer owns, which is the UPDATE this statement replaced.
    const onConflict = sql.slice(sql.indexOf("DO UPDATE SET"));
    for (const column of [
      "owner",
      "posted_block",
      "rate_in",
      "rate_out",
      "units_in",
      "units_out",
      "expires_at",
      "task_cid",
      "designated",
      "sla_secs",
      "gas_fee",
    ]) {
      expect(onConflict).not.toMatch(new RegExp(`\\b${column}\\s*=`));
    }
  });

  /**
   * The view carries no protocol fee: only `Settled` does. A settled row is
   * priced the way `_distribute` priced it, so the one extra read is `feeBps`,
   * pinned to the block the view was read at; any other state reads nothing
   * more and writes 0.
   */
  it("prices a settled row's fee at the view's own block, and reads nothing for any other", async () => {
    const settled = jobView({
      state: 2,
      endedBecause: 1,
      rateIn: 100_000_000n,
      rateOut: 200_000_000n,
      completionTok: 12,
    });
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: settled, feeBps: 250 } });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    const calls = stub.requests.filter((r) => r.method === "eth_call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call.params as [unknown, string])[1]).toBe(`0x${(4242n).toString(16)}`);
    }
    // 100·10 + 200·12 = 3400 atomic charged, and 2.5% of it.
    expect(db.statements[0].params[20]).toBe("85");

    for (const state of [0, 1, 3]) {
      const other = stubChain(config, { views: { getJob: jobView({ state }) } });
      const otherDb = recordingDb();
      await reconcileJob(other.chain, otherDb, JOB_ID, ADDRESSES.jobRegistry);
      expect(other.requests.filter((r) => r.method === "eth_call"), `state ${state}`).toHaveLength(1);
      expect(otherDb.statements[0].params[20], `state ${state}`).toBe("0");
    }
  });

  it("never lets as_of_block go backwards", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });
    const db = recordingDb();

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(db.statements[0].text).toMatch(/as_of_block\s*=\s*GREATEST\(jobs\.as_of_block,/);
  });

  /**
   * `xmax = 0` is how the statement tells an insert from an update, and the
   * outcome is what the read route logs on. Reported wrong in the *open*
   * direction — an insert called an update — the warn line disappears and an
   * operator loses the only signal that the reducer is behind.
   */
  it("reports `inserted` when the upsert created the row", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });
    const db = recordingDb({ inserted: true });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toMatchObject({ found: true, action: "inserted" });
    expect(db.statements[0].text).toMatch(/RETURNING \(xmax = 0\) AS inserted/);
  });

  it("deletes the row when the chain has never heard of the job", async () => {
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });
    const db = recordingDb();

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toMatchObject({ found: false, action: "deleted" });
    expect(db.statements[0].text).toMatch(/^\s*DELETE FROM jobs/);
  });

  it("reports `absent` when there was no row to delete", async () => {
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });

    const outcome = await reconcileJob(stub.chain, recordingDb({ rowCount: 0 }), JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toMatchObject({ found: false, action: "absent" });
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
   * The set is the rule (R67). Widening it would turn every unauthenticated
   * `409` into an RPC amplifier that repairs nothing; narrowing it silently
   * removes the repair. Both directions are asserted, which is what makes this a
   * guard rather than a description.
   */
  it("reconciles on NotOpen, NotClaimed and UnknownJob, and on nothing else", async () => {
    expect([...RECONCILABLE_REVERTS].sort()).toEqual(["NotClaimed", "NotOpen", "UnknownJob"]);

    for (const reason of ["NotOpen", "NotClaimed", "UnknownJob"]) {
      const stub = stubChain(config, { views: { getJob: jobView() } });
      const db = recordingDb();
      await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)(reason);
      expect(db.statements, reason).toHaveLength(1);
    }

    for (const reason of ["AtCapacity", "StaleOp", "DuplicateJob", "unknown", "NotDesignated"]) {
      const stub = stubChain(config, { views: { getJob: jobView() } });
      const db = recordingDb();
      await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)(reason);
      expect(db.statements, reason).toHaveLength(0);
      expect(stub.requests, reason).toHaveLength(0);
    }
  });

  /**
   * The repair that removes a write-through row whose transaction a reorg
   * orphaned. Nothing else can: a phantom row is in no log, so no replay deletes
   * it, and the book would offer it to every daemon in turn.
   */
  it("deletes a phantom row when a claim is refused UnknownJob", async () => {
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });
    const db = recordingDb();

    await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)("UnknownJob");

    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].text).toMatch(/^\s*DELETE FROM jobs/);
  });

  it("does nothing for an op that names no job, or with no chain", async () => {
    const stub = stubChain(config, { views: { getJob: jobView() } });
    const db = recordingDb();

    await repairOnRefusal(stub.chain, db, ADDRESSES.jobRegistry, () => {})(null)("NotOpen");
    expect(stub.requests).toHaveLength(0);

    await repairOnRefusal(undefined, db, ADDRESSES.jobRegistry, () => {})(JOB_ID)("NotOpen");
    expect(db.statements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres (R25): the CHECK is what enforces R3/R43
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

  const key = Buffer.from(JOB_ID.slice(2), "hex");

  /** The whole row, whichever writer produced it. */
  async function jobRow(): Promise<Record<string, unknown> & { posted_block: bigint; as_of_block: bigint }> {
    const { rows } = await db.query("SELECT * FROM jobs WHERE job_id = $1", [key]);
    expect(rows).toHaveLength(1);
    return rows[0] as Record<string, unknown> & { posted_block: bigint; as_of_block: bigint };
  }

  async function seed(asOfBlock = 100n): Promise<void> {
    await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, task_cid, posted_block, as_of_block,
                         gas_fee)
       VALUES ($1, $2, $3, 1, 3600, 0, '1000', '2000', 10, 20, 1900000000, '\\x616263', 77, $4, $5)`,
      [key, Buffer.alloc(20, 0x11), Buffer.from(C.slice(2), "hex"), asOfBlock, GAS_FEE],
    );
  }

  it("writes the settled row the chain reports", async () => {
    await seed();
    const stub = stubChain(config, {
      latestBlock: 900n,
      views: {
        getJob: jobView({
          state: 2,
          endedBecause: 1,
          providerId: 4,
          claimedAt: 1_800_000_500n,
          completionTok: 12,
          resultCid: "0x646566",
        }),
        feeBps: 250,
      },
    });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);
    expect(outcome).toEqual({ found: true, action: "updated", block: 900n });

    const { rows } = await db.query("SELECT * FROM jobs WHERE job_id = $1", [key]);
    expect(rows[0]).toMatchObject({
      state: 2,
      ended_because: 1,
      provider_id: 4n,
      claimed_at: 1_800_000_500n,
      completion_tok: 12n,
      as_of_block: 900n,
      // Untouched by reconcile: the reducer owns it, and Plan 3's orphan filter
      // reads it.
      posted_block: 77n,
      gas_fee: GAS_FEE,
    });
    expect((rows[0] as { result_cid: Buffer }).result_cid).toEqual(Buffer.from("def"));
  });

  /**
   * **The R43 backstop, exercised.** `getJob` reports an expired-but-open job as
   * `state 3 / cause 5`; the column's CHECK stops at 4. Without `storedState`
   * this write raises `23514 new row for relation "jobs" violates check
   * constraint`, which is the loud failure R43 designed. With it, the row keeps
   * the `0/0` a rebuild from logs would produce.
   */
  it("stores 0/0 for an expired-but-open job, not the 3/5 getJob reports (R3, R43)", async () => {
    await seed();
    const stub = stubChain(config, {
      latestBlock: 901n,
      views: { getJob: jobView({ state: 3, endedBecause: 5 }) },
    });

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    const { rows } = await db.query("SELECT state, ended_because FROM jobs WHERE job_id = $1", [key]);
    expect(rows[0]).toEqual({ state: 0, ended_because: 0 });
  });

  it("never walks as_of_block backwards", async () => {
    await seed(5000n);
    const stub = stubChain(config, { latestBlock: 100n, views: { getJob: jobView({ state: 1 }) } });

    await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    const { rows } = await db.query<{ as_of_block: bigint; state: number }>(
      "SELECT as_of_block, state FROM jobs WHERE job_id = $1",
      [key],
    );
    expect(rows[0].as_of_block).toBe(5000n);
    expect(rows[0].state).toBe(1);
  });

  /**
   * **R4a, and the case the ruling names as the one that must be tested.** An
   * expired-but-open job, reconciled into an empty table: the row must be
   * complete — every NOT NULL column carried by the view — and it must land
   * `0/0`, not the `3/5` `getJob` reported.
   *
   * The `3/5` half is not a nicety here. On an INSERT the CHECK refuses the row
   * outright, so a forgotten mapping is not a wrong row but *no row at all* and a
   * throw out of a repair bolted to somebody else's request. `posted_block` is
   * asserted `0` — its `DEFAULT`, and the signal Plan 3's orphan filter reads.
   */
  it("inserts a complete row for a job the reducer has not reached, mapping 3/5 to 0/0", async () => {
    await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    const stub = stubChain(config, {
      latestBlock: 4242n,
      views: { getJob: jobView({ state: 3, endedBecause: 5 }) },
    });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);
    expect(outcome).toEqual({ found: true, action: "inserted", block: 4242n });

    const { rows } = await db.query("SELECT * FROM jobs WHERE job_id = $1", [key]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // R3/R43: computed on the chain, never stored.
      state: 0,
      ended_because: 0,
      // Every NOT NULL column, from the view.
      model_id: 1n,
      sla_secs: 3600n,
      designated: 0n,
      rate_in: 1000n,
      rate_out: 2000n,
      units_in: 10n,
      units_out: 20n,
      expires_at: 1_900_000_000n,
      as_of_block: 4242n,
      // Its DEFAULT, because the view cannot supply it: `0` here means "inserted
      // ahead of the log", not a block number.
      posted_block: 0n,
      gas_fee: GAS_FEE,
      // Nothing settled, so no protocol fee was taken.
      fee: 0n,
    });
    const row = rows[0] as { owner: Buffer; c: Buffer; task_cid: Buffer };
    expect(row.owner).toEqual(Buffer.alloc(20, 0x11));
    expect(row.c).toEqual(Buffer.from(C.slice(2), "hex"));
    expect(row.task_cid).toEqual(Buffer.from("abc"));
  });

  /**
   * **The agreement R4a exists to protect.** A projection is a pure function of
   * the chain, so the row reconcile inserts and the row a rebuild from logs
   * produces must be the same row. They are compared column for column here,
   * with the two that cannot match by construction named rather than dropped:
   *
   *   * `posted_block` — the rebuild has the `Posted` log and its block; the
   *     insert does not, and takes `DEFAULT 0`. So the second half of this test
   *     applies that log **on top of** the reconciled row and shows the reducer
   *     correcting the column, which is what makes `0` a transient state rather
   *     than a permanent disagreement.
   *   * `as_of_block` — a freshness stamp, `GREATEST` on both sides, and not part
   *     of what the chain says about the job.
   *
   * Deleting the `3/5 → 0/0` mapping makes the reconcile half throw on the CHECK
   * and this go red; keeping the mapping but dropping a column from the INSERT
   * makes the two rows differ and this go red the other way.
   */
  it("agrees column for column with a rebuild from logs", async () => {
    const view = jobView({ state: 3, endedBecause: 5 });
    const POSTED_BLOCK = 4200n;

    // The rebuild: the `Posted` log this job's `getJob` describes, through the
    // real reducer.
    await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    await reduceRange(db, [postedLogOf(view, POSTED_BLOCK)], POSTED_BLOCK, BLOCK_HASH);
    const rebuilt = await jobRow();
    expect(rebuilt).toMatchObject({ state: 0, ended_because: 0, posted_block: POSTED_BLOCK });

    // The reconcile, into an empty table.
    await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    const stub = stubChain(config, { latestBlock: 4242n, views: { getJob: view } });
    expect((await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry)).action).toBe(
      "inserted",
    );
    const reconciled = await jobRow();

    expect(exceptBlocks(reconciled)).toEqual(exceptBlocks(rebuilt));
    expect(reconciled.posted_block).toBe(0n);

    // …and the log, arriving afterwards, corrects the one column that differed.
    await reduceRange(db, [postedLogOf(view, POSTED_BLOCK)], POSTED_BLOCK, BLOCK_HASH);
    const healed = await jobRow();
    expect(healed.posted_block).toBe(POSTED_BLOCK);
    expect(exceptBlocks(healed)).toEqual(exceptBlocks(rebuilt));
    // The reconcile's stamp was the later one and it does not regress.
    expect(healed.as_of_block).toBe(4242n);
  });

  /**
   * `Settled` carries the protocol fee and the view does not, so a settled row
   * the reconcile writes is priced the way `_distribute` priced it: the charge
   * over the settled count, at the `feeBps` of the block the view was read at.
   * A `setFees` between the settle and that block makes the two differ, and the
   * log, when the reducer reaches it, writes the fee it carries over the price.
   */
  it("prices a settled row's fee at the read block's feeBps, and the Settled log overwrites it", async () => {
    const view = jobView({
      state: 2,
      endedBecause: 1,
      providerId: 4,
      claimedAt: 1_800_000_500n,
      rateIn: 100_000_000n,
      rateOut: 200_000_000n,
      completionTok: 12,
      resultCid: "0x646566",
    });
    await db.query("DELETE FROM jobs WHERE job_id = $1", [key]);
    const stub = stubChain(config, { latestBlock: 4400n, views: { getJob: view, feeBps: 250 } });

    expect((await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry)).action).toBe("inserted");
    // 100·10 + 200·12 = 3400 atomic charged, and 2.5% of it.
    expect(await jobRow()).toMatchObject({ gas_fee: GAS_FEE, fee: 85n });

    await reduceRange(db, [settledLogOf(view, 102n, 4401n)], 4401n, BLOCK_HASH);
    expect(await jobRow()).toMatchObject({ gas_fee: GAS_FEE, fee: 102n });
  });

  it("deletes a row the chain no longer knows", async () => {
    await seed();
    const stub = stubChain(config, { views: { getJob: jobView({ found: false }) } });

    const outcome = await reconcileJob(stub.chain, db, JOB_ID, ADDRESSES.jobRegistry);

    expect(outcome).toMatchObject({ found: false, action: "deleted" });
    const { rows } = await db.query("SELECT job_id FROM jobs WHERE job_id = $1", [key]);
    expect(rows).toHaveLength(0);
  });
});
