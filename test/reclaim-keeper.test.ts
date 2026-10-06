import { decodeFunctionData, encodeEventTopics, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { openDb, type Db } from "../src/db/db.js";
import { RECLAIM_BATCH, reclaimTick, type ReclaimDeps } from "../src/keepers/reclaim.js";
import { stubChain, testConfig } from "./support/stub-chain.js";

/**
 * The `reclaim` keeper's sweep.
 *
 * `reclaim` is the protocol's only permissionless, unsigned mutation, and it does
 * two things nobody else will: it returns a client's locked capital after a
 * claimed job blows its SLA, and it lands the −40 that makes abandonment cost
 * something. Nothing ran it before this keeper, so both were theoretical.
 *
 * Driven against the real projection and a canned endpoint, because the parts
 * that can be wrong are exactly the parts a mock of the query would hide: which
 * rows the sweep selects, whose clock it selects them by, and whether a
 * transaction that merely *succeeded* is taken as proof the job ended.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_reclaim_keeper_test";

/** The timestamp `stubChain` reports on every block. The chain's clock. */
const CHAIN_NOW = 1_800_000_000n;

/** `Ended`, as a receipt log — what proves the reclaim actually took effect. */
const endedLog = (jobId: Hex) => ({
  address: testConfig().addresses.jobRegistry,
  topics: encodeEventTopics({ abi: jobRegistryAbi, eventName: "Ended", args: { jobId } }),
  data: `0x${"04".padStart(64, "0")}` as Hex,
  blockNumber: "0x3e8",
  blockHash: `0x${"ab".repeat(32)}`,
  transactionHash: `0x${"cd".repeat(32)}`,
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

describe.skipIf(!TEST_DATABASE_URL)("the reclaim keeper's sweep", () => {
  let db: Db;
  const config = testConfig();

  const jobIdOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM jobs");
  });

  /** One projection row, with only the columns the sweep reads made meaningful. */
  async function seedJob(options: {
    n: number;
    state: number;
    claimedAt: bigint;
    slaSecs: bigint;
  }): Promise<Hex> {
    const jobId = jobIdOf(options.n);
    await db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, state, provider_id, claimed_at,
                         task_cid, as_of_block, gas_fee)
       VALUES ($1, $2, $3, 1, $4, 0, 0, 0, 0, 0, $5, $6, 7, $7, ''::bytea, 1000, 0)`,
      [
        Buffer.from(jobId.slice(2), "hex"),
        Buffer.alloc(20, options.n),
        Buffer.alloc(32, options.n),
        options.slaSecs.toString(),
        (CHAIN_NOW + 86_400n).toString(),
        options.state,
        options.claimedAt.toString(),
      ],
    );
    return jobId;
  }

  const depsWith = (stub: ReturnType<typeof stubChain>): ReclaimDeps => ({
    db,
    chain: stub.chain,
    config,
  });

  const noErrors = (error: unknown, jobId: string) => {
    throw new Error(`unexpected keeper error on ${jobId}: ${String(error)}`);
  };

  // -------------------------------------------------------------------------

  /**
   * **The chain's clock, not this process's.** The contract compares against
   * `block.timestamp`, so a job an hour past its SLA by the chain's reckoning is
   * reclaimable no matter what the host thinks the time is. The stub reports a
   * fixed block timestamp far from real `Date.now()`, which is exactly what makes
   * this test able to tell the two apart: a keeper filtering on wall time would
   * select nothing here.
   */
  it("selects claimed rows past their SLA by the chain's clock", async () => {
    const expired = await seedJob({ n: 1, state: 1, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });
    // Claimed, but still inside its window.
    await seedJob({ n: 2, state: 1, claimedAt: CHAIN_NOW - 60n, slaSecs: 3600n });
    // Long past its window, but never claimed — the contract answers NotClaimed.
    await seedJob({ n: 3, state: 0, claimedAt: 0n, slaSecs: 3600n });
    // Already settled.
    await seedJob({ n: 4, state: 2, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });

    const stub = stubChain(config, { receiptLogs: () => [endedLog(expired)] });
    const result = await reclaimTick(depsWith(stub), noErrors);

    expect(result).toEqual({ candidates: 1, reclaimed: 1, skipped: 0 });

    // And it reclaimed *that* job: the calldata names it.
    expect(stub.relayed).toHaveLength(1);
    const call = decodeFunctionData({ abi: jobRegistryAbi, data: stub.relayed[0]! });
    expect(call.functionName).toBe("reclaim");
    expect(call.args?.[0]).toBe(expired);
  });

  /**
   * The exact deadline. `reclaim` opens **strictly after** `claimedAt + slaSecs`
   * — at the boundary the provider may still settle — so a keeper that selected
   * at equality would burn gas on a transaction the contract refuses, every
   * minute, for as long as the row sat there.
   */
  it("leaves a job at exactly its deadline alone, and takes it one second later", async () => {
    await seedJob({ n: 5, state: 1, claimedAt: CHAIN_NOW - 3600n, slaSecs: 3600n });

    const atDeadline = await reclaimTick(depsWith(stubChain(config)), noErrors);
    expect(atDeadline).toEqual({ candidates: 0, reclaimed: 0, skipped: 0 });

    await db.query("UPDATE jobs SET claimed_at = claimed_at - 1");
    const stub = stubChain(config, { receiptLogs: () => [endedLog(jobIdOf(5))] });
    expect(await reclaimTick(depsWith(stub), noErrors)).toMatchObject({ candidates: 1 });
  });

  /**
   * **A lost race costs nothing.** A provider settling in the last second of its
   * SLA is the system working, and the projection can be a block behind. The
   * pre-relay simulate turns that into a skipped row rather than a reverted
   * transaction — the mandatory-simulate rule every write door here follows.
   */
  it("skips a job the chain refuses, and relays nothing for it", async () => {
    await seedJob({ n: 6, state: 1, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });

    const stub = stubChain(config, {
      simulate: () => ({ kind: "revert", errorName: "NotClaimed" }),
    });
    const result = await reclaimTick(depsWith(stub), noErrors);

    expect(result).toEqual({ candidates: 1, reclaimed: 0, skipped: 1 });
    expect(stub.simulated).toHaveLength(1);
    expect(stub.relayed).toHaveLength(0);
  });

  /**
   * **R29: a mined transaction proves nothing.** The receipt is parsed for
   * `Ended` before this counts a reclaim, so a transaction that succeeded
   * without producing the effect is not reported as one.
   */
  it("does not count a reclaim whose receipt carries no Ended event", async () => {
    await seedJob({ n: 7, state: 1, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });

    const stub = stubChain(config, { receiptLogs: () => [] });
    const result = await reclaimTick(depsWith(stub), noErrors);

    expect(result).toEqual({ candidates: 1, reclaimed: 0, skipped: 1 });
    expect(stub.relayed).toHaveLength(1);
  });

  /**
   * The relayer's nonce is one counter and `Chain.relay` is serial by physics, so
   * an unbounded pass after an outage would park every client-facing relay behind
   * housekeeping. The backlog is spread across ticks, oldest claim first, not
   * dropped.
   */
  it("bounds one pass, taking the oldest claims first", async () => {
    for (let n = 0; n < RECLAIM_BATCH + 5; n += 1) {
      await seedJob({
        n: 100 + n,
        state: 1,
        claimedAt: CHAIN_NOW - 7200n - BigInt(RECLAIM_BATCH + 5 - n),
        slaSecs: 3600n,
      });
    }

    const stub = stubChain(config, {
      receiptLogs: () => [endedLog(jobIdOf(100))],
    });
    const result = await reclaimTick(depsWith(stub), noErrors);

    expect(result?.candidates).toBe(RECLAIM_BATCH);
    // Oldest first: job 100 has the earliest `claimed_at`.
    const first = decodeFunctionData({ abi: jobRegistryAbi, data: stub.relayed[0]! });
    expect(first.args?.[0]).toBe(jobIdOf(100));
  });

  /**
   * One job's failure must not end the pass: the other rows are unrelated jobs
   * whose clients' capital is just as locked.
   */
  it("reports a per-job failure and keeps sweeping", async () => {
    await seedJob({ n: 200, state: 1, claimedAt: CHAIN_NOW - 7300n, slaSecs: 3600n });
    await seedJob({ n: 201, state: 1, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });

    let sends = 0;
    const stub = stubChain(config, {
      // The first job's broadcast is refused by the endpoint; the second is not.
      sendError: () => {
        sends += 1;
        return sends === 1 ? new Error("endpoint fell over") : undefined;
      },
      receiptLogs: () => [endedLog(jobIdOf(201))],
    });

    const seen: string[] = [];
    const result = await reclaimTick(depsWith(stub), (_error, jobId) => seen.push(jobId));

    expect(seen).toEqual([jobIdOf(200)]);
    expect(result).toMatchObject({ candidates: 2, reclaimed: 1 });
  });

  /** A node built without an RPC endpoint has nothing to sweep with. */
  it("does nothing at all without a chain", async () => {
    await seedJob({ n: 300, state: 1, claimedAt: CHAIN_NOW - 7200n, slaSecs: 3600n });
    expect(await reclaimTick({ db, chain: null, config }, noErrors)).toBeNull();
  });
});
