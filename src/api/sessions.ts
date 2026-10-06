import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "../db/db.js";

/**
 * The session handshake's storage: one-shot nonces and bearer sessions.
 *
 * Both tables are **not** derived from the chain, and both are pure TTL state.
 * That makes them the one part of the projection a drop-and-rebuild may lose
 * without consequence (R44 names `pins` and `quotes_live` as the tables that
 * must survive; these two must merely be *re-earnable*, and they are — a client
 * that loses its session re-handshakes, which is exactly what it already does
 * when a token expires).
 *
 * Everything here is written against one hazard: **these are the only tables an
 * unauthenticated caller can make rows in.** `GET /auth/nonce` needs no
 * credential — it cannot, it is the first step of acquiring one — so nonce
 * issuance is a write door open to the internet. The bounds are stated on each
 * function and summarised in the task report.
 */

/** Nonce lifetime, seconds. Global Constraints. */
export const NONCE_TTL_SECONDS = 300;

/** Session lifetime, seconds. Global Constraints. */
export const SESSION_TTL_SECONDS = 86_400;

/**
 * Live nonces one address may hold at once.
 *
 * A client asks for a nonce and signs it; more than a handful in flight means
 * something is retrying, not something legitimate. Issuing the 17th nonce for an
 * address drops that address's oldest, so a single address cannot grow the table
 * without bound however fast it asks. What this does **not** bound is the number
 * of distinct addresses — an address is 20 free bytes — so the table's real
 * ceiling is `16 × addresses seen since the last sweep`, where the **sweep** is
 * the hourly one: nothing removes an expired row belonging to an address that
 * never returns, so the 300 s TTL bounds a nonce's *usefulness*, not its
 * residency (R68). See the report.
 */
const MAX_LIVE_NONCES_PER_ADDRESS = 16;

/**
 * Live sessions one address may hold at once.
 *
 * Higher than the nonce cap because a session is a working credential rather
 * than a step in acquiring one: a provider fleet sharing one operator key holds
 * one per process, and evicting a worker's token would be a silent failure. 32
 * covers that and still turns *"400 accepted from one keypair at 90/s, and
 * nothing refuses the 400th"* into a table that cannot exceed 32 rows for that
 * keypair however long it runs.
 *
 * **The nonce cap gives this table no protection at all**, which is why the
 * absence of this one was invisible: `consumeNonce` deletes the row as the burn,
 * so a caller that spends each nonce the moment it is issued never holds two,
 * never approaches 16, and converts nonces into sessions at whatever rate it can
 * sign. The cap that looked like the bound is bypassed by using the feature
 * correctly.
 *
 * Eviction is oldest-expiry-first, so what goes is what was about to die anyway.
 */
const MAX_LIVE_SESSIONS_PER_ADDRESS = 32;

/** How often the housekeeping sweep runs. Wired in `main.ts`. */
export const SWEEP_INTERVAL_MS = 3_600_000;

/**
 * **The TTL tables, and the one place that fact is written down (R68).**
 *
 * Both tables here are made by an unauthenticated caller, both are pure TTL
 * state, both are swept by {@link sweepExpired} on the identical predicate — and
 * R68's fix reached only one of them. `nonces` got a per-address cap, an
 * `address` index and an `expires_at` index; `sessions`, written by the same
 * module and swept two lines below on the same predicate, got none of the three.
 * Nothing connected the two, so the second was not so much overlooked as never
 * asked about.
 *
 * So the list is the mechanism now, not a comment about it: the sweep iterates
 * it, {@link capPerAddress} is the only way rows are admitted to either table,
 * and `test/db.test.ts` reads `0001_init.sql` and fails a table in this list that
 * lacks either index — **and** a table with an `expires_at` column that is not in
 * this list. A third TTL table cannot be added without meeting all of it.
 */
export const TTL_TABLES = ["sessions", "nonces"] as const;

/**
 * Makes room for one more row of `address` in `table`: drops that address's
 * expired rows and its oldest live ones past `max`.
 *
 * Per address, so the statement's cost is proportional to one caller's own
 * footprint rather than to the whole table — **but only because
 * `<table>_address` exists** (R68). Scoping the predicate to one address does
 * not scope the scan: without that index this is a sequential scan of a table
 * whose size an unauthenticated caller chooses, plus a second one inside the
 * subquery, measured at 30.6 ms per request at 510 k rows and still rising.
 *
 * `table` is interpolated, and it is safe for exactly one reason: it comes from
 * {@link TTL_TABLES}, a literal tuple in this file. No caller value reaches it —
 * the signature will not accept one.
 */
async function capPerAddress(
  tx: Queryable,
  table: (typeof TTL_TABLES)[number],
  address: Buffer,
  max: number,
): Promise<void> {
  await tx.query(
    `DELETE FROM ${table}
      WHERE address = $1
        AND (expires_at <= now()
             OR ctid IN (SELECT ctid FROM ${table} WHERE address = $1
                         ORDER BY expires_at DESC OFFSET $2))`,
    [address, max - 1],
  );
}

export type Role = "client" | "provider";

export interface Session {
  token: string;
  address: Buffer;
  role: Role;
  providerId: bigint | null;
  /** Unix seconds. */
  expiresAt: bigint;
}

/**
 * Mints a nonce for `address` and returns it with its expiry in unix seconds.
 *
 * The insert is preceded by a delete that removes this address's expired nonces
 * **and** its oldest live ones past {@link MAX_LIVE_NONCES_PER_ADDRESS}.
 *
 * Doing it per address keeps the statement's cost proportional to one caller's
 * own footprint instead of to the whole table — **but only because
 * `nonces_address` exists** (R68). Scoping the predicate to one address does not
 * scope the scan: without that index this is a sequential scan of a table whose
 * size an unauthenticated caller chooses, plus a second one inside the subquery,
 * and it was measured at 30.6 ms per request at 510 k rows and still rising.
 */
export async function issueNonce(
  db: Db,
  address: Buffer,
): Promise<{ nonce: string; expiresAt: bigint }> {
  const nonce = randomBytes(16).toString("hex");

  const { rows } = await db.tx(async (tx) => {
    await capPerAddress(tx, "nonces", address, MAX_LIVE_NONCES_PER_ADDRESS);
    return tx.query<{ expires_at: bigint }>(
      `INSERT INTO nonces (nonce, address, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))
       RETURNING extract(epoch from expires_at)::bigint AS expires_at`,
      [nonce, address, NONCE_TTL_SECONDS],
    );
  });

  return { nonce, expiresAt: rows[0]?.expires_at ?? 0n };
}

/**
 * Burns `nonce` and reports the address it was issued to, or `null` if it was
 * unknown or expired.
 *
 * **The delete is the burn**, and it is a single statement: two callers racing
 * the same nonce cannot both see a row, because only one `DELETE` can return
 * one. A read-then-delete would leave exactly that race open, and a nonce that
 * can be spent twice is not single-use.
 *
 * An expired row is deleted too and reported as a miss — the caller is told
 * nothing it could use to distinguish "expired" from "never existed", which is
 * also what keeps a nonce from being an oracle for another address's traffic.
 */
export async function consumeNonce(db: Db, nonce: string): Promise<Buffer | null> {
  const { rows } = await db.query<{ address: Buffer; live: boolean }>(
    "DELETE FROM nonces WHERE nonce = $1 RETURNING address, expires_at > now() AS live",
    [nonce],
  );
  const row = rows[0];
  return row !== undefined && row.live ? row.address : null;
}

/**
 * Mints a bearer session. The token is 16 random bytes; nothing is derived from
 * it.
 *
 * Capped per address, in one transaction with the insert, exactly as
 * `issueNonce` is (R68, C-1). Without it one keypair — 32 free bytes, no
 * credential, no forgery — was measured taking **400 sessions at 90/s with no
 * refusal**, and at that rate the 24 h TTL plus an hourly sweep puts ~7.8 M rows
 * and ~2.7 GB in a table `readSession` is on the request path of. The handshake
 * needs no permission to run, so the only thing that can bound it is here.
 */
export async function createSession(
  db: Db,
  address: Buffer,
  role: Role,
  providerId: bigint | null,
): Promise<Session> {
  const token = `vorq_sess_${randomBytes(16).toString("hex")}`;
  const { rows } = await db.tx(async (tx) => {
    await capPerAddress(tx, "sessions", address, MAX_LIVE_SESSIONS_PER_ADDRESS);
    return tx.query<{ expires_at: bigint }>(
      `INSERT INTO sessions (token, address, role, provider_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING extract(epoch from expires_at)::bigint AS expires_at`,
      [token, address, role, providerId, SESSION_TTL_SECONDS],
    );
  });
  return { token, address, role, providerId, expiresAt: rows[0]?.expires_at ?? 0n };
}

/** The live session behind a token, or `null`. An expired row reads as absent. */
export async function readSession(db: Db, token: string): Promise<Session | null> {
  const { rows } = await db.query<{
    token: string;
    address: Buffer;
    role: string;
    provider_id: bigint | null;
    expires_at: bigint;
  }>(
    `SELECT token, address, role, provider_id,
            extract(epoch from expires_at)::bigint AS expires_at
       FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    token: row.token,
    address: row.address,
    role: row.role === "provider" ? "provider" : "client",
    providerId: row.provider_id,
    expiresAt: row.expires_at,
  };
}

/**
 * Deletes every expired row of every TTL table. Returns how many of each went.
 *
 * Driven by {@link TTL_TABLES} rather than by two hand-written statements, so a
 * table added to that list is swept without anyone remembering to add a line —
 * and so "swept by the same function on the identical predicate" is a fact about
 * the code rather than a coincidence two statements happen to share. Each
 * predicate is an index scan: this is the sweep `<table>_expires_at` exists for,
 * and it is the sweep — not the TTL — that bounds residency, because nothing
 * else removes the rows of an address that never comes back (R68).
 */
export async function sweepExpired(db: Db): Promise<{ sessions: number; nonces: number }> {
  const swept: Record<string, number> = {};
  for (const table of TTL_TABLES) {
    const { rowCount } = await db.query(`DELETE FROM ${table} WHERE expires_at <= now()`);
    swept[table] = rowCount ?? 0;
  }
  return { sessions: swept.sessions ?? 0, nonces: swept.nonces ?? 0 };
}

/**
 * Runs {@link sweepExpired} every hour until stopped.
 *
 * `unref()` so the timer never holds the process open: shutdown is owned by
 * `main.ts`, and a housekeeping interval that keeps a container alive after
 * SIGTERM is the classic reason a stop takes 10 seconds and then a SIGKILL.
 * A failing sweep is logged and the schedule continues — the next one repairs
 * whatever this one did not, and there is nothing here worth stopping the node
 * for.
 */
export function startSweep(
  db: Db,
  onError: (error: unknown) => void,
  intervalMs = SWEEP_INTERVAL_MS,
): { stop: () => void } {
  const timer = setInterval(() => {
    void sweepExpired(db).catch(onError);
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
