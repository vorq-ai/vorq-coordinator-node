import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { newRecipientKeypair, openDek } from "../../src/escrow/container.js";
import {
  allocatePort,
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
  startPeerGate,
  strangerHandoverBody,
  type EscrowContainer,
  type ErrorEnvelope,
  type PeerGate,
} from "./support/escrow.js";

/**
 * Escrow scenarios **3 and 4** — the two ways key custody crosses a process
 * boundary, against the real chain and real spawned instances.
 *
 * Both need the same chain precondition, established once by a curation-signed
 * transaction rather than a redeploy (P8): this image's measurement active on the
 * allowlist, which the boot deploy does not seed on this long-lived devnet. The
 * helper writes the entry if it is missing and costs one `eth_call` if it is not.
 *
 * The other half of `/handover`'s authorization is **not** chain state: the
 * operator signature is checked against the node's own `OPERATOR_KEY`, so
 * the spawned instances share one and a stranger's key is refused without any
 * chain read at all.
 *
 * **Scenario 3 — the upgrade.** B boots with `PEER_URL=<A>`,
 * `PEER_REQUIRED=1` and a higher release ordinal, adopting A's generations
 * *before it listens*. Two assertions: A is **completely untouched** and still
 * serving — a handover is a read, so a successor that crashed mid-boot would cost
 * nothing — and then, after the orchestrator stops A, the very bytes signed for A
 * release on B unmodified, opening the ciphertext they were built for.
 *
 * **Scenario 4 — the mirrored pair.** Per P6 the topology is **symmetric**: both
 * instances carry the other's `PEER_URL` and each pulls. Under a one-sided
 * configuration the two properties it claims — either instance serves any
 * release, and a generation minted on B reaches A — are unreachable by
 * construction, so this asserts both, and the B → A direction with a valve in the
 * link so the "before" state is a fact rather than a race.
 */

/**
 * The chain precondition, established **before any instance boots**.
 *
 * The replica pair's first sync tick fires at boot and its last rung is the
 * allowlist read, so seeding after the nodes are up would make the first tick of
 * every run fail for a reason that has nothing to do with what is under test.
 * `devnetConfig` is read only for the published addresses; no node is built here.
 */
beforeAll(async () => {
  const { addresses } = devnetConfig({ schema: "vorq_devnet_escrow_seed" });
  await ensureCoordinatorAllowlisted(addresses);
}, 120_000);

const running: NodeProcess[] = [];
const gates: PeerGate[] = [];

/**
 * The claimed rows a node is serving, without the envelope's readiness stamp.
 *
 * `as_of_block` is what R28 puts on every index-backed answer, and it is a fact
 * about the answer rather than about the rows: it moves with the chain whether or
 * not a single row changed. Two reads either side of a `stop()` are two blocks
 * apart on a devnet that never stops mining.
 */
async function claimedRows(node: NodeProcess): Promise<unknown> {
  const answer = await node.json<{ jobs: unknown }>("/evm/jobs?state=Claimed");
  expect(answer.status).toBe(200);
  return answer.body.jobs;
}

/** Stops a spawned instance once, and never twice — `stop()` closes its pool. */
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
  for (const gate of gates) await gate.stop();
}, 120_000);

/** A signed release for a container, from the claimant operator. */
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

/** Posts a container as an open order and claims it on chain. */
async function postAndClaim(
  node: NodeProcess,
  container: EscrowContainer,
): Promise<Hex> {
  const posted = await postJob(
    node,
    container,
    freshTerms(container.c, { designated: 0n }),
    clientAccount(),
  );
  await claimOnChain(node.config.addresses, posted.jobId);
  return posted.jobId;
}

describe("escrow handover", () => {
  it("carries a pre-upgrade wrap across a succession: both serve it, then B alone", async () => {
    const a = await startEscrowNode({ schema: "vorq_devnet_escrow_upgrade_a", releaseOrdinal: 1 });
    running.push(a);
    await waitForReady(a);

    const client = clientAccount();
    const { addresses } = a.config;

    const keyA = await escrowPublicKeyOf(a);
    const plaintext = `sealed before the upgrade — ${Date.now()}`;
    const container = escrowContainer(client.address, keyA, plaintext);
    await postAndClaim(a, container);

    // The baseline, and it is not decoration: without it a B that released
    // nothing and an A that never held the key look the same.
    const { response, body } = await releaseFor(container, addresses.chainId);
    const onA = await a.json<{ dek_sealed: string }>("/release", jsonBody(body));
    expect(onA.status, JSON.stringify(onA.body)).toBe(200);

    // ---- the upgrade ------------------------------------------------------

    // A higher ordinal, which is the anti-rollback anchor: the holder refuses a
    // successor whose evidence carries a *lower* one.
    const b = await startEscrowNode({
      schema: "vorq_devnet_escrow_upgrade_b",
      releaseOrdinal: 2,
      peerUrl: a.baseUrl,
      peerRequired: true,
    });
    running.push(b);
    // The socket is the proof the join succeeded: `main.ts` joins **above**
    // `app.listen`, and a required pull that fails is a failed boot. This is the
    // signal an orchestrator cuts traffic over on.
    await waitForSocket(b);

    // ---- A is untouched, and that is the point ----------------------------

    // A handover is a read. The predecessor keeps its generation, keeps
    // advertising it, and keeps serving — so a successor that died one
    // instruction after the pull would cost the network nothing at all.
    const stillAdvertising = await a.json<{ escrow_public_key: string }>("/key");
    expect(stillAdvertising.status).toBe(200);
    expect(stillAdvertising.body.escrow_public_key).toBe(keyA.toString("hex"));

    // Both instances answer the identical signed request, at the same time.
    const stillOnA = await a.json<{ dek_sealed: string }>("/release", jsonBody(body));
    expect(stillOnA.status, JSON.stringify(stillOnA.body)).toBe(200);
    const onBWhileAlive = await b.json<{ dek_sealed: string }>("/release", jsonBody(body));
    expect(onBWhileAlive.status, JSON.stringify(onBWhileAlive.body)).toBe(200);

    // ---- traffic has moved; the orchestrator kills A -----------------------

    await stopOnce(a);
    await expect(a.request("/key").then((r) => r.text())).rejects.toThrow();

    // ---- the same bytes, at B alone ---------------------------------------

    const onB = await b.json<{ dek_sealed: string }>("/release", jsonBody(body));
    expect(onB.status, JSON.stringify(onB.body)).toBe(200);

    // Opened under the response key the **original** request named, because that
    // key is inside the signature and a replay can only ever deliver to it.
    const dek = openDek(
      Buffer.from(onB.body.dek_sealed, "base64"),
      response.publicKey,
      response.secretKey,
    );
    expect(dek.equals(container.dek)).toBe(true);
    expect(openCiphertext(container.ciphertext, dek)).toBe(plaintext);

    await stopOnce(b);
  }, 300_000);

  it("shares both ways across a replica pair, and keeps serving when one instance dies", async () => {
    // Both ports are drawn before either process starts: the topology is
    // symmetric (P6), so neither instance can be configured after the other.
    const portA = allocatePort();
    const portB = allocatePort();

    // The valve in A's peer link. Closed, so A cannot have pulled B's generation
    // before the assertion that says it has not.
    const gate = await startPeerGate(`http://127.0.0.1:${portB}`);
    gates.push(gate);
    gate.close();

    const a = await startEscrowNode({
      schema: "vorq_devnet_escrow_replica_a",
      port: portA,
      peerUrl: gate.url,
      peerSyncSeconds: 5,
    });
    running.push(a);
    const b = await startEscrowNode({
      schema: "vorq_devnet_escrow_replica_b",
      port: portB,
      peerUrl: `http://127.0.0.1:${portA}`,
      peerSyncSeconds: 5,
    });
    running.push(b);

    await waitForReady(a);
    await waitForReady(b);

    const client = clientAccount();
    const { addresses } = a.config;

    const keyA = await escrowPublicKeyOf(a);
    const keyB = await escrowPublicKeyOf(b);
    // Two instances, two independently minted generations. If these were equal
    // every later assertion would be vacuous.
    expect(keyA.equals(keyB)).toBe(false);

    // ---- A's key releases on BOTH -----------------------------------------

    const fromA = escrowContainer(client.address, keyA, `sealed to A — ${Date.now()}`);
    await postAndClaim(a, fromA);

    const onA = await releaseFor(fromA, addresses.chainId);
    const aAnswer = await a.json<{ dek_sealed: string }>("/release", jsonBody(onA.body));
    expect(aAnswer.status, JSON.stringify(aAnswer.body)).toBe(200);

    // B's own peer link is direct and its first tick fires at boot, so this is a
    // wait on a pull that is already scheduled, not on a race.
    const onB = await releaseFor(fromA, addresses.chainId);
    const bAnswer = await waitFor(
      "B to release a wrap sealed to A's generation",
      async () => {
        const answer = await b.json<{ dek_sealed: string }>("/release", jsonBody(onB.body));
        return answer.status === 200 ? answer : null;
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );
    const dekFromB = openDek(
      Buffer.from(bAnswer.body.dek_sealed, "base64"),
      onB.response.publicKey,
      onB.response.secretKey,
    );
    expect(openCiphertext(fromA.ciphertext, dekFromB)).toBe(fromA.plaintext);

    // **A retired nothing**: a replica join is not a takeover, and A is still the
    // key a client should seal new work to.
    const stillA = await escrowPublicKeyOf(a);
    expect(stillA.equals(keyA)).toBe(true);

    // ---- B -> A, the direction the plan claims ----------------------------

    const fromB = escrowContainer(client.address, keyB, `minted on B — ${Date.now()}`);
    await postAndClaim(a, fromB);

    // Closed valve: A has never reached B, so this refusal is about custody and
    // not about timing. `unseal_failed`, not `escrow_key_lost` — the job is not
    // epoch-orphaned, it is simply sealed to somebody else's key.
    const beforeSync = await releaseFor(fromB, addresses.chainId);
    const refused = await a.json<ErrorEnvelope>("/release", jsonBody(beforeSync.body));
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.error.code).toBe("unseal_failed");
    expect(gate.forwarded()).toBe(0);

    gate.open();

    const afterSync = await releaseFor(fromB, addresses.chainId);
    const adopted = await waitFor(
      "A to release a wrap sealed to a generation minted on B",
      async () => {
        const answer = await a.json<{ dek_sealed: string }>("/release", jsonBody(afterSync.body));
        return answer.status === 200 ? answer : null;
      },
      // One tick is 5 s, the loader's floor. Three of them is slack, not a window
      // this is measuring.
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    const dekFromA = openDek(
      Buffer.from(adopted.body.dek_sealed, "base64"),
      afterSync.response.publicKey,
      afterSync.response.secretKey,
    );
    expect(openCiphertext(fromB.ciphertext, dekFromA)).toBe(fromB.plaintext);

    // ---- kill A; B keeps serving, with no book change and no key loss ------

    // `state=Claimed` rather than the whole book: a claimed row does not change
    // state on its own, whereas the open listing turns over as orders expire, and
    // a comparison that drifted by a second would be measuring the clock.
    //
    // **`as_of_block` is dropped from both envelopes**, for the same reason and one
    // level up: it is R28's readiness stamp, it describes the *answer* rather than
    // the rows, and it advances with every block whether or not anything changed.
    // Comparing whole envelopes made this assertion green only when the chain
    // happened not to mine between two HTTP calls — it failed on 50554 vs 50555
    // with byte-identical `jobs`, which is the assertion passing and the test
    // reporting a failure. The rows are the claim.
    const bookBefore = await claimedRows(b);

    await stopOnce(a);

    expect(await claimedRows(b)).toEqual(bookBefore);

    // Both generations, on the survivor: its own, and the one it adopted from a
    // node that no longer exists.
    for (const container of [fromA, fromB]) {
      const request = await releaseFor(container, addresses.chainId);
      const answer = await b.json<{ dek_sealed: string }>("/release", jsonBody(request.body));
      expect(answer.status, `${container.jobId}: ${JSON.stringify(answer.body)}`).toBe(200);
      const dek = openDek(
        Buffer.from(answer.body.dek_sealed, "base64"),
        request.response.publicKey,
        request.response.secretKey,
      );
      expect(openCiphertext(container.ciphertext, dek)).toBe(container.plaintext);
    }

    await stopOnce(b);
  }, 600_000);

  /**
   * **Scenario 5 — an attested stranger gets nothing.**
   *
   * The one that proves the operator rung against a real spawned node rather
   * than a stub. This caller runs the genuine image, so its evidence is honest in
   * every particular and would clear the measurement rung; its signature is valid
   * and recovers cleanly. What it lacks is the network's operator key, which is
   * exactly the position of anyone who pulls the published image and runs it.
   *
   * The stakes are not the pull itself: an instance holding the key set, pointed
   * at a chain it controls, answers its own `/release` for any job it invents.
   */
  it("refuses a caller holding a different operator key, and changes nothing", async () => {
    const a = await startEscrowNode({ schema: "vorq_devnet_escrow_stranger_a", releaseOrdinal: 1 });
    running.push(a);
    await waitForReady(a);

    const keyBefore = await escrowPublicKeyOf(a);

    // A stranger's instance: real evidence over its own channel key, a real
    // signature, and an operator key that is nobody's.
    const stranger = privateKeyToAccount(`0x${"5a".repeat(32)}`);
    const refused = await a.json<ErrorEnvelope>(
      "/handover",
      jsonBody(await strangerHandoverBody(stranger, a.config.addresses.chainId)),
    );

    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe("operator_not_authorized");
    expect(refused.body).not.toHaveProperty("keys_sealed");

    // Untouched: still the same generation, still advertising, still releasing.
    const keyAfter = await escrowPublicKeyOf(a);
    expect(keyAfter.equals(keyBefore)).toBe(true);

    await stopOnce(a);
  }, 300_000);
});
