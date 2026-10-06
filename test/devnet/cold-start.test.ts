import { afterAll, describe, expect, it } from "vitest";
import { PRESERVED } from "../../src/db/db.js";
import {
  clientAccount,
  freshContainer,
  freshTerms,
  postJob,
  runSmokeFlow,
  snapshotTable,
  startNode,
  waitForCursor,
  waitForHead,
  waitForReady,
  wipeProjection,
  type RunningNode,
} from "./support/harness.js";

/**
 * Scenario 1 — **cold start rebuilds the book**.
 *
 * *Delete the database and the node rebuilds it from the chain.* This is the
 * plan's central claim about the projection, and it is the reason there is no
 * migration story, no `chain_log` table, no orphan repair and no hourly
 * self-heal: none of them is needed for something that is a pure function of the
 * chain. The claim is worth exactly as much as this test.
 *
 * The shape:
 *
 *   1. drive real activity — Plan 1's `SmokeFlow` (a full post → claim → settle,
 *      broadcast from the host) plus **two Open orders posted through the API**,
 *      so the book being compared is not one this suite could have written
 *      directly;
 *   2. wait for the chain's head to pass those blocks (R2) and the cursor to
 *      reach them;
 *   3. snapshot every derived table;
 *   4. wipe — `dropDerived`, the shipped rebuild path, which drops exactly
 *      `DROPPABLE` and leaves `pins` and `quotes_live` (R44, R47);
 *   5. cold start a second node against the same schema and compare.
 *
 * The comparison is over the **tables**, not over one endpoint's rendering of
 * them: an endpoint can agree while the rows underneath differ, and it is the
 * rows that the invariant is about.
 */

const SCHEMA = "vorq_devnet_cold_start";

let node: RunningNode;

afterAll(async () => {
  await node?.stop();
});

/** Every derived table, with the ordering that makes its rows comparable. */
const DERIVED: readonly [table: string, order: string][] = [
  ["jobs", "job_id"],
  ["providers", "provider_id"],
  ["models", "model_id"],
  ["allowlist", "key"],
  ["asks_chain", "provider_id, model_id, sla"],
];

describe("cold start", () => {
  it("rebuilds a byte-identical book from one all-topic replay at deploy_block", async () => {
    node = await startNode({ schema: SCHEMA });
    await waitForReady(node);

    // ---- 1. real activity ------------------------------------------------

    // Plan 1's own acceptance flow, broadcast from the host: post, claim and
    // settle, none of it through this node. What the node has to rebuild is
    // therefore chain history it did not author.
    const smoke = runSmokeFlow();
    expect(smoke).toContain("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL");

    // Two Open orders through the API — the client signs, the node relays and
    // pays. The container rides with the payment and the node pins it inside the
    // same call, so each post writes a `pins` row of its own; that is what the
    // preserved-table assertion below reads.
    const client = clientAccount();
    const posted = [];
    for (const label of ["cold-start-a", "cold-start-b"]) {
      const task = freshContainer(label);
      posted.push(await postJob(node, task, freshTerms(task.c), client));
    }
    expect(posted).toHaveLength(2);

    // ---- 2. wait on the chain's own head, then the cursor (R2) -----------

    const latestPost = posted.reduce((a, b) => (a > b.blockNumber ? a : b.blockNumber), 0n);
    await waitForHead(node.chain.publicClient, latestPost);
    await waitForCursor(node.db, latestPost);

    // ---- 3. snapshot ------------------------------------------------------

    const before: Record<string, unknown[]> = {};
    for (const [table, order] of DERIVED) before[table] = await snapshotTable(node.db, table, order);

    // The two orders are in it, Open, and the SmokeFlow's job settled.
    const openJobs = await node.json<{ jobs: { job_id: string; state: number }[] }>(
      "/evm/jobs?state=Open&limit=200",
    );
    expect(openJobs.status).toBe(200);
    for (const job of posted) {
      expect(openJobs.body.jobs.map((j) => j.job_id)).toContain(job.jobId);
    }
    expect((before.jobs as { state: string }[]).some((row) => row.state === "2")).toBe(true);

    // Something non-derived, to prove the wipe leaves it alone. `pins` is the only
    // record of where a store-minted `jobs.task_cid`'s object lives (R44/R47),
    // and every post above wrote a row into it.
    const pinsBefore = await node.db.query<{ n: bigint }>("SELECT count(*) AS n FROM pins");
    expect(pinsBefore.rows[0].n).toBeGreaterThan(0n);

    await node.stop();

    // ---- 4. wipe ----------------------------------------------------------

    const wipe = await startNode({ schema: SCHEMA }, { coldStart: false });
    await wipeProjection(wipe.db);

    // Nothing derived survived…
    for (const [table] of DERIVED) {
      const { rows } = await wipe.db.query<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0n);
    }
    const { rows: cursorRows } = await wipe.db.query("SELECT * FROM cursor");
    expect(cursorRows).toHaveLength(0);

    // …and the two that are not derivable from chain logs did (R44, R47).
    for (const table of PRESERVED) {
      const { rows } = await wipe.db.query<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`);
      if (table === "pins") expect(rows[0].n, table).toBe(pinsBefore.rows[0].n);
    }
    await wipe.stop();

    // ---- 5. cold start, and the comparison --------------------------------

    node = await startNode({ schema: SCHEMA }, { coldStart: false });

    // **Served only after ready.** The gate is checked before the replay is
    // allowed to start, so this is the book a client would have been refused.
    const cold = await node.request("/evm/jobs");
    expect(cold.status).toBe(503);
    expect(((await cold.json()) as { error: { type: string } }).error.type).toBe("not_ready");

    await node.indexer.start();
    await waitForReady(node);
    await waitForCursor(node.db, latestPost);

    for (const [table, order] of DERIVED) {
      expect(await snapshotTable(node.db, table, order), table).toEqual(before[table]);
    }

    // **One all-topic replay from `deploy_block`** (R30). The first `eth_getLogs`
    // of the rebuild starts at the block the registries were deployed in — the
    // published lower bound, read from the address book and never a literal,
    // because on a fork of a live network block 0 is that network's genesis and a
    // replay from there would ask the upstream for three years of history that
    // cannot contain a VORQ log. It is filtered to the three VORQ contracts and
    // to no topic at all — that is what makes orphan repair unnecessary rather
    // than merely unimplemented.
    const getLogs = node.rpc.filter((call) => call.method === "eth_getLogs");
    expect(getLogs.length).toBeGreaterThan(0);
    const first = (
      getLogs[0].params as [{ fromBlock: string; address: string[]; topics?: unknown[] }]
    )[0];
    expect(BigInt(first.fromBlock)).toBe(BigInt(node.config.addresses.deployBlock));
    // No topic filter at all — viem spells "every topic" as an empty array. The
    // reducer decides what it stores, so an event added to the projection needs
    // no change on the reader's side.
    expect(first.topics ?? []).toEqual([]);
    expect(first.address.map((a) => a.toLowerCase()).sort()).toEqual(
      [
        node.config.addresses.jobRegistry,
        node.config.addresses.providerRegistry,
        node.config.addresses.askRegistry,
      ]
        .map((a) => a.toLowerCase())
        .sort(),
    );
    // Chunked to the configured cap, never one unbounded span: the widest window
    // asked for is `GETLOGS_CAP` blocks, bounds inclusive.
    for (const call of getLogs) {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }];
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      expect(span).toBeLessThanOrEqual(BigInt(node.config.getLogsCap));
    }
  }, 300_000);
});
