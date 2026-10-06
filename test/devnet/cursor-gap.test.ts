import { afterAll, describe, expect, it } from "vitest";
import {
  driveBlocks,
  runSmokeFlow,
  startNode,
  waitForCursor,
  waitForHead,
  waitForReady,
  type RunningNode,
} from "./support/harness.js";

/**
 * Scenario 2 — **cursor gap recovery**.
 *
 * A node that was down for a while is not a special case, and proving that is
 * the point. `Indexer.coldStart` and `Indexer.poll` are the *same function*
 * deliberately: a poll after a long stall **is** a cold start, and giving them
 * separate code paths is how one of the two ends up handing the log reader an
 * unbounded span.
 *
 * So: stop the node, let the chain move under it with real job activity, start
 * it again, and check the two things that matter.
 *
 *   * The replay resumes at **`cursor + 1`** and not at `deploy_block`. The
 *     cursor is authoritative (R10) and is never overridden by `deploy_block`,
 *     which bounds the replay only when there is no cursor at all.
 *   * The rows that landed while it was down appear, with no gap: the reducer
 *     refuses an out-of-order or orphaned event outright, so a skipped block
 *     would surface as a throw and a cursor that never moves — not as a quietly
 *     missing row.
 */

const SCHEMA = "vorq_devnet_cursor_gap";

let node: RunningNode;

afterAll(async () => {
  await node?.stop();
});

describe("cursor gap", () => {
  it("resumes from cursor + 1 and closes a 20-block gap", async () => {
    node = await startNode({ schema: SCHEMA });
    await waitForReady(node);

    const { rows } = await node.db.query<{ block_number: bigint }>(
      "SELECT block_number FROM cursor WHERE id = 1",
    );
    const stoppedAt = rows[0].block_number;
    expect(stoppedAt).toBeGreaterThan(0n);

    const jobsBefore = await node.db.query<{ n: bigint }>("SELECT count(*) AS n FROM jobs");

    // ---- down ------------------------------------------------------------

    await node.stop();

    // A whole job flow — post, claim, settle — plus enough plain blocks that the
    // gap is unambiguously wider than one poll's worth. `driveBlocks` sends real
    // transactions through the **capped** proxy rather than calling `anvil_mine`
    // on the debug endpoint (R36).
    const smoke = runSmokeFlow();
    expect(smoke).toContain("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL");
    const head = await driveBlocks(node.config.addresses.chainId, 20);
    expect(head - stoppedAt).toBeGreaterThan(20n);

    // ---- up again --------------------------------------------------------

    node = await startNode({ schema: SCHEMA }, { coldStart: false });

    // The cursor survived the restart: this node is resuming, not rebuilding.
    const resumed = await node.db.query<{ block_number: bigint }>(
      "SELECT block_number FROM cursor WHERE id = 1",
    );
    expect(resumed.rows[0].block_number).toBe(stoppedAt);

    await node.indexer.start();
    await waitForHead(node.chain.publicClient, head);
    await waitForCursor(node.db, head);
    await waitForReady(node);

    // **From `cursor + 1`.** Not from `deploy_block`, which would have re-read
    // every block since the registries landed; and not from `cursor`, which
    // would re-apply a block already committed.
    const getLogs = node.rpc.filter((call) => call.method === "eth_getLogs");
    expect(getLogs.length).toBeGreaterThan(0);
    const [firstFilter] = getLogs[0].params as [{ fromBlock: string; toBlock: string }];
    expect(BigInt(firstFilter.fromBlock)).toBe(stoppedAt + 1n);

    // Contiguous: every window begins exactly where the previous one ended, so
    // no block in the gap went unread.
    let expectedNext = stoppedAt + 1n;
    for (const call of getLogs) {
      const [filter] = call.params as [{ fromBlock: string; toBlock: string }];
      expect(BigInt(filter.fromBlock)).toBe(expectedNext);
      expectedNext = BigInt(filter.toBlock) + 1n;
    }

    // And the flow that ran while it was down is in the book: the SmokeFlow's
    // job posted, claimed and settled, all three applied in one catch-up.
    const jobsAfter = await node.db.query<{ n: bigint }>("SELECT count(*) AS n FROM jobs");
    expect(jobsAfter.rows[0].n).toBe(jobsBefore.rows[0].n + 1n);

    const settled = await node.json<{ jobs: { state: number }[] }>(
      "/evm/jobs?state=Settled&limit=200",
    );
    expect(settled.status).toBe(200);
    expect(settled.body.jobs.length).toBeGreaterThan(0);
  }, 300_000);
});
