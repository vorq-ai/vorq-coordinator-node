import { afterAll, describe, expect, it } from "vitest";
import { newRecipientKeypair } from "../../src/escrow/container.js";
import {
  clientAccount,
  freshTerms,
  jsonBody,
  postJob,
  providerAccount,
  publicClientOf,
  waitFor,
  waitForHead,
  waitForReady,
  waitForSocket,
  type NodeProcess,
} from "./support/harness.js";
import {
  chainNow,
  claimOnChain,
  escrowContainer,
  escrowPublicKeyOf,
  failOnChain,
  gasFeeOf,
  jobStateOf,
  providerIdOf,
  reputationOf,
  resolveOutstandingClaims,
  signedRelease,
  startEscrowNode,
  tokenBalance,
  type EscrowContainer,
  type ErrorEnvelope,
} from "./support/escrow.js";

/**
 * Escrow scenario **6** — total key loss, and the escape that makes it survivable.
 *
 * A fresh instance with **no handover and no peer** is the abrupt loss: every
 * wrap sealed to the instance it replaced names a key that exists nowhere. Three
 * things have to follow, and this asserts all three against the real chain.
 *
 *   * **The book stops advertising what cannot be worked.** An open, undesignated
 *     order posted before this node's custody began carries a dead wrap, so
 *     `GET /evm/jobs` drops it — while the *previous* instance, which still holds
 *     the key, keeps listing it. That contrast is what makes the assertion about
 *     custody rather than about an index that happens to be behind.
 *   * **A provider who claims anyway is told the truth.** `/release` answers
 *     `410 escrow_key_lost` — the per-job code (P7), reached only when the job is
 *     open-shaped, undesignated, and expired before this custody began.
 *   * **The escape is free.** The provider aborts with `fail` inside `FAIL_GRACE`
 *     and takes no reputation penalty, and the client's money comes back in full.
 *     Both are read off the chain, not off a receipt's status.
 *
 * **A dropped job is not a deleted job**: the detail routes still serve it, which
 * is what lets a client poll a job it posted and paid for.
 */

const SHORT_EXPIRY_SECONDS = 45n;

const running: NodeProcess[] = [];

async function stopOnce(node: NodeProcess): Promise<void> {
  const index = running.indexOf(node);
  if (index >= 0) running.splice(index, 1);
  await node.stop();
}

afterAll(async () => {
  // The provider's eight capacity slots are shared with every other file on this
  // chain, and only a terminal transition returns one.
  await resolveOutstandingClaims();
  for (const node of [...running]) await stopOnce(node);
}, 120_000);

async function releaseFor(container: EscrowContainer, chainId: number) {
  const response = newRecipientKeypair();
  const body = await signedRelease(
    providerAccount(),
    {
      job_id: container.jobId,
      seed_wrap: container.seedWrap.toString("base64"),
      ct_hash: container.ctHash,
      response_pubkey: response.publicKey.toString("hex"),
      issued_at: Math.floor(Date.now() / 1000),
    },
    chainId,
  );
  return { response, body };
}

/** Every job id in one listing. `state=Open` keeps the page small and stable. */
async function openBook(node: NodeProcess): Promise<string[]> {
  const listing = await node.json<{ jobs: { job_id: string }[] }>(
    "/evm/jobs?state=Open&limit=1000",
  );
  expect(listing.status).toBe(200);
  return listing.body.jobs.map((row) => row.job_id.toLowerCase());
}

describe("escrow key loss", () => {
  it("drops orphaned orders from the book, answers escrow_key_lost, and the fail refund lands", async () => {
    const held = await startEscrowNode({ schema: "vorq_devnet_escrow_loss_held" });
    running.push(held);
    await waitForReady(held);

    const client = clientAccount();
    const { addresses } = held.config;
    const providerId = await providerIdOf(addresses, providerAccount().address);

    const escrowKey = await escrowPublicKeyOf(held);

    // ---- the order that will vanish from the book -------------------------

    // Open, undesignated, and long-lived, so it is still on the book when the
    // successor is asked about it.
    const orphan = escrowContainer(client.address, escrowKey, `never claimed — ${Date.now()}`);
    const orphanPosted = await postJob(
      held,
      orphan,
      freshTerms(orphan.c, { designated: 0n }),
      client,
    );

    // ---- the order a provider claims anyway --------------------------------

    // Short-lived on purpose: `escrow_key_lost` is reached only when the job
    // expired *before* the successor's custody began, and the successor is booted
    // after this expiry passes. `fail` does not care about expiry — only about the
    // row still being Claimed and about `claimedAt + FAIL_GRACE` — so the escape
    // stays open.
    const claimed = escrowContainer(client.address, escrowKey, `claimed and stranded — ${Date.now()}`);
    const expiresAt = (await chainNow(addresses)) + SHORT_EXPIRY_SECONDS;
    const claimedPosted = await postJob(
      held,
      claimed,
      freshTerms(claimed.c, { designated: 0n, expiresAt }),
      client,
    );

    const balanceBeforeClaim = await tokenBalance(addresses, client.address);
    await claimOnChain(addresses, claimedPosted.jobId);
    const balanceAfterClaim = await tokenBalance(addresses, client.address);
    // The escrow funded exactly once, at claim: cap + the gas fee snapshot.
    expect(balanceAfterClaim).toBeLessThan(balanceBeforeClaim);
    const reputationBefore = await reputationOf(addresses, providerId);

    // The holder still advertises the open order — it holds the key, so nothing
    // about this job is orphaned for it.
    expect(await openBook(held)).toContain(orphanPosted.jobId.toLowerCase());

    // ---- wait out the short expiry, and the head the successor reads -------

    await waitFor(
      `the chain clock to pass ${expiresAt}`,
      async () => ((await chainNow(addresses)) > expiresAt ? true : null),
      { timeoutMs: 180_000, intervalMs: 1000 },
    );
    // Strictly past, so the successor's epoch block is above the orphan's posting
    // block rather than equal to it — the book filter's comparison is strict.
    await waitForHead(publicClientOf(addresses.chainId), orphanPosted.blockNumber + 1n);

    // ---- the fresh instance: no handover, no peer, no keys -----------------

    const fresh = await startEscrowNode({ schema: "vorq_devnet_escrow_loss_fresh" });
    running.push(fresh);
    // The socket, not readiness: `/release` is outside the gate, and the grace
    // window is 300 s from the claim, so the time-critical half of this scenario
    // runs the moment the process answers.
    await waitForSocket(fresh);

    const freshKey = await escrowPublicKeyOf(fresh);
    expect(freshKey.equals(escrowKey)).toBe(false);

    // ---- the provider is told the truth -----------------------------------

    const request = await releaseFor(claimed, addresses.chainId);
    const lost = await fresh.json<ErrorEnvelope>("/release", jsonBody(request.body));
    expect(lost.status, JSON.stringify(lost.body)).toBe(410);
    expect(lost.body.error.code).toBe("escrow_key_lost");
    expect(lost.body.error.type).toBe("not_found");

    // ---- the escape, and the refund ---------------------------------------

    expect(await jobStateOf(addresses, claimedPosted.jobId)).toBe(1);
    await failOnChain(addresses, claimedPosted.jobId);
    expect(await jobStateOf(addresses, claimedPosted.jobId)).toBe(3);

    // Inside the grace window, so no penalty: the reputation is untouched.
    expect(await reputationOf(addresses, providerId)).toBe(reputationBefore);
    // And the client has cap + feeCap back — `_refundAndEnd` pays those to the
    // owner and the gas fee snapshot to the treasury; the operator takes nothing.
    expect(await tokenBalance(addresses, client.address)).toBe(balanceBeforeClaim - (await gasFeeOf(addresses)));

    // ---- the book, once the successor has caught up -----------------------

    await waitForReady(fresh);

    const freshBook = await openBook(fresh);
    expect(freshBook).not.toContain(orphanPosted.jobId.toLowerCase());
    // Non-vacuous: the holder, on the same chain, still lists it.
    expect(await openBook(held)).toContain(orphanPosted.jobId.toLowerCase());

    // **A dropped job is not a deleted job.** The row is there, and both detail
    // routes serve it — a client must be able to poll a job it paid for.
    const detail = await fresh.json<{ job_id: string; state: number }>(
      `/evm/jobs/${orphanPosted.jobId}`,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.job_id.toLowerCase()).toBe(orphanPosted.jobId.toLowerCase());
    expect(detail.body.state).toBe(0);
    const clientDetail = await fresh.json<{ status: string }>(`/v1/jobs/${orphanPosted.jobId}`);
    expect(clientDetail.status).toBe(200);
    expect(clientDetail.body.status).toBe("queued");

    await stopOnce(fresh);
    await stopOnce(held);
  }, 600_000);
});
