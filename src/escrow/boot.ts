import { slaFacts, type Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import { joinPeer } from "./handover.js";
import { KeyManager, assertEscrowSoundness, type EscrowKeys } from "./keys.js";
import { handoverAuthSigner } from "./operator.js";
import type { KeyEpochStart } from "./release.js";

/**
 * The operator key, or a refusal naming the variable.
 *
 * **The first entry signs.** The rest of the list exists only so a holder can
 * still accept a predecessor's key across a rotation; nothing outbound uses them.
 *
 * `loadEscrow` already refuses an empty list at any mode that holds keys, so
 * reaching this with one is a wiring defect rather than a misconfiguration — but
 * an index into a possibly-empty array would be the kind of claim that survives
 * the refactor that invalidates it.
 */
function requireOperatorKey(config: Config): string {
  const [key] = config.escrow.operatorKeys;
  if (key === undefined) {
    throw new Error(
      "OPERATOR_KEY is required to pull from a peer, and the loader should already have " +
        "refused this configuration.",
    );
  }
  return key;
}

/**
 * The escrow's whole boot sequence: prove the retention window against the live
 * chain, mark the epoch, and take on a predecessor's keys if this instance is
 * joining one.
 *
 * **The soundness inequality is asserted against live chain values, before
 * anything listens** (P3). `ESCROW_KEY_RETENTION_MS` has to outlive every order
 * that could still name a key — the client's cache grace, plus the chain's
 * `MAX_EXPIRY`, plus the SLA a provider gets to deliver in — and two of those
 * three terms live on chain and can move without this code changing. A comment
 * asserting soundness is not soundness, so the assertion is a real one and a
 * violation is a process that does not start: this rejects, `main` awaits it
 * above `app.listen`, nothing binds a port, and a supervisor sees a failed boot
 * rather than a node quietly holding keys it will erase too early. `main` skips
 * it entirely at `mode: "off"`, because a node that holds no key material has no
 * retention window to be unsound about.
 *
 * **A module of its own, so the refusal is testable** (S4). This was six lines
 * inline in `main.ts`, where the only thing that could see the property "a
 * violation is a process that does not start" was an assertion on the *text* of
 * that file — which `.catch(() => {})` satisfies word for word, and which is
 * exactly what a later author writes the first time a slow RPC endpoint makes
 * boot flaky. A refusal no test can distinguish from a warning is the same
 * defect P3 exists to close, one level up. It lives here rather than in
 * `main.ts` because importing `main.ts` **runs the node**: a test that reached
 * in for this function would open a database pool as a side effect.
 *
 * Nothing here is caught, and nothing here should be. The epoch marker is
 * **returned** rather than assigned, so a caller that swallowed the rejection
 * would have no marker to carry on with and would not type-check.
 *
 * `join` is injected for the same testability reason and defaults to the real
 * one; production passes nothing.
 */
export async function bootEscrow(
  chain: Chain,
  config: Config,
  keys: EscrowKeys,
  join: typeof joinPeer = joinPeer,
): Promise<KeyEpochStart | null> {
  /**
   * **A derived key set has no boot.** No mint, no soundness window, no peer to
   * join, and — the load-bearing part — **no epoch**.
   *
   * `keyEpochStart` marks when this node's custody of key material began, and
   * both predicates that read it exist because a restart destroys that material.
   * Here a restart destroys nothing: the process comes back holding exactly the
   * keys it held before, recomputed from an environment that did not change. An
   * epoch stamped here would be a false custody boundary — every open job posted
   * before the last redeploy would drop out of the book, and `/release` would
   * answer `escrow_key_lost` for wraps this process can open on the next line.
   *
   * The soundness inequality is skipped for want of a subject: it bounds when a
   * key is *erased* against how long an order can still name it, and nothing
   * here is ever erased. Running it anyway would put ~140 `eth_call`s and
   * `MAX_EXPIRY` between this node and its port, for a conclusion that cannot
   * apply to it.
   *
   * Narrowed on the class rather than on `config.escrow.mode` because the class
   * is what actually decides: everything below calls `boot()` and `mint()`, and
   * a key set without them must not reach them.
   */
  if (!(keys instanceof KeyManager)) return null;

  await assertEscrowSoundness(slaFacts(chain, config.addresses.jobRegistry));

  const epoch: KeyEpochStart = { time: Date.now(), block: await chain.headBlock() };
  const { peerUrl, peerRequired } = config.escrow;

  // No peer, or a peer this node will catch up with on its own timer. Either way
  // it mints now and serves immediately: a replica pair carries each other's URL,
  // so a boot that waited on the peer would deadlock the pair, and the standing
  // pull started in `main` closes the gap within one interval.
  if (peerUrl === null || !peerRequired) {
    keys.boot();
    return epoch;
  }

  // A successor inheriting from a live predecessor. The mint is **deferred**
  // until after the adoption: minting first would advertise an orphan generation
  // for the length of the join, and any order posted against it names a key this
  // node never records as current.
  //
  // A failure here stops the process, deliberately. A successor that silently
  // booted fresh would answer `unseal_failed` for every wrap sealed to the
  // predecessor's keys, with nothing anywhere to notice.
  keys.boot({ mint: false });
  const joined = await join({
    peerUrl,
    keys,
    releaseOrdinal: config.escrow.releaseOrdinal,
    keyEpochStart: epoch,
    signAuth: handoverAuthSigner(requireOperatorKey(config), config.addresses.chainId),
  });
  keys.mint();
  return joined.keyEpochStart ?? epoch;
}
