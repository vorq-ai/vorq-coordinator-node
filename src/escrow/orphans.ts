import type { EscrowMode } from "../config.js";
import type { KeyEpochStart } from "./release.js";

/**
 * Escrow-orphaned jobs, and the one clause that stops the book advertising them.
 *
 * A job posted before this node's custody of its key material began carries a
 * wrap that can only name a key this node no longer holds. Nothing can recover
 * it: `/release` answers `escrow_key_lost` (Task 4) and the provider's only exit
 * is `fail` inside `FAIL_GRACE`. Advertising such a job as claimable is
 * therefore an invitation to do work that cannot be done, and the remedy is to
 * stop advertising it.
 *
 * **A dropped job is not a deleted job**, and every part of this file depends on
 * that being true. The chain rows stand, the projection keeps them byte for
 * byte, the detail routes still serve them, and `POST /evm/ops` still relays a
 * claim against one. All that changes is that this node no longer *offers* the
 * job. A provider reading the chain directly can still claim it — and then gets
 * the typed refusal from `/release` and exits penalty-free, which is the
 * designed outcome rather than a gap in this filter.
 *
 * ## Its relationship to Task 4's predicate
 *
 * There are two orphan predicates in this codebase and they are deliberately not
 * the same function:
 *
 *   * **`isEscrowOrphan` (`release.ts`) is chain-only**, because P7 forbids
 *     `/release` from reading Postgres. `JobView` carries no posting block, so it
 *     proves the posting predates the epoch through `expiresAt < epoch.time` — an
 *     order cannot be posted with an expiry already past, so an expiry before the
 *     epoch puts the posting before it too. Sufficient, never necessary.
 *   * **this one reads `posted_block`**, because the book reads the projection
 *     anyway and the column is right there. It is the direct measurement the
 *     other one has to infer.
 *
 * The difference is sound because the two answer different questions on
 * different surfaces, and each errs the safe way for its own:
 *
 *   * `/release` must never say "your key is gone" about a live job, so its
 *     predicate is one-sided towards *not* orphaned — the ambiguous band (posted
 *     before the epoch, expiring after it) classifies as `unseal_failed`.
 *   * the book is free to be *stricter*: it catches that same ambiguous band,
 *     because `posted_block` measures the posting directly. Hiding a job the
 *     release path would still attempt costs nothing — the job's wrap is dead
 *     either way, and the worst case of hiding it is that a claim is never made
 *     that would have failed.
 *
 * So this predicate is a **superset** of Task 4's on the jobs both can see, and
 * the containment runs in the harmless direction: the book hides everything
 * `/release` calls lost, plus the band `/release` is careful not to accuse. The
 * two never disagree in a way that costs a provider funds, because neither ever
 * reports a job whose key this node still holds.
 */

/**
 * `posted_block = 0` means **unknown**, never **ancient** (I9).
 *
 * `reconcileJob` upserts a row from `getJob`, which carries no posting block, so
 * a row inserted ahead of its indexed log takes the column's `DEFAULT 0` until
 * the reducer's `Posted` corrects it. Jobs this node posts are written through
 * from their receipt with their real block, so the 0 is reached on a refusal's
 * repair of a job the index has not reduced yet — still among the newest jobs in
 * the book — and reading it as a block number would hide them, silently. `posted_block > 0` is
 * what keeps "the log has not landed yet" out of "posted before this node's
 * keys".
 *
 * **Exported because it now has a second caller.** `GET /evm/jobs`'s
 * `posted_before` filter is the same question asked for a different reason —
 * "is this bid old?" rather than "does this node hold its key?" — and it has the
 * same wrong answer available to it: an unreduced row reads as block 0 and so
 * satisfies *every* age bound, presenting the newest jobs in the book as the
 * oldest. One definition, so the two cannot drift; the constant lives here
 * because this is where I9 is written down.
 */
export const POSTING_KNOWN = "posted_block > 0";

/**
 * Whether the filter applies at all.
 *
 * Two conditions, and both are refusals to guess:
 *
 *   * **`mode = off`** — a local node mints no keys and has no `keyEpochStart`,
 *     so it has no custody boundary and nothing to hide behind one. A node that
 *     hid jobs while hosting no escrow would be dropping work for a reason that
 *     does not apply to it.
 *   * **no epoch** — absent is no information, never zero. A node that cannot
 *     say when its keys began must not claim any job predates them.
 */
export function orphanFilterApplies(
  mode: EscrowMode,
  epoch: KeyEpochStart | null,
): epoch is KeyEpochStart {
  return mode !== "off" && epoch !== null;
}

/**
 * The book's orphan clause, or `null` when nothing is to be filtered.
 *
 * `open` is the caller's own openness expression rather than one written here:
 * openness is computed and never stored (R3/R43), the edge is exact to the
 * second (R78 — `expires_at >= now` is still open), and this project has already
 * been bitten once by two copies of that rule disagreeing. The book passes its
 * `OPEN` constant in, so there is one definition and this clause cannot drift
 * from the listing it constrains.
 *
 * `bind` is the caller's parameter binder, so the block number crosses as a
 * bound parameter and never as interpolated text.
 *
 * The shape is a `NOT (…)` over a conjunction, and every member earns its place:
 *
 *   * **open** — the filter suppresses *advertising*, and only an open job is
 *     advertised. A claimed, settled or expired orphan still lists: its row is
 *     history, no provider can take it, and hiding it would make the book
 *     disagree with the chain about what happened.
 *   * **`designated = 0`** — a designated job's wrap was sealed to a provider's
 *     own key and this escrow never held it, so its posting date says nothing
 *     about this node's custody. This is the case implementations get wrong, and
 *     getting it wrong hides jobs that are perfectly claimable.
 *   * **`posted_block > 0`** — I9, above.
 *   * **`posted_block < epoch.block`** — strictly. A job posted *in* the epoch
 *     block is served: the epoch block is the head at the instant the
 *     keys were minted, and a posting inside that block could fall on either
 *     side of the mint. Equality proves nothing, and the tie goes to advertising
 *     the job, matching the release path's own strictness.
 */
export function orphanBookFilter(
  mode: EscrowMode,
  epoch: KeyEpochStart | null,
  open: string,
  bind: (value: unknown) => string,
): string | null {
  if (!orphanFilterApplies(mode, epoch)) return null;
  return (
    `NOT (${open} AND designated = 0 ` +
    `AND ${POSTING_KNOWN} AND posted_block < ${bind(epoch.block)})`
  );
}
