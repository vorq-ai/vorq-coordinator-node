import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/db.js";
import { OPEN } from "../src/api/routes/jobs.js";
import { leaseOpenJobs } from "../src/match/lease.js";
import { markAssigned, rankProviders, type MatchJob } from "../src/match/rank.js";
import { planBatch, type PlanRequest } from "../src/match/plan.js";
import { testConfig } from "./support/stub-chain.js";

/**
 * The matcher: the provider poll's leases over the open book, and the ranking
 * behind a challenge's candidates.
 *
 * Driven against the real projection because the parts that can be wrong are
 * the SQL's: who is eligible, in what order, and whether two polls (or two
 * processes) can hand one job to two providers. The chain remains the
 * authority at `claim`; everything here is routing.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_match_test";

const bytes = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);
const FAR_FUTURE = 4_102_444_800n;
const MODEL = 7;
const SLA = 3600;

function scoped(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("the matcher", () => {
  let db: Db;
  const config = testConfig();

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
    for (const table of ["job_leases", "provider_presence", "asks_chain", "jobs", "providers"]) {
      await db.query(`DELETE FROM ${table}`);
    }
  });

  // ---- seeds ---------------------------------------------------------------

  async function insert(table: string, row: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (` +
        `${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      Object.values(row),
    );
  }

  const jobId = (n: number): Buffer => {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32BE(n, 28);
    return buffer;
  };

  async function seedJob(n: number, overrides: Record<string, unknown> = {}): Promise<void> {
    await insert("jobs", {
      job_id: jobId(n),
      owner: bytes(0xaa, 20),
      c: jobId(n),
      model_id: MODEL,
      sla_secs: SLA,
      designated: 0,
      rate_in: "30000",
      rate_out: "90000",
      units_in: 1000,
      units_out: 2000,
      expires_at: FAR_FUTURE,
      task_cid: Buffer.from("bafkreitaskcid", "utf8"),
      posted_block: 10 + n,
      as_of_block: 100,
      gas_fee: "30000",
      ...overrides,
    });
  }

  /** A listed provider with a box key, ten slots, every model allowed. */
  async function seedProvider(id: number, overrides: Record<string, unknown> = {}): Promise<void> {
    await insert("providers", {
      provider_id: id,
      operator: bytes(0xc0 + id, 20),
      box_key: bytes(0xb0 + id),
      reputation: 1000,
      capacity_ceiling: 10,
      capacity_requested: 10,
      listed: true,
      allow_all_models: true,
      ...overrides,
    });
  }

  async function seedAsk(id: number, rateIn = "30000", rateOut = "90000"): Promise<void> {
    await insert("asks_chain", { provider_id: id, model_id: MODEL, sla: SLA, rate_in: rateIn, rate_out: rateOut });
  }

  async function seedPresence(id: number, overrides: Record<string, unknown> = {}): Promise<void> {
    await insert("provider_presence", { provider_id: id, model_id: MODEL, free_slots: 10, ...overrides });
  }

  /** Three interchangeable providers at the same ask, all live. */
  async function seedFleet(ids: number[] = [1, 2, 3]): Promise<void> {
    for (const id of ids) {
      await seedProvider(id);
      await seedAsk(id);
      await seedPresence(id);
    }
  }

  async function leases(): Promise<Map<number, number>> {
    const { rows } = await db.query<{ provider_id: bigint; n: bigint }>(
      "SELECT provider_id, count(*) AS n FROM job_leases GROUP BY provider_id",
    );
    return new Map(rows.map((row) => [Number(row.provider_id), Number(row.n)]));
  }

  async function leaseOf(n: number): Promise<number | null> {
    const { rows } = await db.query<{ provider_id: bigint }>(
      "SELECT provider_id FROM job_leases WHERE job_id = $1 AND expires_at > now()",
      [jobId(n)],
    );
    return rows[0] === undefined ? null : Number(rows[0].provider_id);
  }

  const openJob: MatchJob = {
    modelId: BigInt(MODEL),
    slaSecs: BigInt(SLA),
    designated: 0n,
    rateIn: 30000n,
    rateOut: 90000n,
    unitsIn: 1000n,
    unitsOut: 2000n,
  };

  const rank = (job: Partial<MatchJob> = {}, limit = 10, market = false) =>
    rankProviders(db, { ...openJob, ...job }, { livenessMs: config.match.livenessMs, limit, market });

  const ids = async (...args: Parameters<typeof rank>) =>
    (await rank(...args)).map((candidate) => Number(candidate.provider_id));

  /**
   * One provider poll, as the route issues it: the book's own filter for the
   * model plus whatever the caller sent, and the slots it can start now.
   */
  const poll = (providerId: number, free: number, extra = "", params: unknown[] = []) =>
    db.tx((tx) =>
      leaseOpenJobs(tx, {
        providerId: BigInt(providerId),
        free: BigInt(free),
        leaseMs: config.match.leaseMs,
        filter: `${OPEN} AND model_id = $1${extra}`,
        params: [String(MODEL), ...params],
      }),
    );

  // ---- leases --------------------------------------------------------------

  it("hands each poller the oldest open jobs it can start, so equal providers split a burst by capacity", async () => {
    for (let n = 1; n <= 9; n += 1) await seedJob(n);

    expect(await poll(1, 3)).toBe(3);
    expect(await poll(2, 3)).toBe(3);
    expect(await poll(3, 3)).toBe(3);

    expect(await leases()).toEqual(new Map([[1, 3], [2, 3], [3, 3]]));
    // Oldest first: the first poller took jobs 1-3, not a random three.
    expect(await Promise.all([1, 2, 3, 4, 7].map(leaseOf))).toEqual([1, 1, 1, 2, 3]);
  });

  it("counts what the caller already holds against its free slots", async () => {
    for (let n = 1; n <= 5; n += 1) await seedJob(n);

    expect(await poll(1, 2)).toBe(2);
    // Polled again before claiming: nothing more is handed out.
    expect(await poll(1, 2)).toBe(0);
    // One more slot free, one more job.
    expect(await poll(1, 3)).toBe(1);
    expect(await leases()).toEqual(new Map([[1, 3]]));
  });

  it("a claimed job no longer counts as held, and a full poll takes nothing", async () => {
    await seedJob(1);
    await seedJob(2);
    expect(await poll(1, 1)).toBe(1);
    await db.query("UPDATE jobs SET state = 1, provider_id = 1, claimed_at = 1 WHERE job_id = $1", [jobId(1)]);

    expect(await poll(1, 0)).toBe(0);
    expect(await poll(1, 1)).toBe(1);
    expect(await leaseOf(2)).toBe(1);
  });

  it("offers a lapsed lease to the next poller, and drops the lapsed row", async () => {
    await seedJob(1);
    expect(await poll(1, 1)).toBe(1);
    // A live lease is not disturbed by another poller.
    expect(await poll(2, 1)).toBe(0);
    expect(await leaseOf(1)).toBe(1);

    await db.query("UPDATE job_leases SET expires_at = now() - interval '1 second'");
    expect(await poll(2, 1)).toBe(1);

    expect(await leaseOf(1)).toBe(2);
    expect(await leases()).toEqual(new Map([[2, 1]]));
  });

  it("hands a designated job only to the pinned provider", async () => {
    await seedJob(1, { designated: 2 });
    await seedJob(2, { designated: 9 });
    await seedJob(3);

    expect(await poll(1, 5)).toBe(1);
    expect(await leaseOf(3)).toBe(1);
    expect(await poll(2, 5)).toBe(1);
    expect(await leaseOf(1)).toBe(2);
    expect(await leaseOf(2)).toBeNull();
  });

  it("applies the floors the caller sent, with equality clearing", async () => {
    await seedJob(1, { rate_out: "89999" });
    await seedJob(2, { rate_out: "90000" });

    expect(await poll(1, 5, " AND rate_out >= $2::numeric", ["90000"])).toBe(1);
    expect(await leaseOf(1)).toBeNull();
    expect(await leaseOf(2)).toBe(1);
  });

  it("never leases a row another process is considering, and never leases it twice", async () => {
    await seedJob(1);
    const other = openDb(scoped(TEST_DATABASE_URL as string));
    try {
      await other.tx(async (tx) => {
        await tx.query("SELECT job_id FROM jobs WHERE state = 0 FOR UPDATE");
        expect(await poll(1, 1)).toBe(0);
      });
      expect(await poll(1, 1)).toBe(1);
      expect(await poll(2, 1)).toBe(0);
    } finally {
      await other.close();
    }
  });

  // ---- the ranking, as the challenge sees it ---------------------------------

  it("orders challenge candidates by their ask cost for this job's unit mix", async () => {
    for (const [id, rateIn, rateOut] of [
      [1, "1", "100"],
      [2, "50", "50"],
      [3, "10", "10"],
    ] as const) {
      await seedProvider(id);
      await seedAsk(id, rateIn, rateOut);
      await seedPresence(id);
    }

    const ranked = await rank({ rateIn: 100n, rateOut: 100n, unitsIn: 1n, unitsOut: 1n });

    expect(ranked.map((c) => [Number(c.provider_id), c.rate_in, c.rate_out])).toEqual([
      [3, 10n, 10n],
      [2, 50n, 50n],
      [1, 1n, 100n],
    ]);
    expect(ranked[0]?.box_key).toEqual(bytes(0xb3));
  });

  it("names as a candidate only a provider whose published ask clears the bid and who has a box key", async () => {
    await seedFleet([1, 2, 3, 4]);
    await db.query("UPDATE asks_chain SET rate_out = '90001' WHERE provider_id = 1");
    await db.query("UPDATE providers SET box_key = NULL WHERE provider_id = 2");
    await db.query("UPDATE providers SET box_key = $1 WHERE provider_id = 3", [bytes(0)]);

    expect(await ids()).toEqual([4]);
  });

  it("ranks every live ask for the market, whatever the bid", async () => {
    for (const [id, rateIn, rateOut] of [
      [1, "40", "40"],
      [2, "10", "10"],
    ] as const) {
      await seedProvider(id);
      await seedAsk(id, rateIn, rateOut);
      await seedPresence(id);
    }
    await seedProvider(3);
    await seedAsk(3, "1", "1");
    await seedPresence(3, { free_slots: 0 });

    expect(await ids({ rateIn: 0n, rateOut: 0n }, 10, true)).toEqual([2, 1]);
    expect(await ids({ rateIn: 0n, rateOut: 0n, designated: 1n }, 10, true)).toEqual([1]);
    // A signed 0/0 bid is still a bid: nothing clears it.
    expect(await ids({ rateIn: 0n, rateOut: 0n })).toEqual([]);
  });

  it("rotates the market probe across equal asks", async () => {
    await seedFleet();
    const firsts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [first] = await rank({ rateIn: 0n, rateOut: 0n }, 3, true);
      if (first === undefined) throw new Error("no candidate");
      await markAssigned(db, first.provider_id, openJob.modelId);
      firsts.push(Number(first.provider_id));
    }
    expect(firsts).toEqual([1, 2, 3, 1]);
  });

  it("names only the pinned provider for a designated order", async () => {
    await seedFleet();
    expect(await ids({ designated: 2n })).toEqual([2]);
    expect(await ids({ designated: 9n })).toEqual([]);
  });

  it("excludes a provider with no free slot, by its own report or by the leases it holds", async () => {
    await seedFleet([1, 2, 3]);
    await db.query("UPDATE provider_presence SET free_slots = 0 WHERE provider_id = 1");
    await db.query("UPDATE provider_presence SET free_slots = 1 WHERE provider_id = 2");
    await seedJob(91);
    await db.query(
      "INSERT INTO job_leases (job_id, provider_id, expires_at) VALUES ($1, 2, now() + interval '10 seconds')",
      [jobId(91)],
    );

    expect(await ids()).toEqual([3]);
  });

  it("excludes a provider whose presence is older than the liveness window", async () => {
    await seedFleet([1, 2]);
    await db.query(
      "UPDATE provider_presence SET seen_at = now() - interval '16 seconds' WHERE provider_id = 1",
    );
    await db.query(
      "UPDATE provider_presence SET seen_at = now() - interval '14 seconds' WHERE provider_id = 2",
    );

    expect(await ids()).toEqual([2]);
  });

  it("excludes an unlisted provider, one without an ask for the window, and one not allowed on the model", async () => {
    await seedFleet([1, 2, 3, 4]);
    await db.query("UPDATE providers SET listed = false WHERE provider_id = 1");
    await db.query("DELETE FROM asks_chain WHERE provider_id = 2");
    await db.query(
      "UPDATE providers SET allow_all_models = false, allowed_models = '{8}' WHERE provider_id = 3",
    );
    await db.query(
      "UPDATE providers SET allow_all_models = false, allowed_models = '{7,8}' WHERE provider_id = 4",
    );

    expect(await ids()).toEqual([4]);
  });

  it("rotates the first candidate across successive challenges", async () => {
    await seedFleet();
    const firsts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const [first] = await rank({}, 3);
      if (first === undefined) throw new Error("no candidate");
      await markAssigned(db, first.provider_id, openJob.modelId);
      firsts.push(Number(first.provider_id));
    }
    expect(firsts).toEqual([1, 2, 3, 1]);
  });

  // ---- the batch plan, against the chain's capacity ------------------------

  const planOf = (requests: Partial<PlanRequest>[]) =>
    planBatch(
      db,
      requests.map((r) => ({
        modelId: BigInt(MODEL),
        slaSecs: BigInt(SLA),
        lines: 1n,
        unitsIn: 1000n,
        unitsOut: 2000n,
        ...r,
      })),
      { livenessMs: config.match.livenessMs },
    );
  const split = (allocation: { provider_id: bigint; lines: bigint }[]) =>
    allocation.map((a) => [Number(a.provider_id), Number(a.lines)]);

  it("fills the cheapest provider to its effectiveCap, then the next", async () => {
    for (const [id, rate] of [
      [1, "50"],
      [2, "10"],
    ] as const) {
      await seedProvider(id);
      await seedAsk(id, rate, rate);
      await seedPresence(id);
    }
    const [plan] = await planOf([{ lines: 14n }]);
    expect(split(plan!)).toEqual([
      [2, 10],
      [1, 4],
    ]);
    expect(plan![0]!.rate_in).toBe(10n);
  });

  it("counts claimed jobs and open orders pinned to a provider against its budget", async () => {
    await seedFleet([1]);
    await seedJob(1, { state: 1, provider_id: 1 });
    await seedJob(2, { state: 1, provider_id: 1 });
    await seedJob(3, { designated: 1 });
    await seedJob(4); // an open bid pinned to nobody counts against nobody
    const [plan] = await planOf([{ lines: 50n }]);
    expect(split(plan!)).toEqual([[1, 7]]);
  });

  it("scales the budget by reputation, never below one", async () => {
    await seedFleet([1, 2]);
    await db.query("UPDATE providers SET reputation = 500 WHERE provider_id = 1");
    await db.query("UPDATE providers SET reputation = 100, capacity_requested = 1 WHERE provider_id = 2");
    const [plan] = await planOf([{ lines: 50n }]);
    expect(split(plan!).sort()).toEqual([
      [1, 5],
      [2, 1],
    ]);
  });

  it("answers fewer lines than asked when the network cannot take them all", async () => {
    await seedFleet([1]);
    await db.query("UPDATE provider_presence SET seen_at = now() - interval '1 hour'");
    await seedFleet([2]);
    const [plan] = await planOf([{ lines: 50n }]);
    // Provider 1 is not live; provider 2 alone holds ten.
    expect(split(plan!)).toEqual([[2, 10]]);
  });

  it("does not count one provider free twice across the models of one plan", async () => {
    await seedFleet([1]);
    const [first, second] = await planOf([{ lines: 6n }, { lines: 6n }]);
    expect(split(first!)).toEqual([[1, 6]]);
    expect(split(second!)).toEqual([[1, 4]]);
  });

  it("holds nothing: two plans at once both see the whole budget", async () => {
    await seedFleet([1]);
    const [a, b] = await Promise.all([planOf([{ lines: 10n }]), planOf([{ lines: 10n }])]);
    expect(split(a[0]!)).toEqual([[1, 10]]);
    expect(split(b[0]!)).toEqual([[1, 10]]);
  });

  it("shrinks the next plan once a planned batch's lines are on the book", async () => {
    await seedFleet([1]);
    const [first] = await planOf([{ lines: 6n }]);
    expect(split(first!)).toEqual([[1, 6]]);
    for (let n = 1; n <= 6; n++) await seedJob(n, { designated: 1 });
    const [second] = await planOf([{ lines: 10n }]);
    expect(split(second!)).toEqual([[1, 4]]);
  });

  it("caps the candidate list at the requested size", async () => {
    await seedFleet();
    expect(await ids({}, 2)).toHaveLength(2);
  });
});
