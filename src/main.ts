import * as Sentry from "@sentry/node";
import { buildApp } from "./api/app.js";
import { startSweep } from "./api/sessions.js";
import { startPublisher } from "./asks/publisher.js";
import { BATCH_WORKER_INTERVAL_MS, startBatchWorker } from "./batches/worker.js";
import { pinnerFor } from "./pin/pinner.js";
import { startFileSweep } from "./pin/sweep.js";
import { makeChain } from "./chain/client.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db/db.js";
import { bootEscrow } from "./escrow/boot.js";
import { minKeyEpochStart, startPeerSync } from "./escrow/handover.js";
import { KeyManager } from "./escrow/keys.js";
import { handoverAuthSigner } from "./escrow/operator.js";
import { StaticKeyManager } from "./escrow/static-keys.js";
import { startReclaimKeeper } from "./keepers/reclaim.js";
import { startRelayerBalanceWatch } from "./keepers/relayer-balance.js";
import type { KeyEpochStart } from "./escrow/release.js";
import { startIndexer } from "./index/indexer.js";
import { assertDomains } from "./orders.js";

/**
 * The node's entry point: configuration, then the store, then the chain, then
 * the API, then the cold start.
 *
 * **It listens first and cold starts second, so "up but not ready" is a state
 * this process can express.** The design is a full replay from the address
 * book's `deployBlock`, so a cold start is long by construction. Cold starting first would
 * mean a health check gets *connection refused* for that whole period, reads the
 * node as **down**, and kills it — after which the replay begins again from zero
 * and never finishes. A readiness probe exists precisely to tell *starting* from
 * *dead*, and `GET /readyz` answers `503 not_ready` for exactly this window while
 * every index-backed route refuses with the `not_ready` envelope. Nothing serves
 * a half-built book: the gate, not the closed socket, is what makes that true.
 *
 * The two failures that must still stop the process do. `migrate()` refuses a
 * PostgreSQL older than 16 and runs before anything binds; a cold start that
 * fails closes the server and exits non-zero rather than leaving a process
 * listening and permanently not-ready, because `Indexer.start()` is one-shot and
 * a consumed one cannot be retried in place — a supervisor restart is the only
 * repair, and it cannot know to perform one if the port keeps answering.
 *
 * The third is {@link bootEscrow}: it is awaited here, uncaught, above
 * `app.listen`, and a node whose retention window is unsound never binds.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDb(config.dbUrl);
  await db.migrate();

  const chain = makeChain(config);

  // The payment token's domain is **asserted, never quoted** (R6). Every quote
  // this node issues names that domain, and a mismatch is invisible until the
  // provider's `claim` reverts inside the token — after the node has already
  // fronted the gas for the post. Boot-time, so the failure is a process that
  // will not start rather than a job that can never be claimed.
  await assertDomains(chain.publicClient, config.addresses);

  /**
   * The escrow's **key-lifecycle clock**, read once, here (P22).
   *
   * `ESCROW_CLOCK_OFFSET_MS` is 0 in every real deployment and the loader
   * refuses a non-zero value outside `mode: "mock"`. It exists because retention
   * is 72 h and the acceptance gate boots separate node processes: a decay test
   * cannot wait the window out and cannot reach across a process boundary to
   * replace `Date.now`. This is the one seam, and it is narrow on purpose — it
   * reaches the deadline stamped on a retired or adopted generation and the sweep
   * that erases past it, and nothing else. `/release`'s `issued_at` bound and
   * `keyEpochStart` below both keep the real clock.
   */
  const escrowClock =
    config.escrow.clockOffsetMs === 0
      ? Date.now
      : () => Date.now() + config.escrow.clockOffsetMs;

  // Two clocks, on purpose and in exactly one place: the key-lifecycle clock
  // carries the mock offset, and real time is what floors a peer-supplied
  // adoption deadline (S2). They are the same function whenever the offset is 0,
  // which the loader enforces outside `mode: "mock"` (P22). See `KeyManager`.
  // Three shapes of key custody, and the mode picks one: no keys at all; keys
  // derived from the operator credential, identical on every instance and
  // recomputed at every boot; or keys minted in this process and nowhere else.
  const escrowKeys =
    config.escrow.mode === "off"
      ? null
      : config.escrow.mode === "static"
        ? new StaticKeyManager(config.escrow.operatorKeys)
        : new KeyManager(escrowClock, Date.now);

  /**
   * **When this node's custody of key material began** (I8/P — defined here, in
   * Task 5, not in Task 6, which owns only the book filter that reads `block`).
   *
   * An instance booting with **no inherited keys** records `{time: now, block:
   * head at boot}`. That tuple is what `/release`'s orphan predicate compares an
   * order's expiry against, and what a peer adopts as `min(own, peer's)` when it
   * joins — holding the union of two instances' keys means the **earlier** epoch
   * is the one that bounds orphanhood.
   *
   * The same head the indexer follows, so the marker names a block the book
   * admits: the comparison this half feeds is against `posted_block`, which is a
   * projection column.
   *
   * Mutable, and exposed to the routes as a **function** — a handover replaces it,
   * and a value captured at route-registration time would be the wrong one for
   * the rest of the process's life.
   */
  let keyEpochStart: KeyEpochStart | null = null;

  if (escrowKeys !== null) {
    keyEpochStart = await bootEscrow(chain, config, escrowKeys);
  }

  const indexer = startIndexer(chain, db, config);
  const app = buildApp({
    db,
    indexer,
    config,
    chain,
    escrowKeys: escrowKeys ?? undefined,
    // **Deliberately not `escrowClock`** (P22, S8). The offset reaches the key
    // lifecycle and nothing else: the routes keep real time, because
    // `/release`'s ±600 s `issued_at` bound runs on this clock and a shifted one
    // would answer `stale_issued_at` to every honest request. The deadline path
    // S8 found split is fixed at its own end — `handover.ts` projects from
    // `keys.now()`, the key manager's clock, rather than from this one.
    escrowKeyEpochStart: () => keyEpochStart,
    logger: true,
  });

  if (config.escrow.mode === "mock") {
    // Where an operator actually finds out. Mock evidence is a pure function of
    // a public key, so anyone can compute it — which collapses every rung of
    // `POST /handover`'s ladder that is supposed to establish *what code* is
    // asking. The operator signature still stands, so this is no longer "to
    // whoever asks first"; it is every DEK this escrow holds behind one
    // environment variable, on a node whose attestation half proves nothing.
    app.log.warn(
      "ESCROW_MODE=mock: this node serves forgeable attestation evidence and is for " +
        "development and CI only. It must never be reachable from the internet.",
    );
  }

  if (escrowKeys instanceof StaticKeyManager) {
    // The public half and a count. Never the secret, and never anything that
    // narrows the credential it was derived from.
    app.log.info(
      {
        keys: escrowKeys.heldKeys().length,
        escrowPublicKey: escrowKeys.current()?.publicKey.toString("hex"),
      },
      "escrow keys derived from OPERATOR_KEY; this node mints nothing and refuses handover",
    );
  }

  if (config.escrow.clockOffsetMs !== 0) {
    // Said out loud, at `warn`, because the symptom of a forgotten offset is key
    // material vanishing early — which reads as a defect in the escrow rather
    // than as a setting somebody left behind.
    app.log.warn(
      { offsetMs: config.escrow.clockOffsetMs },
      "ESCROW_CLOCK_OFFSET_MS is set: this node's escrow key-retention clock runs ahead of " +
        "real time and retired generations are erased early. Development only.",
    );
  }

  /**
   * Erasure, on a timer (P20, `ESCROW_SWEEP_INTERVAL_MS`, default 300 000).
   *
   * The deadline on each retired generation is what bounds its life; this only
   * bounds how late the erasure happens. `unref` so a five-minute timer cannot
   * hold the process open through a SIGTERM — the sweep is housekeeping, and a
   * shutdown that waited for it would hang a container stop for no gain.
   *
   * Narrowed on the class, not on the mode. A derived key set has no `sweep`,
   * `mint` or `adoptKeys` to hand a timer, so a lifecycle wired to one fails to
   * compile rather than firing forever against a key set that cannot change.
   */
  const escrowSweep =
    !(escrowKeys instanceof KeyManager)
      ? null
      : setInterval(() => {
          const erased = escrowKeys.sweep();
          if (erased > 0) app.log.info({ erased }, "escrow generations erased");
        }, config.escrow.sweepIntervalMs);
  escrowSweep?.unref?.();

  /**
   * Rotation, on a timer (`ESCROW_ROTATE_INTERVAL_MS`, default 24 h).
   *
   * `mint()` retires the outgoing generation and keeps it: every wrap already
   * sealed to it still opens for a full retention window, and only its use for
   * *new* work ends. That is the whole point — a generation that leaked stops
   * accumulating fresh payloads within a day instead of backing every order for
   * the life of the process.
   *
   * **The cost, stated rather than discovered:** for up to one
   * `PEER_SYNC_S` after a rotation, a peer has not yet adopted the new
   * generation, so a wrap sealed to it and released against *that* peer misses
   * and classifies `unseal_failed`. The window is not new — an instance already
   * mints its own generation at boot before any peer pulls — and it is why the
   * rotation floor is far above the sync interval. It is also why a superseded
   * instance must be stopped rather than left running: nothing propagates *from*
   * a node the successor no longer pulls from.
   */
  const escrowRotate =
    !(escrowKeys instanceof KeyManager)
      ? null
      : setInterval(() => {
          const generation = escrowKeys.mint();
          app.log.info(
            { generation: generation.generation },
            "escrow generation rotated; the previous one is retired and still releases",
          );
        }, config.escrow.rotateIntervalMs);
  escrowRotate?.unref?.();

  /**
   * The standing pull from the peer, every interval (P6).
   *
   * **Symmetric by configuration.** `/handover` is a pure pull, so a pair in which
   * only one instance carries a peer URL cannot propagate a generation minted on
   * the other — "a generation minted on B reaches A" is unreachable under it. Both
   * instances carry the other's URL and each pulls; B → A is A pulling from B, the
   * same code path as A → B.
   *
   * **It runs for a successor too, not only a mirrored pair.** A successor that
   * pulled once at boot and never again would miss anything its predecessor mints
   * during the cutover overlap — and with generation rotation on a timer, that is
   * a key some client could still be sealing to. Once the predecessor is killed
   * the pull simply fails and pauses, which costs nothing.
   *
   * The first tick runs immediately rather than one interval in, so a booted pair
   * converges at once instead of after five minutes. For a node that booted with
   * `PEER_REQUIRED` this repeats the join `bootEscrow` already did; adoption
   * is idempotent, and one redundant pull is cheaper than a second code path.
   *
   * It is **not awaited and never fatal**: a dead peer pauses the sync and nothing
   * else, because a node that cannot reach its sibling can still release every key
   * it holds. The boot-critical case is `PEER_REQUIRED`, and it has already
   * been decided by the time this runs.
   */
  // The operator key is in the guard rather than asserted past it: the loader
  // already refuses a peer URL without one, so this branch is unreachable — and
  // an unreachable branch that reads `?? ""` would hand the signer an empty key
  // and blame the operator for a wiring defect.
  const peerSync =
    !(escrowKeys instanceof KeyManager) ||
    config.escrow.peerUrl === null ||
    config.escrow.operatorKeys.length === 0
      ? null
      : startPeerSync({
          peerUrl: config.escrow.peerUrl,
          keys: escrowKeys,
          releaseOrdinal: config.escrow.releaseOrdinal,
          signAuth: handoverAuthSigner(config.escrow.operatorKeys[0], config.addresses.chainId),
          intervalMs: config.escrow.peerSyncMs,
          keyEpochStart: () => keyEpochStart,
          onEpoch: (epoch) => {
            keyEpochStart = minKeyEpochStart(keyEpochStart, epoch);
          },
          onSync: (result) =>
            app.log.debug({ adopted: result.adopted }, "escrow peer sync"),
          onError: (error) =>
            app.log.warn({ err: error }, "escrow peer sync failed; the peer link is paused"),
        });
  void peerSync?.tick();

  // The crash window between accepting a push and proving it published: a row
  // with `signed_at > published_signed_at` is a book this node promised a
  // provider and did not deliver, and nothing else would ever notice — the
  // provider has no reason to push again until its prices change. Deliberately
  // **not** awaited: it is sequential and takes one relay slot at a time, so
  // letting it delay `listen()` would trade a prompt readiness for a sweep
  // nobody is waiting on. It never throws (see `startPublisher`); the `.catch`
  // is for the query itself.
  void startPublisher(chain, db, config, (error, providerId) =>
    app.log.error({ err: error, providerId }, "ask republication failed"),
  ).catch((error: unknown) => app.log.error({ err: error }, "ask publisher sweep failed"));

  // Housekeeping: expired `sessions` and `nonces` rows, hourly.
  //
  // Both tables are TTL state and neither is derived from the chain, so nothing
  // else will ever remove a row from them — an expired session is invisible to
  // every reader (`readSession` filters on `expires_at`) and would otherwise sit
  // there forever. `GET /auth/nonce` needs no credential, which makes `nonces`
  // the one table an unauthenticated caller can grow; the per-address cap in
  // `issueNonce` bounds one caller and this bounds the rest.
  const sweep = startSweep(db, (error) => app.log.error({ err: error }, "sweep failed"));

  const pinner = pinnerFor(config, db);

  /**
   * Expired files and their objects, every minute (`src/pin/sweep.ts`).
   *
   * The other half of the upload door: every row it writes carries an expiry, and
   * this is what honours it. Without it an upload nobody attached is storage this
   * node pays for forever, and `FILE_RETENTION_SECONDS` is a setting that does
   * nothing.
   */
  const fileSweep = startFileSweep(db, pinner, config.fileRetentionSeconds, (error, cid) => {
    // Two different failures. One object the store would not delete is an
    // object the next tick retries; a pass that threw got no further than
    // wherever it threw, and the rows it had already deleted are gone.
    if (cid === undefined) app.log.error({ err: error }, "file sweep pass failed");
    else app.log.error({ err: error, cid }, "file sweep failed to remove an object");
  }, undefined, (run) => {
    // Only when a pass took its full batch. One is ordinary — a burst of
    // expiries, a node that was down. A run of them is the only signal that the
    // backlog is growing faster than SWEEP_BATCH per interval drains it.
    if (run.saturated) app.log.warn(run, "file sweep pass hit its batch bound");
  });

  /**
   * The batch worker: split, pin, `postMany`, then freeze the two output files.
   *
   * A background pass rather than part of `POST /v1/batches`, and it has to be:
   * 50 000 lines is 50 000 objects filed against a service rate-limited to 100
   * requests a second, which is eight minutes before a transaction is signed.
   * The create door answers `validating` and this moves it on.
   *
   * `unref`ed inside, so it cannot hold a container stop open, and re-entrant-safe
   * because one pass can outlast the interval.
   */
  const batchWorker = startBatchWorker(
    { db, config, chain, pinner },
    (error, batchId) => app.log.error({ err: error, batchId }, "batch worker pass failed"),
    BATCH_WORKER_INTERVAL_MS,
  );

  /**
   * The `reclaim` keeper — the one automatic on-chain write this node makes.
   *
   * It has no privilege: it uses the relayer wallet, which has no standing in
   * either registry, and `reclaim` takes no signature at all. Anyone with a
   * funded account could do exactly this, which is why running it is
   * uncontroversial — and why *someone* has to, since the client whose capital is
   * locked is usually offline and the provider that abandoned the job has no
   * reason to volunteer. Left to nobody, escrow sits locked and the −40
   * abandonment penalty never lands.
   *
   * The first pass runs immediately rather than a minute in, so a node restarted
   * after an outage clears the backlog it inherited straight away.
   */
  const reclaimKeeper = startReclaimKeeper(
    { db, config, chain },
    (error: unknown, jobId: string) =>
      app.log.error({ err: error, jobId }, "reclaim keeper pass failed"),
  );
  void reclaimKeeper.tick();

  /**
   * The relayer's gas balance, reported while it is low and before it is empty.
   * An empty one is reported from the error handler, on the send that hit it.
   * The first read runs at boot, so a node started on a low wallet says so at once.
   */
  const relayerBalance = startRelayerBalanceWatch(
    chain,
    config.relayerLowBalanceGwei,
    (balance) =>
      app.log.error(
        { relayer: chain.account.address, balanceWei: balance.toString() },
        "relayer balance is low; top it up before relays stop",
      ),
    (error) => app.log.warn({ err: error }, "relayer balance read failed"),
  );
  void relayerBalance.tick();

  // Nothing else stops the indexer, so shutdown is owned here.
  //
  // The server and the poll loop are quiesced together — neither waits on the
  // other — and the pool is closed only once both are quiet, so no connection is
  // pulled out from under a draining request or an advance still in flight.
  // `allSettled`, because a failure in one of them must not leave the other
  // running: a half-closed process is the one that hangs a container stop.
  let closing: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> =>
    (closing ??= (async () => {
      app.log.info({ signal }, "shutting down");
      sweep.stop();
      fileSweep.stop();
      batchWorker.stop();
      reclaimKeeper.stop();
      relayerBalance.stop();
      if (escrowSweep !== null) clearInterval(escrowSweep);
      if (escrowRotate !== null) clearInterval(escrowRotate);
      peerSync?.stop();
      const settled = await Promise.allSettled([app.close(), indexer.stop()]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") app.log.error({ err: outcome.reason }, "shutdown");
      }
      await db.close();
      await Sentry.flush(2000);
    })().catch((error: unknown) => {
      // The last resort: an unhandled rejection here would turn an orderly stop
      // into a crash, which is the failure shutdown exists to avoid.
      app.log.error({ err: error }, "shutdown failed");
    }));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // 0.0.0.0, not the default loopback: the node is containerised, and a server
  // bound to 127.0.0.1 inside a container is unreachable from outside it.
  await app.listen({ port: config.port, host: "0.0.0.0" });

  try {
    await indexer.start();
  } catch (error) {
    // The port is open at this point, so an unhandled failure here would leave a
    // process that answers `503 not_ready` forever: alive to a supervisor, and
    // never going to index, because `start()` is one-shot. `shutdown` closes the
    // server, the loop and the pool; rethrowing sets the exit code, and with
    // nothing left holding the loop open the process ends.
    app.log.error({ err: error }, "cold start failed; shutting down");
    await shutdown("cold-start-failure");
    throw error;
  }
}

main().catch(async (error: unknown) => {
  console.error("vorq-coordinator-node failed to start", error);
  process.exitCode = 1;
  Sentry.captureException(error);
  await Sentry.flush(2000);
});
