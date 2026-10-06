import { afterAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { newRecipientKeypair, openDek } from "../../src/escrow/container.js";
import {
  clientAccount,
  freshTerms,
  jsonBody,
  postJob,
  providerAccount,
  waitFor,
  waitForHead,
  waitForReady,
  publicClientOf,
  type NodeProcess,
} from "./support/harness.js";
import {
  escrowContainer,
  escrowPublicKeyOf,
  jobStateOf,
  claimOnChain,
  openCiphertext,
  providerIdOf,
  resolveOutstandingClaims,
  signedRelease,
  startEscrowNode,
  type ErrorEnvelope,
} from "./support/escrow.js";

/**
 * Escrow scenarios **1 and 2** — the open-order round trip, and the forged row.
 *
 * One instance, because both scenarios want the same expensive thing: a real
 * `src/main.ts` with `ESCROW_MODE=mock`, caught up on this chain, with its
 * own Postgres projection. Everything else differs.
 *
 * **Scenario 1** is the whole design in one path: a container sealed to *this*
 * node's advertised generation, posted through the real post door as an **open**
 * order (`designated = 0`), claimed on chain by a registered provider, and the
 * DEK released to a wallet signature and opened locally. The assertion at the end
 * is a plaintext, not a status code — a `200` carrying 80 bytes proves the door
 * answered, and only the decryption proves it answered with the right key.
 *
 * **Scenario 2 is the one that proves the invariant**, and it is written first in
 * this file's history for that reason. `/release` must read the *chain* and never
 * the index (P7), and the only way to demonstrate a negative like that is to make
 * the index lie. So an unclaimed escrow order's `jobs` row is UPDATEd directly to
 * `state = 1` with the real provider's id — the exact row a Postgres-reading
 * implementation would have read and believed — and the release is then made with
 * an otherwise perfect request. The chain says Open, so the answer is
 * `409 not_claimed`, and the forgery is proved to be a real one by the node's own
 * `GET /v1/jobs/{id}` reporting `in_progress` off the same row in the same breath.
 */

const SCHEMA = "vorq_devnet_escrow_order";

let node: NodeProcess;

afterAll(async () => {
  // The provider's eight capacity slots are shared with every other file on this
  // chain, and only a terminal transition returns one. See `resolveOutstandingClaims`.
  await resolveOutstandingClaims();
  await node?.stop();
}, 120_000);

/** A signed, well-formed release request for one container, from the claimant. */
async function releaseRequest(
  container: { jobId: Hex; seedWrap: Buffer; ctHash: Hex },
  chainId: number,
) {
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

describe("escrow open-order release", () => {
  it("round-trips a plaintext: sealed to the node's key, claimed on chain, released, decrypted", async () => {
    node = await startEscrowNode({ schema: SCHEMA });
    await waitForReady(node);

    const client = clientAccount();
    const provider = providerAccount();
    const { addresses } = node.config;

    // ---- the client's side, exactly as an SDK must do it -------------------

    // The generation this node advertises **right now**. Nothing is cached and
    // nothing is assumed: a wrap sealed to a key this node does not hold is the
    // failure the whole scenario would otherwise miss.
    const escrowKey = await escrowPublicKeyOf(node);
    expect(escrowKey).toHaveLength(32);

    const plaintext = `the task, in the clear — ${Date.now()}`;
    // P4b: the sealed 32 bytes are a **seed**, and the ciphertext is encrypted
    // under HKDF(seed, "vorq-dek" ‖ owner). A container that sealed the DEK
    // itself would post and claim perfectly and never decrypt.
    const container = escrowContainer(client.address, escrowKey, plaintext);

    // designated 0 — an **open** order. This is the only shape the hosted escrow
    // is about; a designated wrap never reaches this node at all.
    const terms = freshTerms(container.c, { designated: 0n });
    expect(terms.designated).toBe(0n);

    const posted = await postJob(node, container, terms, client);
    expect(posted.jobId.toLowerCase()).toBe(container.jobId.toLowerCase());

    // ---- the provider claims, on chain ------------------------------------

    await claimOnChain(addresses, posted.jobId);
    expect(await jobStateOf(addresses, posted.jobId)).toBe(1);

    // ---- the release ------------------------------------------------------

    const { response, body } = await releaseRequest(container, addresses.chainId);
    const released = await node.json<{ dek_sealed: string }>("/release", jsonBody(body));
    expect(released.status, JSON.stringify(released.body)).toBe(200);

    const sealed = Buffer.from(released.body.dek_sealed, "base64");
    // Sealed to the recipient key the signature named, and to nothing else.
    expect(sealed).toHaveLength(80);
    const dek = openDek(sealed, response.publicKey, response.secretKey);

    // Not "some 32 bytes": the key the client encrypted under, and the plaintext
    // it committed to. This line is the scenario.
    expect(dek.equals(container.dek)).toBe(true);
    expect(openCiphertext(container.ciphertext, dek)).toBe(plaintext);

    // The provider never sent a transaction of its own; the claim was relayed.
    expect(
      await publicClientOf(addresses.chainId).getTransactionCount({ address: provider.address }),
    ).toBe(0);
  }, 300_000);

  /**
   * **The single test that proves escrow reads chain state and not the index**
   * (P7). Everything before the UPDATE exists to make the forged row one an
   * implementation could actually have acted on.
   */
  it("refuses a release against a Claimed row forged directly in Postgres", async () => {
    await waitForReady(node);

    const client = clientAccount();
    const { addresses } = node.config;

    const escrowKey = await escrowPublicKeyOf(node);
    const container = escrowContainer(client.address, escrowKey, "never claimed");
    const posted = await postJob(node, container, freshTerms(container.c, { designated: 0n }), client);

    // The row has to exist before it can be forged, and it exists only once the
    // log has landed and the index has applied it.
    await waitForHead(publicClientOf(addresses.chainId), posted.blockNumber);
    const key = Buffer.from(posted.jobId.slice(2), "hex");
    await waitFor(`the projection to carry job ${posted.jobId}`, async () => {
      const { rows } = await node.db.query<{ state: number }>(
        "SELECT state FROM jobs WHERE job_id = $1",
        [key],
      );
      return rows.length === 1 ? rows[0]! : null;
    });

    // The chain's own account of this job, before anything is forged: Open, and
    // claimed by nobody.
    expect(await jobStateOf(addresses, posted.jobId)).toBe(0);

    // ---- the forgery ------------------------------------------------------

    // `provider_id` is read from the chain, not invented: the row a
    // Postgres-reading implementation would have believed is one naming the
    // provider that would then have passed the identity rung.
    const providerId = await providerIdOf(addresses, providerAccount().address);
    expect(providerId).toBeGreaterThan(0n);

    const forged = await node.db.query(
      "UPDATE jobs SET state = 1, provider_id = $2 WHERE job_id = $1",
      [key, providerId.toString()],
    );
    expect(forged.rowCount).toBe(1);

    // The forgery is real, and this is how we know: the node's own index-backed
    // detail route now reports a job in progress, claimed by that provider. Any
    // implementation that consulted the projection would have released the DEK.
    const indexed = await node.json<{ status: string; vorq: Record<string, unknown> }>(
      `/v1/jobs/${posted.jobId}`,
    );
    expect(indexed.status).toBe(200);
    expect(indexed.body.status).toBe("in_progress");
    expect(indexed.body.vorq).toMatchObject({ state: 1, provider_id: Number(providerId) });

    // ---- the release, otherwise perfect -----------------------------------

    const { body } = await releaseRequest(container, addresses.chainId);
    const refused = await node.json<ErrorEnvelope>("/release", jsonBody(body));

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("not_claimed");
    // P13: one envelope, and the code lives inside `error`.
    expect(refused.body).not.toHaveProperty("code");
    expect(refused.body.error.type).toBe("invalid_request_error");

    // And the chain has not moved: the refusal came from `getJob`, not from a
    // transition somebody else landed while this test was running.
    expect(await jobStateOf(addresses, posted.jobId)).toBe(0);
  }, 300_000);
});
