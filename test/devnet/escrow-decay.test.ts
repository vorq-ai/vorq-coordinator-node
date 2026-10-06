import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newRecipientKeypair, openDek } from "../../src/escrow/container.js";
import { ESCROW_KEY_RETENTION_MS } from "../../src/escrow/keys.js";
import {
  clientAccount,
  devnetConfig,
  freshTerms,
  jsonBody,
  postJob,
  providerAccount,
  waitFor,
  waitForReady,
  waitForSocket,
  type NodeProcess,
} from "./support/harness.js";
import {
  claimOnChain,
  ensureCoordinatorAllowlisted,
  escrowContainer,
  escrowPublicKeyOf,
  openCiphertext,
  resolveOutstandingClaims,
  signedRelease,
  startEscrowNode,
  type EscrowContainer,
  type ErrorEnvelope,
} from "./support/escrow.js";

/**
 * Escrow scenario **5** — decay: a retired generation past its deadline is
 * erased, and the miss that follows classifies as a junk wrap.
 *
 * ## How time is advanced, and why it is not a mock
 *
 * Retention is **72 h** (P3, not the plan's 48: the inequality was missing the
 * SLA term). A test cannot wait that out, and these instances are separate
 * processes, so there is nothing here to monkey-patch `Date.now` on (P22). The
 * mechanism is `ESCROW_CLOCK_OFFSET_MS`, read once at boot and handed to the
 * `KeyManager` as its clock — so it reaches exactly two things: the deadline
 * stamped on a generation, and the sweep that erases past it. The loader refuses
 * a non-zero value outside `ESCROW_MODE=mock`.
 *
 * The shape of the exercise follows from that narrowness. **A** retires its
 * generation into a takeover, stamping `A.now + 72 h` with a real clock; **C**
 * adopts that deadline and runs its key-lifecycle clock 73 h ahead, so its very
 * first sweep erases what it just adopted. Nothing else about C is shifted: its
 * `issued_at` bound is real (or every honest request would be stale) and its
 * `keyEpochStart` is real, which is the whole point of the classification below.
 *
 * ## The classification, which is the assertion
 *
 * The job is **not** epoch-orphaned — it expires long after C's custody began, so
 * `isEscrowOrphan` is false — and under the soundness inequality a decayed key
 * cannot back a live order anyway. So the miss is `400 unseal_failed`, the
 * junk-wrap answer, and **not** `410 escrow_key_lost`. Getting that backwards
 * would tell a provider a live job's key is gone.
 */

/** 73 h: one hour past the 72 h a retired generation is held for. */
const PAST_RETENTION_MS = ESCROW_KEY_RETENTION_MS + 3_600_000;

const running: NodeProcess[] = [];

async function stopOnce(node: NodeProcess): Promise<void> {
  const index = running.indexOf(node);
  if (index >= 0) running.splice(index, 1);
  await node.stop();
}

beforeAll(async () => {
  const { addresses } = devnetConfig({ schema: "vorq_devnet_escrow_seed" });
  await ensureCoordinatorAllowlisted(addresses);
}, 120_000);

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

describe("escrow decay", () => {
  it("erases a generation past its deadline, and answers unseal_failed rather than key loss", async () => {
    const a = await startEscrowNode({ schema: "vorq_devnet_escrow_decay_a" });
    running.push(a);
    await waitForReady(a);

    const client = clientAccount();
    const { addresses } = a.config;

    const keyA = await escrowPublicKeyOf(a);
    const old = escrowContainer(client.address, keyA, `sealed to the old generation — ${Date.now()}`);
    const posted = await postJob(a, old, freshTerms(old.c, { designated: 0n }), client);
    await claimOnChain(addresses, posted.jobId);

    // The baseline. Without it, "C cannot open this" is indistinguishable from
    // "nothing could ever have opened this".
    const baseline = await releaseFor(old, addresses.chainId);
    const onA = await a.json<{ dek_sealed: string }>("/release", jsonBody(baseline.body));
    expect(onA.status, JSON.stringify(onA.body)).toBe(200);

    // ---- the successor, 73 h ahead on its key clock -----------------------

    const c = await startEscrowNode({
      schema: "vorq_devnet_escrow_decay_c",
      peerUrl: a.baseUrl,
      peerRequired: true,
      clockOffsetMs: PAST_RETENTION_MS,
      // The deadline bounds a key's life; this only bounds how late the erasure
      // is noticed. One second, so the scenario is not measuring the timer.
      sweepIntervalMs: 1000,
    });
    running.push(c);
    await waitForSocket(c);

    // The sweep says so itself, in the successor's own log. This is the
    // erasure, observed rather than inferred from a refusal.
    await waitFor(
      "the successor to report erased generations",
      async () => (c.output().includes("escrow generations erased") ? true : null),
      { timeoutMs: 60_000, intervalMs: 250 },
    );

    // ---- the old wrap, at the successor -----------------------------------

    const decayed = await releaseFor(old, addresses.chainId);
    const missed = await waitFor(
      "the successor to stop releasing the decayed generation",
      async () => {
        const answer = await c.json<ErrorEnvelope>("/release", jsonBody(decayed.body));
        return answer.status === 200 ? null : answer;
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );

    expect(missed.status, JSON.stringify(missed.body)).toBe(400);
    // **The classification.** Not `escrow_key_lost`: this job is not
    // epoch-orphaned — it expires well after C's custody began — and a decayed
    // key cannot back a live order under the soundness inequality. A junk wrap is
    // what a miss on a live job looks like.
    expect(missed.body.error.code).toBe("unseal_failed");
    expect(missed.body.error.code).not.toBe("escrow_key_lost");

    // ---- the two controls -------------------------------------------------

    // A still has the key, on a real clock. So the erasure is C's clock and not
    // something that happened to the wrap, the job, or the chain.
    const stillOnA = await releaseFor(old, addresses.chainId);
    const again = await a.json<{ dek_sealed: string }>("/release", jsonBody(stillOnA.body));
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    // And C erased the *decayed* generation, not everything it holds: its own
    // current generation carries no deadline and is never swept.
    const keyC = await escrowPublicKeyOf(c);
    expect(keyC.equals(keyA)).toBe(false);
    const fresh = escrowContainer(client.address, keyC, `sealed to the successor — ${Date.now()}`);
    const freshPosted = await postJob(a, fresh, freshTerms(fresh.c, { designated: 0n }), client);
    await claimOnChain(addresses, freshPosted.jobId);

    const onC = await releaseFor(fresh, addresses.chainId);
    const served = await c.json<{ dek_sealed: string }>("/release", jsonBody(onC.body));
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const dek = openDek(
      Buffer.from(served.body.dek_sealed, "base64"),
      onC.response.publicKey,
      onC.response.secretKey,
    );
    expect(openCiphertext(fresh.ciphertext, dek)).toBe(fresh.plaintext);

    await stopOnce(c);
    await stopOnce(a);
  }, 300_000);
});
