import { readdirSync, readFileSync } from "node:fs";
import { Pool, types, type QueryResult, type QueryResultRow } from "pg";

/** Anything that can run a statement: the pool itself, or one transaction. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Db extends Queryable {
  /**
   * Runs `fn` inside a transaction, committing its result or rolling back and
   * rethrowing. Statements must go through the handle `fn` is given: the
   * transaction lives on one connection, and `db.query` takes another.
   */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Applies pending `migrations/*.sql`. Idempotent, and safe to run from several nodes at once. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Advisory-lock key for the schema, ASCII "VORQSCHM" read as a 64-bit integer.
 * Exported so a test can hold the same lock; the value itself is arbitrary and
 * only has to be stable and unlikely to collide with another application's.
 */
export const SCHEMA_LOCK_KEY = 0x564f5251_5343484dn;

/**
 * The tables a drop-and-rebuild may drop, and the ones it must not (R44, R47).
 *
 * No rebuild path exists yet — Task 10/11 or an operator script will write one —
 * and **that is exactly why these two lists exist now**: until this file, R44/R47
 * compliance rested on a comment in `migrations/`, and a comment is not
 * enforcement (R67). The rebuild, whoever writes it, enumerates {@link DROPPABLE}
 * and never `DROP SCHEMA public CASCADE`.
 *
 * {@link PRESERVED} is not a convenience list, it is the whole invariant: not one
 * of its tables is derivable from chain logs. `pins` is the only record of where
 * a store-minted CID's object lives (R73) — the name is on chain, the key that
 * resolves it is here and nowhere else; `files` is the only record of an upload's
 * name; `batches` and `batch_lines` are the only record that a set of jobs is one
 * caller's batch, which no chain log says; and `quotes_live` holds signed
 * snapshots providers pushed and will not push again on demand. Everything in
 * `DROPPABLE` is either a pure function of the chain, costs a caller one
 * handshake to re-obtain, or is advisory and regenerated within one provider
 * poll.
 *
 * The two lists together must name **every** table in `migrations/`: the test that
 * pins this reads the file, and a new table that joins neither list fails it
 * rather than defaulting into one.
 */
export const DROPPABLE: readonly string[] = [
  // A pure function of the chain: replayed from the book's `deployBlock`.
  "cursor",
  "jobs",
  "providers",
  "models",
  "allowlist",
  "asks_chain",
  // Not chain-derived, but cheap: a dropped session or nonce costs its holder one
  // `GET /auth/nonce` and one signature, and both are swept on a timer anyway.
  "sessions",
  "nonces",
  // Advisory matcher state, not chain-derived and free to re-earn: both are
  // rewritten by the next provider poll. Chain state is the authority either
  // table only anticipates.
  "provider_presence",
  "job_leases",
  // Which migrations have run. Dropping it makes the next `migrate()` replay
  // every one, which is how the tables above come back: each migration is
  // re-runnable by rule (migrations/README.md).
  "schema_migrations",
];

/** Tables a rebuild must carry across. See {@link DROPPABLE}. */
export const PRESERVED: readonly string[] = [
  "batch_lines",
  "batches",
  "files",
  "pins",
  "quotes_live",
];

/**
 * The rebuild path, discharging R47's *"whichever task implements the rebuild
 * owns enumerating the drop set"*.
 *
 * Drops every table in {@link DROPPABLE} and **nothing else**, so the next
 * `migrate()` + cold start rebuilds the projection from `deploy_block` while
 * {@link PRESERVED}'s tables keep their rows. This is what makes *"delete the
 * database and the node rebuilds it from the chain"* a procedure rather than a
 * slogan, and it is why it is **not** `DROP SCHEMA public CASCADE`: `pins` is the
 * only record of where a store-minted CID's object lives (R73) — drop it and
 * every `task_cid` on the chain becomes a name this node cannot resolve to an
 * object — and `quotes_live` holds the signed snapshots providers will not push
 * again on demand. A replay brings neither back.
 *
 * `CASCADE` is on each table rather than on the schema: it removes the table's
 * own indexes and constraints, which is what {@link DROPPABLE} means, and reaches
 * nothing outside the list because no `PRESERVED` table references one.
 *
 * One statement, so it is atomic: a rebuild interrupted half way through would
 * leave a schema `migrate()` recreates piecemeal and a cursor whose blocks are
 * only partly applied.
 */
export async function dropDerived(db: Queryable): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS ${DROPPABLE.join(", ")} CASCADE`);
}

type TypeId = Parameters<typeof types.getTypeParser>[0];
type TypeFormat = Parameters<typeof types.getTypeParser>[1];

/**
 * `int8[]`. Spelled as a literal and asserted into `TypeId` because
 * `pg.types.builtins` carries scalar oids only — it has no name for an array
 * type, and `TypeId` is the union of the names it does have.
 */
const INT8_ARRAY_OID = 1016 as TypeId;

/**
 * How Postgres values become JS values. Three deliberate choices:
 *
 *   * `BIGINT` → `bigint`. The driver's default is a string, on the grounds that
 *     int8 outgrows a double. It does — `expires_at` is a uint64 and block
 *     numbers grow without bound — but strings put the burden of remembering on
 *     every call site. `bigint` is also what viem hands the reducer for block
 *     numbers and uint64 event fields, so the projection round-trips without a
 *     conversion. `count(*)` is an int8 too, and therefore also a `bigint`.
 *   * `NUMERIC` → `bigint`. These columns hold atomic rates and sums of money;
 *     `bigint` keeps them exact through the arithmetic, and the routes format
 *     them as USD strings (`money.ts`).
 *   * `BIGINT[]` → `bigint[]`, for the same reason and to the same rule.
 *     `providers.allowed_models` is the one such column. The driver's default
 *     parser for `int8[]` yields an array of *strings*, which would make the
 *     element type disagree with every scalar `BIGINT` in the schema — the kind
 *     of inconsistency that is discovered at a call site, late.
 *   * everything else keeps its default: `SMALLINT` → `number` (`state`,
 *     `ended_because` and `allowlist.status` are bounded vocabularies),
 *     `BYTEA` → `Buffer`, `JSONB` → the parsed value.
 *
 * There is deliberately no `INT` case: since R48 the only `INT` in `migrations/`
 * is `cursor.id`, which the CHECK pins to 1. Every chain integer is `BIGINT` or
 * `NUMERIC`, because an on-chain `uint32` outgrows `int4`.
 *
 * Configured per pool rather than through `pg.types.setTypeParser`, which
 * mutates a process-wide table shared with every other consumer of the driver.
 */
function getTypeParser(oid: TypeId, format?: TypeFormat): (value: string) => unknown {
  if (oid === types.builtins.INT8 || oid === types.builtins.NUMERIC) {
    return (value: string) => BigInt(value);
  }

  if (oid === INT8_ARRAY_OID) {
    // Delegated rather than reimplemented: the array text format has quoting and
    // NULL rules that are not worth writing twice. Only the elements are
    // converted, and a NULL element stays null — no column here produces one,
    // but turning it into `0n` would be an invention.
    const parseArray = types.getTypeParser(oid, format) as (value: string) => (string | null)[];
    return (value: string) =>
      parseArray(value).map((element) => (element === null ? null : BigInt(element)));
  }

  return types.getTypeParser(oid, format);
}

interface Migration {
  version: string;
  sql: string;
}

let migrationList: Migration[] | undefined;

/**
 * `migrations/*.sql` in filename order; the filename is the version. Read on
 * first use, then cached: importing this module must not touch the disk.
 */
function migrations(): Migration[] {
  const dir = new URL("./migrations/", import.meta.url);
  migrationList ??= readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((version) => ({ version, sql: readFileSync(new URL(version, dir), "utf8") }));
  return migrationList;
}

/**
 * Opens a connection pool against `url` and returns the store every other layer
 * talks to. Cheap and lazy — no connection is made until the first query.
 */
export function openDb(url: string): Db {
  const pool = new Pool({ connectionString: url, types: { getTypeParser } });

  // An idle connection can die under the pool (a restarted server, a killed
  // backend). Without a listener the pool's `error` event is an unhandled
  // 'error' on an EventEmitter, which takes the process down; the pool discards
  // the connection either way, so reporting it is the whole job.
  pool.on("error", (error) => {
    console.error("postgres: idle client error", error);
  });

  const query: Queryable["query"] = (text, params) =>
    pool.query(text, params === undefined ? undefined : [...params]);

  const tx: Db["tx"] = async (fn) => {
    const client = await pool.connect();
    // A connection whose ROLLBACK failed is in an unknown state; returning it to
    // the pool hands the next caller an open transaction.
    let poisoned = false;
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: (text, params) => client.query(text, params === undefined ? undefined : [...params]),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        poisoned = true; // the failure that got us here is the one worth throwing
      }
      throw error;
    } finally {
      client.release(poisoned || undefined);
    }
  };

  return {
    query,
    tx,

    /**
     * `CREATE TABLE IF NOT EXISTS` is not atomic against a concurrent creator:
     * it checks the catalog and then inserts into it, so two nodes booting
     * together can both pass the check and one loses on `pg_type`'s unique
     * index. The advisory lock serialises the whole file, and being
     * transaction-scoped it is released by the COMMIT or the ROLLBACK, with no
     * cleanup path to get wrong. The loser then finds every object present and
     * does nothing.
     *
     * Runs every migration `schema_migrations` does not name, in order, and
     * records it. All of it is one transaction: a failed migration rolls the
     * boot back whole.
     */
    migrate: () =>
      tx(async (t) => {
        await t.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
        await t.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows } = await t.query<{ version: string }>("SELECT version FROM schema_migrations");
        const applied = new Set(rows.map((row) => row.version));
        for (const migration of migrations()) {
          if (applied.has(migration.version)) continue;
          await t.query(migration.sql);
          await t.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
        }
      }),

    close: () => pool.end(),
  };
}
