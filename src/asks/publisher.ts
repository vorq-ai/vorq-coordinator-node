import { encodeFunctionData, parseEventLogs, type Hex } from "viem";
import { askRegistryAbi } from "../abi/askRegistry.js";
import { viewRead } from "../api/chain-failure.js";
import { ApiError } from "../api/errors.js";
import type { Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import type { Db, Queryable } from "../db/db.js";
import { parseStoredSnapshot, type Snapshot } from "./push.js";

/**
 * Immediate publication of an accepted push, and the crash-window sweep at boot.
 *
 * **Immediate mode only.** Every accepted push is relayed as its own
 * `setAsks([snapshot],[sig])` from the relayer key, and the row is marked
 * published only once the chain has proved it landed (R29).
 *
 * ## Why there is no pre-relay simulate here, unlike every other write door
 *
 * `setAsks` is **skip-not-revert per entry**: a snapshot that is oversized,
 * skewed, forged, misaddressed or stale is silently dropped and the transaction
 * still succeeds. An `eth_call` of `setAsks` therefore cannot refuse anything —
 * it returns cleanly for a batch that will land nothing at all — so a simulate
 * would cost a round trip and buy no information. The checks that would have
 * been a simulate are made *before* the push is accepted, against the contract's
 * own skip conditions, and the confirmation below is what replaces the simulate
 * on the far side.
 *
 * ## R29: a successful `setAsks` transaction proves nothing
 *
 * The receipt says the *call* ran. It does not say this provider's entry was
 * applied. So `published_signed_at` is written from exactly two proofs, never
 * from the receipt's status:
 *
 *   1. an `AsksPublished` log **from the AskRegistry**, naming this provider at
 *      this `signedAt` or later — the entry was not skipped;
 *   2. failing that, a re-read of `lastSignedAt(providerId)` at or past
 *      `signedAt` — the chain's own monotonic floor moved, which only the write
 *      can have done.
 *
 * If neither holds, the entry was skipped and the row stays unpublished. That
 * matters more than it looks: recording a skipped snapshot as published would
 * raise this node's floor above the chain's **permanently**, and every later
 * honest push from that provider would be refused as stale by a floor no chain
 * state supports. The failure is unrecoverable without a manual edit, which is
 * why the proof is demanded rather than assumed.
 */

/** How long the publisher waits for a receipt, matching the other write doors. */
const RECEIPT_TIMEOUT_MS = 60_000;

/**
 * How many unpublished rows one boot sweep re-submits.
 *
 * The sweep is strictly sequential — one relay at a time, so it occupies one
 * slot of `RELAY_MAX_DEPTH` and never competes with itself — and this
 * bounds how long it can run. The row count is the number of providers that
 * pushed and were not confirmed, which is bounded by the provider set and
 * therefore by nobody: registering a provider is open to anyone. 1024 rows at a
 * devnet block time is a couple of minutes of background work; past that the
 * remainder waits for the next boot or for the provider's next push, both of
 * which are ordinary events. Stated rather than argued unreachable.
 */
export const MAX_BOOT_REPUBLISH = 1024;

/** A row of `quotes_live`, as the publisher needs it. */
export interface StoredSnapshot {
  providerId: bigint;
  signedAt: bigint;
  /**
   * The snapshot's **values**, as `quotes_live` holds them (R54a).
   *
   * Not the bytes that were written, and no schema on a `jsonb` column could
   * make them so: Postgres normalises `jsonb`, reordering keys and inserting a
   * space after each `:`. What survives exactly is what the signature is over —
   * every member is a decimal string, so the round trip is lossless without
   * being byte-preserving. The `::text` cast in the boot sweep's `SELECT` is
   * still mandatory, for a reason that has nothing to do with byte
   * preservation: without it the driver hands back an **object** and
   * `JSON.parse` throws, which the sweep's per-row `catch` would swallow.
   */
  snapshot: Snapshot;
  signature: Buffer;
}

/** What the chain proved about one publication attempt. */
export type PublishOutcome =
  /** An `AsksPublished` log for this provider, or `lastSignedAt == signed_at`. */
  | { kind: "published"; txHash: Hex }
  /** `lastSignedAt > signed_at`: a newer snapshot won, this one can never land. */
  | { kind: "superseded"; txHash: Hex; lastSignedAt: bigint }
  /** The transaction mined and proved nothing: no log, and `lastSignedAt` still behind. */
  | { kind: "skipped"; txHash: Hex; lastSignedAt: bigint };

/**
 * The `setAsks` calldata for one snapshot, encoded from the stored values (R54a).
 *
 * The **values** are the calldata, never a re-read of the book and never a price
 * this node composed. That is what makes it checkable rather than a convention:
 * if the row and the signature ever disagreed, the chain would refuse the entry,
 * and the same rule would have relayed the same disagreement at boot.
 *
 * The two callers reach that guarantee differently, and only one of them can
 * re-read. The **boot sweep** parses the row out of `quotes_live`, which is the
 * path where the property matters: the process that stored it is gone, and the
 * row is the only account of what the provider signed. The **immediate path**
 * hands over the request object it just stored — `snapshotText` is
 * `JSON.stringify` of exactly that object, so the row and the calldata are
 * provably the same values and cannot diverge, and a re-read would cost a round
 * trip to learn nothing.
 */
export function setAsksCalldata(row: StoredSnapshot): Hex {
  const { snapshot } = row;
  return encodeFunctionData({
    abi: askRegistryAbi,
    functionName: "setAsks",
    args: [
      [
        {
          providerId: Number(snapshot.provider_id),
          signedAt: BigInt(snapshot.signed_at),
          quotes: snapshot.quotes.map((quote) => ({
            modelId: Number(quote.model_id),
            sla: Number(quote.sla),
            rateIn: BigInt(quote.rate_in),
            rateOut: BigInt(quote.rate_out),
          })),
        },
      ],
      [`0x${row.signature.toString("hex")}` as Hex],
    ],
  });
}

/** `AskRegistry.lastSignedAt(providerId)` — the chain's own monotonic floor. */
export async function lastSignedAtOf(
  chain: Chain,
  config: Config,
  providerId: bigint,
): Promise<bigint> {
  // R77 lives inside the read, not at the two call sites: `PUT /evm/asks` wraps
  // its failure in `sendFailure(…, "relayer")`, whose relayer branch answers a
  // reverting read `400 invalid_request` — a verdict on a view read, on a door
  // where the node builds and funds the transaction. `lastSignedAt` is a storage
  // getter on a frozen contract; it reverts when this node is misconfigured or
  // when the endpoint reports unavailable historical state as a revert, and
  // neither is anything the provider's snapshot did wrong.
  const value = await viewRead("ask_floor_read", () =>
    chain.publicClient.readContract({
      address: config.addresses.askRegistry,
      abi: askRegistryAbi,
      functionName: "lastSignedAt",
      // `uint32` on chain, and exactly representable as a double.
      args: [Number(providerId)],
    }),
  );
  return BigInt(value);
}

/**
 * Did this receipt carry an `AsksPublished` for this provider at this `signedAt`?
 *
 * Filtered on the AskRegistry's own address first: a receipt's logs are every
 * log the transaction produced, and trusting a log by its topic alone would let
 * any contract the transaction happened to touch claim a publication.
 */
function landed(logs: readonly unknown[], row: StoredSnapshot, config: Config): boolean {
  const mine = (logs as { address?: string }[]).filter(
    (log) => (log.address ?? "").toLowerCase() === config.addresses.askRegistry.toLowerCase(),
  );
  const events = parseEventLogs({
    abi: askRegistryAbi,
    eventName: "AsksPublished",
    // The narrowed shape viem wants; the filter above is what makes it safe.
    logs: mine as never,
  });
  return events.some(
    (event) =>
      // `providerId` is an indexed `uint32` and decodes as a **number**, so this
      // crosses to bigint deliberately: `7n === 7` is `false` and would report
      // every publication as skipped (R49a).
      BigInt(event.args.providerId) === row.providerId && event.args.signedAt >= row.signedAt,
  );
}

/**
 * Stores an accepted snapshot, and **never walks `signed_at` back** (B-8).
 *
 * Here rather than in the route because this is the second writer of a column
 * {@link markPublished} already guards, and the two guards belong where they can
 * be read together: every write to `quotes_live`'s monotonic pair is in this
 * file, and both carry the comparison that makes it monotonic.
 *
 * The race it closes: `PUT /evm/asks` reads the stored `signed_at`, refuses a
 * stale push, and then writes — two statements, no `subjectQueue` on that door,
 * so two pushes from one provider can interleave between them and the older
 * one's write can land last. There is no on-chain consequence (the chain's own
 * floor and `published_signed_at < $2` both still hold), and the row disagreeing
 * with what was published is worth one `WHERE`.
 *
 * `<=` rather than `<`: an identical re-push of a snapshot stored but never
 * proved published is legitimate, and it must still refresh `received_at`.
 */
export async function storeSnapshot(
  db: Queryable,
  providerId: bigint,
  snapshotText: string,
  signature: Buffer,
  signedAt: bigint,
): Promise<void> {
  await db.query(
    `INSERT INTO quotes_live (provider_id, snapshot, signature, signed_at)
          VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (provider_id) DO UPDATE
          SET snapshot = EXCLUDED.snapshot,
              signature = EXCLUDED.signature,
              signed_at = EXCLUDED.signed_at,
              received_at = now()
        WHERE quotes_live.signed_at <= EXCLUDED.signed_at`,
    [providerId, snapshotText, signature, signedAt],
  );
}

/** Raises `published_signed_at`, never lowers it. */
async function markPublished(db: Queryable, providerId: bigint, signedAt: bigint): Promise<void> {
  await db.query(
    // The `<` guard is what makes this safe against a concurrent publication of
    // a *newer* snapshot: a late confirmation must never walk the floor back.
    "UPDATE quotes_live SET published_signed_at = $2 WHERE provider_id = $1 AND published_signed_at < $2",
    [providerId, signedAt],
  );
}

/**
 * Relays one snapshot and records what the chain proved.
 *
 * Failures propagate: the relay's own errors are classified by the caller with
 * `sendFailure(error, null, "relayer")` (R70, R72), because this transaction is
 * built and funded by the node.
 */
export async function publishSnapshot(
  chain: Chain,
  db: Db,
  config: Config,
  row: StoredSnapshot,
): Promise<PublishOutcome> {
  const txHash = await chain.relay({
    to: config.addresses.askRegistry,
    data: setAsksCalldata(row),
  });

  // The receipt wait is caught **here** rather than left to the caller's
  // `sendFailure`. A viem timeout carries no numeric `code` anywhere in its
  // `cause` chain, so the generic classifier reaches its "nothing answered"
  // branch and answers `503 chain_unreachable`, retryably — about a transaction
  // that is already on the wire and may well mine, and about an RPC endpoint
  // that is perfectly healthy. A provider daemon reading `x-vorq-retryable:
  // true` would re-push, `retryOfUnpublished` would admit the identical
  // `signed_at`, and the node would broadcast and pay for a **second**
  // transaction for the same snapshot. `504 receipt_timeout` is not retryable
  // and says the one true thing: poll, do not re-send (R57, R70). The route
  // re-throws an `ApiError` unchanged, which is what carries it out.
  let receipt;
  try {
    receipt = await chain.receipt(txHash, RECEIPT_TIMEOUT_MS);
  } catch {
    throw new ApiError(
      504,
      "receipt_timeout",
      `transaction ${txHash} was broadcast but no receipt arrived within ${RECEIPT_TIMEOUT_MS} ms; ` +
        "the snapshot is stored unpublished and the boot sweep will resolve it — " +
        "poll for it rather than re-pushing",
      null,
      txHash,
    );
  }

  if (landed(receipt.logs, row, config)) {
    await markPublished(db, row.providerId, row.signedAt);
    return { kind: "published", txHash };
  }

  // Proof 2. The log is the direct evidence; this is the fallback for a receipt
  // whose logs a proxy or a light client did not carry.
  const floor = await lastSignedAtOf(chain, config, row.providerId);
  if (floor === row.signedAt) {
    await markPublished(db, row.providerId, row.signedAt);
    return { kind: "published", txHash };
  }
  if (floor > row.signedAt) {
    // A newer snapshot for this provider landed first, so this one was skipped
    // and can never land. Marked anyway — not because it was published, but
    // because the chain has moved past it and the boot sweep must not re-submit
    // it on every boot for the rest of the node's life.
    await markPublished(db, row.providerId, row.signedAt);
    return { kind: "superseded", txHash, lastSignedAt: floor };
  }
  return { kind: "skipped", txHash, lastSignedAt: floor };
}

/**
 * Re-submits every row the node accepted but never proved published.
 *
 * This is the crash window the brief names: the push is stored and then relayed,
 * so a process that dies between the two leaves a row with
 * `signed_at > published_signed_at` and a provider whose book is a promise this
 * node made and did not keep. Nothing else would ever notice — the provider has
 * no reason to push again until its prices change.
 *
 * **Immediate mode only, so there is no interval and nothing to stop**: the
 * whole of "start" is this sweep. It is sequential on purpose (one relay slot,
 * never a burst of them) and it never throws: a row that cannot be published now
 * is left exactly as it was, for the next boot or the provider's next push.
 */
export async function startPublisher(
  chain: Chain,
  db: Db,
  config: Config,
  log: (error: unknown, providerId: bigint) => void = () => undefined,
): Promise<{ resubmitted: number; unresolved: number }> {
  const { rows } = await db.query<{
    provider_id: bigint;
    snapshot: string;
    signature: Buffer;
    signed_at: bigint;
  }>(
    `SELECT provider_id, snapshot::text AS snapshot, signature, signed_at
       FROM quotes_live
      WHERE signed_at > published_signed_at
      ORDER BY signed_at
      LIMIT $1`,
    [MAX_BOOT_REPUBLISH],
  );

  let resubmitted = 0;
  let unresolved = 0;

  for (const row of rows) {
    try {
      const outcome = await publishSnapshot(chain, db, config, {
        providerId: row.provider_id,
        signedAt: row.signed_at,
        snapshot: parseStoredSnapshot(row.snapshot),
        signature: row.signature,
      });
      if (outcome.kind === "skipped") unresolved += 1;
      else resubmitted += 1;
    } catch (error) {
      // One provider's snapshot must not stop the sweep, and a boot must not
      // fail because the chain is briefly unreachable: the row is still there.
      unresolved += 1;
      log(error, row.provider_id);
    }
  }

  return { resubmitted, unresolved };
}
