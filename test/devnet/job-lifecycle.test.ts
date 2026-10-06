import { afterAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  bearer,
  CLAIM_TYPES,
  clientAccount,
  freshContainer,
  freshTerms,
  jsonBody,
  nowSeconds,
  opDomain,
  openSession,
  postJob,
  providerAccount,
  SETTLE_TYPES,
  startNode,
  waitFor,
  waitForHead,
  waitForReady,
  type RunningNode,
} from "./support/harness.js";

/**
 * Scenario 5 — **post → claim → settle through the node, with ZERO provider
 * transactions.**
 *
 * This is the assertion the whole plan exists to make. A hosted provider holds a
 * key that signs and **never a wallet that spends**: it signs an `Order`-domain
 * op and hands the bytes to this node, which simulates it, relays it from the
 * relayer account, and pays the gas. Everything else in this file is scaffolding
 * for the last line of the first test:
 *
 * ```
 * expect(await client.getTransactionCount({ address: provider.address })).toBe(0)
 * ```
 *
 * `0`, not "unchanged" — Anvil key #3 is the devnet's registered provider
 * operator and has never sent a transaction on this chain. A provider that had
 * to submit anything would show a nonce here, and the "no funded provider
 * wallet" claim would be false.
 *
 * Every write door on this chain is relayer-funded — the client signs its order,
 * the provider signs its ops, and the node builds and pays for every transaction
 * — and this file covers all of them.
 *
 * Every transition is awaited on the chain's **measured** head (R2): the index
 * follows `latest`, so `queued → in_progress → completed` becomes visible only
 * once the head carries each transition's block and the cursor has reached it.
 */

const SCHEMA = "vorq_devnet_lifecycle";

let node: RunningNode;

afterAll(async () => {
  await node?.stop();
});

/** Waits until `/v1/jobs/{id}` reports `status`, and returns the body. */
async function waitForStatus(
  running: RunningNode,
  jobId: Hex,
  status: string,
): Promise<{ status: string; vorq: Record<string, unknown> }> {
  return waitFor(`job ${jobId} to read ${status}`, async () => {
    const response = await running.json<{ status: string; vorq: Record<string, unknown> }>(
      `/v1/jobs/${jobId}`,
    );
    if (response.status !== 200) return null;
    return response.body.status === status ? response.body : null;
  });
}

describe("job lifecycle", () => {
  it("walks queued -> in_progress -> completed with the provider submitting nothing", async () => {
    node = await startNode({ schema: SCHEMA });
    await waitForReady(node);

    const client = clientAccount();
    const provider = providerAccount();

    // The provider's nonce **before** anything. Read first so the assertion at
    // the end is about this run and not about a chain that happened to be clean.
    const providerNonceBefore = await node.chain.publicClient.getTransactionCount({
      address: provider.address,
    });
    expect(providerNonceBefore).toBe(0);

    // ---- the client posts, through the node ------------------------------

    const task = freshContainer("lifecycle");
    const terms = freshTerms(task.c, { designated: 1n });
    const posted = await postJob(node, task, terms, client);

    await waitForHead(node.chain.publicClient, posted.blockNumber);
    const queued = await waitForStatus(node, posted.jobId, "queued");
    expect(queued.vorq).toMatchObject({ state: 0, provider_id: "0" });

    // ---- the provider: a session, the advisory gate, then signed ops -------

    const providerSession = await openSession(node, provider, "provider");

    // The advisory pre-sign gate. Chain `eth_call`s only, no index reads (R22),
    // which is what makes it meaningful *during* the finality lag — precisely
    // when a daemon is deciding whether to sign.
    const advisory = await node.json<{ ok: boolean; reason?: string }>(
      "/evm/simulate/claim",
      jsonBody({ job_id: posted.jobId, address: provider.address }),
    );
    expect(advisory.status).toBe(200);
    expect(advisory.body).toEqual({ ok: true });

    const domain = opDomain(node.config.addresses.chainId, node.config.addresses.jobRegistry);

    const claimIssuedAt = nowSeconds();
    const claimSig = await provider.signTypedData({
      domain,
      types: CLAIM_TYPES,
      primaryType: "Claim",
      message: { jobId: posted.jobId, issuedAt: claimIssuedAt },
    });
    const claimed = await node.json<{ tx_hash: Hex; status: string; block_number: string }>(
      "/evm/ops",
      jsonBody(
        {
          op: "claim",
          job_id: posted.jobId,
          issued_at: Number(claimIssuedAt),
          signature: claimSig,
        },
        bearer(providerSession),
      ),
    );
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(201);
    expect(claimed.body.status).toBe("success");

    await waitForHead(node.chain.publicClient, BigInt(claimed.body.block_number));
    const inProgress = await waitForStatus(node, posted.jobId, "in_progress");
    expect(inProgress.vorq).toMatchObject({ state: 1, provider_id: "1" });
    expect(inProgress).toHaveProperty("in_progress_at");

    // ---- settle ----------------------------------------------------------

    // The result **bytes** ride with the op and the node mints the name — the
    // provider cannot know it when it signs, which is why `resultCid` is not a
    // member of `Settle` any more.
    const resultBytes = Buffer.from(`result-${Date.now()}-${Math.random()}`, "utf8");
    const completionTok = 1500;
    const settleIssuedAt = nowSeconds();
    const settleSig = await provider.signTypedData({
      domain,
      types: SETTLE_TYPES,
      primaryType: "Settle",
      message: {
        jobId: posted.jobId,
        completionTok,
        issuedAt: settleIssuedAt,
      },
    });
    const settled = await node.json<{
      tx_hash: Hex;
      status: string;
      block_number: string;
      result_cid: string;
    }>(
      "/evm/ops",
      jsonBody(
        {
          op: "settle",
          job_id: posted.jobId,
          completion_tok: completionTok,
          result: resultBytes.toString("base64"),
          issued_at: Number(settleIssuedAt),
          signature: settleSig,
        },
        bearer(providerSession),
      ),
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect(settled.body.status).toBe("success");
    // The only way a claimant learns the name of what it delivered.
    expect(typeof settled.body.result_cid).toBe("string");
    expect(settled.body.result_cid).not.toBe("");
    const resultCid = settled.body.result_cid;

    await waitForHead(node.chain.publicClient, BigInt(settled.body.block_number));
    const completed = await waitForStatus(node, posted.jobId, "completed");
    expect(completed.vorq).toMatchObject({
      state: 2,
      ended_because: 1,
      completion_tok: Number(completionTok),
    });
    expect(completed).toMatchObject({ result_cid: resultCid });

    // ---- THE ASSERTION ---------------------------------------------------

    // Two transactions mined for this job, both from the relayer's account, and
    // the provider's nonce is still zero. A hosted provider signs and never
    // spends.
    const providerNonceAfter = await node.chain.publicClient.getTransactionCount({
      address: provider.address,
    });
    expect(providerNonceAfter).toBe(0);

    for (const hash of [claimed.body.tx_hash, settled.body.tx_hash]) {
      const receipt = await node.chain.publicClient.getTransactionReceipt({ hash });
      expect(receipt.from.toLowerCase()).toBe(node.chain.account.address.toLowerCase());
      expect(receipt.from.toLowerCase()).not.toBe(provider.address.toLowerCase());
    }
  }, 300_000);

});
