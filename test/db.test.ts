import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readSession, sweepExpired, TTL_TABLES } from "../src/api/sessions.js";
import { dropDerived, openDb, PRESERVED, SCHEMA_LOCK_KEY, type Db } from "../src/db/db.js";

/**
 * Gated on `TEST_DATABASE_URL`, and deliberately part of the **unit** suite (R25):
 * the "no network" rule for `npm test` is about chain access, not about a local
 * database. Without the variable every test here skips; with it they run
 * against a real Postgres:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_db_test";

/**
 * Points a connection at a schema of this suite's own instead of `public`.
 *
 * The suite drops and recreates that schema, so it must not be able to touch a
 * developer's actual projection: `TEST_DATABASE_URL` will sometimes be pointed at
 * a database with data in it. Scoping by `search_path` keeps a destructive test
 * honest, and it exercises `openDb` with a connection string that carries query
 * parameters, which a hosted URL always does.
 *
 * **The gate is deliberately not `DATABASE_URL`.** That name is the one a managed
 * platform injects and half the world exports; arming a suite that drops schemas
 * off an ambient variable would run it against whatever database happened to be
 * in the shell. `TEST_DATABASE_URL` is set by someone who meant it.
 *
 * The space in the option is percent-encoded rather than left to
 * `URLSearchParams`, which would write it as `+`; the connection-string parser
 * decodes with `decodeURIComponent`, where `+` stays a literal plus.
 */
function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

/** Every table `migrations/` declares. */
const TABLES = [
  "allowlist",
  "asks_chain",
  // Which job is which line. Preserved: nothing on chain says a job belongs to
  // a batch, so a replay brings back the jobs and no way to attribute them.
  "batch_lines",
  // The batch surface's own row, and the client's record of its batch. Preserved
  // for its lines' reason: no chain log groups a set of jobs into one batch.
  "batches",
  "cursor",
  // `file_id → cid`. Preserved for `pins`' reason: the pair is on no chain log,
  // and without it every batch names an input file this node cannot resolve.
  "files",
  // Advisory matcher state: which provider currently holds an open job.
  // Droppable — the next provider poll recreates it.
  "job_leases",
  "jobs",
  "models",
  "nonces",
  // The object-store name book (R73): `cid → s3_key`, written at mint time
  // because a store-minted CID carries no key to re-derive.
  "pins",
  // Advisory matcher state: the last poll each provider made per model, with
  // its floors, free slots and round-robin cursor. Droppable — the next poll
  // recreates it.
  "provider_presence",
  "providers",
  "quotes_live",
  // Which migrations have run. Droppable — dropping it replays every one.
  "schema_migrations",
  "sessions",
];

const UINT128_MAX = "340282366920938463463374607431768211455";

/** Past `int4`, which is the whole point of R48. */
const MAX_UINT32 = 4_294_967_295n;

/** Past the double range, so a `Number()` in the driver would be visible. */
const BEYOND_SAFE_INTEGER = 9007199254740993n;

const bytes = (fill: number, length = 32): Buffer => Buffer.alloc(length, fill);

describe.skipIf(!TEST_DATABASE_URL)("db", () => {
  let db: Db;

  /** A job row with every NOT NULL column that has no default filled in. */
  const jobFields = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    job_id: bytes(0x01),
    owner: bytes(0xaa, 20),
    c: bytes(0xbb),
    model_id: 7,
    sla_secs: 3600,
    designated: 0,
    rate_in: "1000000",
    rate_out: "2000000",
    units_in: 1000n,
    units_out: 2000n,
    expires_at: 4102444800n,
    task_cid: Buffer.from("bafkreitaskcid", "utf8"),
    as_of_block: 4242n,
    gas_fee: "30000",
    ...overrides,
  });

  async function insertJob(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = jobFields(overrides);
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    await db.query(
      `INSERT INTO jobs (${columns.join(", ")}) VALUES (${placeholders})`,
      Object.values(row),
    );
  }

  async function resetSchema(): Promise<void> {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  }

  beforeAll(async () => {
    db = openDb(scopedToTestSchema(TEST_DATABASE_URL as string));
    await resetSchema();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  describe("migrate", () => {
    it("creates every projected table from an empty schema", async () => {
      await db.migrate();

      const { rows } = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
        [TEST_SCHEMA],
      );

      expect(rows.map((row) => row.table_name)).toEqual(TABLES);
    });

    it("declares the indexes the read API depends on", async () => {
      const { rows } = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'jobs' ORDER BY 1",
        [TEST_SCHEMA],
      );
      const names = rows.map((row) => row.indexname);

      expect(names).toContain("jobs_open");
      expect(names).toContain("jobs_provider");
      expect(names).toContain("jobs_owner");
    });

    it("is a no-op when applied a second time", async () => {
      await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 99, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')");

      await expect(db.migrate()).resolves.toBeUndefined();

      // Idempotent means "leaves what is there alone", not merely "does not throw".
      const { rows } = await db.query<{ block_number: bigint }>("SELECT block_number FROM cursor");
      expect(rows).toEqual([{ block_number: 99n }]);
      await db.query("DELETE FROM cursor");
    });

    it("waits for a migration another connection is already running", async () => {
      // CREATE TABLE IF NOT EXISTS checks the catalog and then inserts into it,
      // which is not atomic: two nodes booting together collide on the catalog's
      // unique index. This asserts the serialisation that prevents it — while a
      // second connection holds the schema lock, migrate() must block.
      const holder = openDb(scopedToTestSchema(TEST_DATABASE_URL as string));
      let acquired!: () => void;
      let release!: () => void;
      const held = new Promise<void>((resolve) => (acquired = resolve));
      const releaseRequested = new Promise<void>((resolve) => (release = resolve));

      const holding = holder.tx(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
        acquired();
        await releaseRequested;
      });

      try {
        await held;
        let finished = false;
        const migration = db.migrate().then(() => {
          finished = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(finished).toBe(false);

        release();
        await holding;
        await migration;
        expect(finished).toBe(true);
      } finally {
        release();
        await holding.catch(() => undefined);
        await holder.close();
      }
    });

    it("survives several nodes booting against an empty schema at once", async () => {
      await resetSchema();
      const nodes = [
        db,
        ...Array.from({ length: 3 }, () => openDb(scopedToTestSchema(TEST_DATABASE_URL as string))),
      ];

      try {
        await Promise.all(nodes.map((node) => node.migrate()));
      } finally {
        await Promise.all(nodes.slice(1).map((node) => node.close()));
      }

      const { rows } = await db.query<{ count: bigint }>(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = $1",
        [TEST_SCHEMA],
      );
      expect(rows[0]?.count).toBe(BigInt(TABLES.length));
    });

    it("enables row-level security on every table", async () => {
      await db.migrate();
      const { rows } = await db.query<{ relname: string }>(
        `SELECT relname FROM pg_class
         WHERE relnamespace = $1::regnamespace AND relkind = 'r' AND NOT relrowsecurity`,
        [TEST_SCHEMA],
      );
      expect(rows).toEqual([]);
    });

    it("records every shipped migration, and runs none twice", async () => {
      await resetSchema();
      await db.migrate();
      await db.migrate();

      const shipped = readdirSync(new URL("../src/db/migrations/", import.meta.url))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const { rows } = await db.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY 1",
      );
      expect(rows.map((row) => row.version)).toEqual(shipped);
    });

    it("adopts a database that predates schema_migrations, leaving its rows", async () => {
      // Production before migrations: every table present, RLS off, no record.
      await db.migrate();
      await db.query("INSERT INTO pins (cid, s3_key) VALUES ('bafyprod', 'k')");
      await db.query("DROP TABLE schema_migrations");
      await db.query("ALTER TABLE pins DISABLE ROW LEVEL SECURITY");

      await db.migrate();

      const pins = await db.query("SELECT s3_key FROM pins WHERE cid = 'bafyprod'");
      expect(pins.rows).toEqual([{ s3_key: "k" }]);
      const rls = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'pins'::regclass");
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
      await db.query("DELETE FROM pins");
    });

    describe("0002_job_fees", () => {
      const CHAIN_DERIVED = ["allowlist", "asks_chain", "cursor", "jobs", "models", "providers"];
      const migration = (version: string): string =>
        readFileSync(new URL(`../src/db/migrations/${version}`, import.meta.url), "utf8");

      /** One row in every chain-derived table 0002 names and in every PRESERVED one. */
      async function seed(job: Record<string, unknown>): Promise<void> {
        const columns = Object.keys(job);
        await db.query(
          `INSERT INTO jobs (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(job),
        );
        await db.query(
          "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 99, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')",
        );
        await db.query("INSERT INTO providers (provider_id, operator) VALUES (3, $1)", [bytes(0xcd, 20)]);
        await db.query("INSERT INTO models (model_id, name) VALUES (7, 'model-a')");
        await db.query("INSERT INTO allowlist (key, status, entry) VALUES ($1, 1, '{}'::jsonb)", [bytes(0xa1)]);
        await db.query("INSERT INTO asks_chain VALUES (3, 7, 3600, 1000000, 2000000)");
        await db.query("INSERT INTO pins (cid, s3_key) VALUES ('bafyprod', 'k')");
        await db.query(
          "INSERT INTO quotes_live (provider_id, snapshot, signature, signed_at) VALUES (3, '{}'::jsonb, $1, 1)",
          [bytes(8, 65)],
        );
        await db.query(
          `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, created_at, expires_at)
           VALUES ('file-1', $1, 'batch', 'in.jsonl', 1, 'bafyfile', 1, 2)`,
          [bytes(0xaa, 20)],
        );
        await db.query(
          `INSERT INTO batches (batch_id, owner, endpoint, completion_window,
                                input_file_id, created_at, expires_at)
           VALUES ('batch_1', $1, '/v1/responses', 86400, 'file-1', 1, 2)`,
          [bytes(0xaa, 20)],
        );
        await db.query("INSERT INTO batch_lines (batch_id, line_no, job_id) VALUES ('batch_1', 0, $1)", [
          bytes(0x01),
        ]);
      }

      async function counts(tables: readonly string[]): Promise<Record<string, bigint>> {
        const out: Record<string, bigint> = {};
        for (const table of tables) {
          const { rows } = await db.query<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`);
          out[table] = rows[0]!.n;
        }
        return out;
      }

      const every = (tables: readonly string[], n: bigint) =>
        Object.fromEntries(tables.map((table) => [table, n]));

      it("empties the chain-derived tables once, keeps PRESERVED ones, and adds both columns", async () => {
        // A database as `migrate` left it before 0002 shipped: 0001 applied and
        // recorded, and rows the index built without a gas fee to fill them with.
        await resetSchema();
        await db.query(migration("0001_init.sql"));
        await db.query(
          "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
        );
        await db.query("INSERT INTO schema_migrations (version) VALUES ('0001_init.sql')");
        const { gas_fee: _, ...preFee } = jobFields();
        await seed(preFee);

        await db.migrate();

        expect(await counts(CHAIN_DERIVED)).toEqual(every(CHAIN_DERIVED, 0n));
        expect(await counts(PRESERVED)).toEqual(every(PRESERVED, 1n));
        const columns = await db.query<{
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }>(
          `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'jobs' AND column_name IN ('gas_fee', 'fee')
            ORDER BY column_name`,
          [TEST_SCHEMA],
        );
        expect(columns.rows).toEqual([
          { column_name: "fee", data_type: "numeric", is_nullable: "NO", column_default: "0" },
          { column_name: "gas_fee", data_type: "numeric", is_nullable: "NO", column_default: null },
        ]);
      });

      it("changes nothing when it runs again over a column that already exists", async () => {
        // Rows the cold start has since rebuilt, both fees included. Neither a
        // second boot nor a replay of the file itself (the rebuild path re-runs
        // every migration over the tables it keeps) may empty them again.
        await db.query(`TRUNCATE ${PRESERVED.join(", ")}`);
        await seed(jobFields({ state: 2, ended_because: 1, fee: "2500" }));

        await db.migrate();
        await db.query(migration("0002_job_fees.sql"));

        expect(await counts(CHAIN_DERIVED)).toEqual(every(CHAIN_DERIVED, 1n));
        expect(await counts(PRESERVED)).toEqual(every(PRESERVED, 1n));
        const { rows } = await db.query<{ gas_fee: bigint; fee: bigint }>("SELECT gas_fee, fee FROM jobs");
        expect(rows).toEqual([{ gas_fee: 30000n, fee: 2500n }]);

        await db.query(`TRUNCATE ${[...CHAIN_DERIVED, ...PRESERVED].join(", ")}`);
      });
    });
  });

  describe("cursor", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM cursor");
    });

    it("accepts exactly one row", async () => {
      await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 100, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')");

      await expect(
        db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (2, 200, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')"),
      ).rejects.toThrow(/cursor_id_check/);
      await expect(
        db.query("INSERT INTO cursor (block_number, block_hash) VALUES (200, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')"),
      ).rejects.toThrow(
        /cursor_pkey/,
      );

      const { rows } = await db.query<{ block_number: bigint }>("SELECT block_number FROM cursor");
      expect(rows).toEqual([{ block_number: 100n }]);
    });

    it("advances by upsert", async () => {
      await db.query(
        "INSERT INTO cursor (id, block_number, block_hash) VALUES (1, $1, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') " +
          "ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number",
        [BEYOND_SAFE_INTEGER],
      );

      const { rows } = await db.query<{ block_number: bigint }>("SELECT block_number FROM cursor");
      expect(rows[0]?.block_number).toBe(BEYOND_SAFE_INTEGER);
    });
  });

  describe("numerics across the JS/Postgres boundary", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM jobs");
    });

    it("carries a uint128 rate as an exact bigint", async () => {
      await insertJob({ rate_in: UINT128_MAX, rate_out: "0" });

      const { rows } = await db.query<{ rate_in: bigint; rate_out: bigint }>(
        "SELECT rate_in, rate_out FROM jobs",
      );

      expect(rows[0]?.rate_in).toBe(BigInt(UINT128_MAX));
      expect(rows[0]?.rate_out).toBe(0n);
    });

    it("carries BIGINT columns as bigint, beyond the safe-integer range", async () => {
      await db.query("DELETE FROM jobs");
      await insertJob({ expires_at: BEYOND_SAFE_INTEGER, as_of_block: 4242n, units_in: 7n });

      const { rows } = await db.query<{
        expires_at: bigint;
        as_of_block: bigint;
        units_in: bigint;
      }>("SELECT expires_at, as_of_block, units_in FROM jobs");

      expect(typeof rows[0]?.expires_at).toBe("bigint");
      expect(rows[0]?.expires_at).toBe(BEYOND_SAFE_INTEGER);
      expect(rows[0]?.as_of_block).toBe(4242n);
      expect(rows[0]?.units_in).toBe(7n);
    });

    it("accepts a JS number for a BIGINT column and still reads back a bigint", async () => {
      await db.query("DELETE FROM jobs");
      await insertJob({ as_of_block: 4242 });

      const { rows } = await db.query<{ as_of_block: bigint }>("SELECT as_of_block FROM jobs");
      expect(rows[0]?.as_of_block).toBe(4242n);
    });

    it("carries SMALLINT columns as numbers", async () => {
      await db.query("DELETE FROM jobs");
      await insertJob({ state: 1, ended_because: 2 });

      const { rows } = await db.query<{ state: number; ended_because: number }>(
        "SELECT state, ended_because FROM jobs",
      );

      expect(rows[0]?.state).toBe(1);
      expect(rows[0]?.ended_because).toBe(2);
    });

    it("carries a chain uint32 as bigint, because every one of them is BIGINT (R48)", async () => {
      // Not a stylistic choice: an on-chain uint32 reaches 4294967295 and int4
      // stops at 2147483647, so `jobs.designated` — which `post` does not
      // validate — would fail to insert and wedge the indexer. Every uint32
      // column is BIGINT, so they all read back as bigint.
      await db.query("DELETE FROM jobs");
      await insertJob({ model_id: 7, designated: MAX_UINT32, provider_id: MAX_UINT32 });

      const { rows } = await db.query<{
        model_id: bigint;
        sla_secs: bigint;
        designated: bigint;
        provider_id: bigint;
      }>("SELECT model_id, sla_secs, designated, provider_id FROM jobs");

      expect(rows[0]).toEqual({
        model_id: 7n,
        sla_secs: 3600n,
        designated: MAX_UINT32,
        provider_id: MAX_UINT32,
      });
    });

    it("leaves cursor.id an INT, the one column no chain value feeds", async () => {
      const { rows } = await db.query<{ data_type: string }>(
        "SELECT data_type FROM information_schema.columns " +
          "WHERE table_schema = $1 AND table_name = 'cursor' AND column_name = 'id'",
        [TEST_SCHEMA],
      );
      expect(rows[0]?.data_type).toBe("integer");
    });

    it("has no INT column anywhere else, so no chain uint32 can overflow one (R48)", async () => {
      // The mechanical form of the rule: reading it off the catalog is what
      // makes a future `INT` column an immediate failure rather than a wedged
      // cursor discovered in production.
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns " +
          "WHERE table_schema = $1 AND data_type = 'integer' ORDER BY 1, 2",
        [TEST_SCHEMA],
      );

      expect(rows).toEqual([{ table_name: "cursor", column_name: "id" }]);
    });

    it("counts as bigint, because count() is an int8", async () => {
      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM jobs");
      expect(rows[0]?.count).toBe(1n);
    });

    it("round-trips bytea as bytes, from either a Buffer or a Uint8Array", async () => {
      await db.query("DELETE FROM jobs");
      const owner = Uint8Array.from({ length: 20 }, (_, index) => index + 1);
      await insertJob({ owner });

      const { rows } = await db.query<{ owner: Buffer; result_cid: Buffer }>(
        "SELECT owner, result_cid FROM jobs",
      );

      expect(Buffer.isBuffer(rows[0]?.owner)).toBe(true);
      expect(Uint8Array.from(rows[0]!.owner)).toEqual(owner);
      expect(rows[0]?.result_cid).toEqual(Buffer.alloc(0));
    });

    it("round-trips jsonb as a parsed value and BIGINT[] as bigints", async () => {
      // `allowed_models` is a uint32[] on chain, so R48 reaches its element type
      // too. The driver's own int8[] parser yields strings; the pool's parser
      // converts the elements, so the array agrees with every scalar BIGINT.
      await db.query("DELETE FROM providers");
      await db.query(
        "INSERT INTO providers (provider_id, operator, allowed_models, evidence) VALUES ($1, $2, $3, $4)",
        [3, bytes(0xcd, 20), [1, 2, MAX_UINT32], { raw: "0xdeadbeef" }],
      );

      const { rows } = await db.query<{ allowed_models: bigint[]; evidence: unknown }>(
        "SELECT allowed_models, evidence FROM providers WHERE provider_id = 3",
      );

      expect(rows[0]?.allowed_models).toEqual([1n, 2n, MAX_UINT32]);
      expect(rows[0]?.evidence).toEqual({ raw: "0xdeadbeef" });
    });
  });

  describe("job state vocabulary", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM jobs");
    });

    it("rejects a state outside 0..3", async () => {
      await expect(insertJob({ state: 4 })).rejects.toThrow(/jobs_state_check/);
    });

    it("rejects an ended cause outside the vocabulary", async () => {
      await expect(insertJob({ ended_because: 6 })).rejects.toThrow(/jobs_ended_because_check/);
    });

    it("refuses to store cause 5, which only ever exists at read time", async () => {
      // R3: getJob returns state 3 / endedBecause 5 for an expired-but-open job.
      // Reconcile maps that back to 0/0 before writing; storing it would make the
      // index disagree with a rebuild from logs.
      await expect(insertJob({ state: 3, ended_because: 5 })).rejects.toThrow(
        /jobs_ended_because_check/,
      );
    });

    it("accepts the causes that are really stored", async () => {
      for (const [index, cause] of [0, 1, 2, 3, 4].entries()) {
        await insertJob({ job_id: bytes(0x40 + index), state: 3, ended_because: cause });
      }

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM jobs");
      expect(rows[0]?.count).toBe(5n);
    });
  });

  describe("openness is never materialised", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM jobs");
    });

    it("has no column that stores openness or expiry", async () => {
      const { rows } = await db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns " +
          "WHERE table_schema = $1 AND table_name = 'jobs'",
        [TEST_SCHEMA],
      );
      const columns = rows.map((row) => row.column_name);

      expect(columns).not.toContain("is_open");
      expect(columns).not.toContain("open");
      expect(columns).not.toContain("expired");
      expect(columns).toContain("expires_at");
      expect(columns).toContain("state");
    });

    it("leaves an expired job at state 0 and answers openness at query time", async () => {
      const now = 1_800_000_000n;
      await insertJob({ job_id: bytes(0x01), expires_at: now - 1n });
      await insertJob({ job_id: bytes(0x02), expires_at: now + 1n });
      await insertJob({ job_id: bytes(0x03), expires_at: now + 1n, state: 1 });

      const { rows } = await db.query<{ job_id: Buffer }>(
        "SELECT job_id FROM jobs WHERE state = 0 AND expires_at > $1 ORDER BY job_id",
        [now],
      );
      expect(rows.map((row) => row.job_id[0])).toEqual([0x02]);

      // The expired one is untouched in the index: nothing wrote an ending.
      const stored = await db.query<{ state: number; ended_because: number }>(
        "SELECT state, ended_because FROM jobs WHERE job_id = $1",
        [bytes(0x01)],
      );
      expect(stored.rows[0]).toEqual({ state: 0, ended_because: 0 });
    });
  });

  describe("model projection", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM models");
    });

    it("tracks whether a model is still enabled, defaulting to enabled", async () => {
      // R5: without this the node fronts gas on a model the chain has retired.
      // registerModel() sets modelEnabled = true and emits only ModelRegistered,
      // so a row created from that event is enabled by default.
      await db.query("INSERT INTO models (model_id, name) VALUES (1, 'model-a')");
      await db.query("INSERT INTO models (model_id, name, enabled) VALUES (2, 'model-b', FALSE)");

      const { rows } = await db.query<{ model_id: bigint; enabled: boolean }>(
        "SELECT model_id, enabled FROM models ORDER BY model_id",
      );

      expect(rows).toEqual([
        { model_id: 1n, enabled: true },
        { model_id: 2n, enabled: false },
      ]);
    });
  });

  describe("sessions", () => {
    beforeAll(async () => {
      await db.migrate();
      await db.query("DELETE FROM sessions");
    });

    it("carries an optional provider_id, null for a client session", async () => {
      // R14: the role is resolved at handshake; a client session has no provider.
      await db.query(
        "INSERT INTO sessions (token, address, role, expires_at) VALUES ($1, $2, 'client', now())",
        ["vorq_sess_client", bytes(0x11, 20)],
      );
      await db.query(
        "INSERT INTO sessions (token, address, role, provider_id, expires_at) " +
          "VALUES ($1, $2, 'provider', 9, now())",
        ["vorq_sess_provider", bytes(0x22, 20)],
      );

      const { rows } = await db.query<{ token: string; provider_id: bigint | null }>(
        "SELECT token, provider_id FROM sessions ORDER BY token",
      );

      expect(rows).toEqual([
        { token: "vorq_sess_client", provider_id: null },
        { token: "vorq_sess_provider", provider_id: 9n },
      ]);
    });
  });

  /**
   * **The session TTL's two edges, made observable (R78).**
   *
   * `readSession` asks `expires_at > now()` and the sweep asks
   * `expires_at <= now()`. Both operators survived the review's flip because a
   * wall clock cannot be sat on: a row written with `expires_at = now()` is
   * already in the past by the time a second statement reads it, so the equality
   * case never occurs and both spellings agree.
   *
   * Postgres makes it observable anyway: `now()` is **transaction_timestamp**,
   * constant for the life of a transaction. Running the insert and the read
   * inside one transaction puts the row exactly on the boundary, deterministically
   * — no retries, no sleeping, no clock arithmetic. A session expiring at exactly
   * `now` is **expired**: `>` is the right operator, and `>=` would keep a token
   * alive for a second past its stated life.
   */
  describe("the session TTL edges, frozen on one transaction clock (R78)", () => {
    beforeAll(async () => {
      await db.migrate();
    });

    /** A `Db` whose every statement runs inside `tx`, so `now()` does not move. */
    const frozen = (tx: { query: Db["query"] }): Db =>
      ({
        query: tx.query.bind(tx),
        tx: () => Promise.reject(new Error("already in a transaction")),
        migrate: () => Promise.reject(new Error("no migration expected")),
        close: async () => undefined,
      }) as unknown as Db;

    it("reads a session expiring at exactly now as absent, and one a second later as live", async () => {
      await db.tx(async (tx) => {
        await tx.query(
          "INSERT INTO sessions (token, address, role, expires_at) VALUES ($1, $2, 'client', now())",
          ["vorq_sess_at_the_edge", bytes(0x31, 20)],
        );
        await tx.query(
          "INSERT INTO sessions (token, address, role, expires_at) " +
            "VALUES ($1, $2, 'client', now() + interval '1 second')",
          ["vorq_sess_one_past_it", bytes(0x32, 20)],
        );

        // `expires_at > now()` — flipped to `>=`, the first of these reads live.
        expect(await readSession(frozen(tx), "vorq_sess_at_the_edge")).toBeNull();
        expect(await readSession(frozen(tx), "vorq_sess_one_past_it")).not.toBeNull();
      });
      await db.query("DELETE FROM sessions");
    });

    it("sweeps a row expiring at exactly now, and leaves the one a second later", async () => {
      await db.tx(async (tx) => {
        await tx.query(
          "INSERT INTO sessions (token, address, role, expires_at) VALUES ($1, $2, 'client', now())",
          ["vorq_sess_sweep_edge", bytes(0x33, 20)],
        );
        await tx.query(
          "INSERT INTO nonces (nonce, address, expires_at) VALUES ($1, $2, now())",
          ["nonce_at_the_edge", bytes(0x33, 20)],
        );
        await tx.query(
          "INSERT INTO sessions (token, address, role, expires_at) " +
            "VALUES ($1, $2, 'client', now() + interval '1 second')",
          ["vorq_sess_survives", bytes(0x34, 20)],
        );

        // `expires_at <= now()` — flipped to `<`, an expired row survives every
        // sweep for as long as the node runs, which is the residency the whole
        // mechanism exists to bound.
        expect(await sweepExpired(frozen(tx))).toEqual({ sessions: 1, nonces: 1 });

        const { rows } = await tx.query<{ token: string }>("SELECT token FROM sessions");
        expect(rows.map((row) => row.token)).toEqual(["vorq_sess_survives"]);
      });
      await db.query("DELETE FROM sessions");
    });
  });

  /**
   * **R68, hung on the list rather than on the two tables it was applied to.**
   *
   * `nonces` got a per-address cap and both indexes; `sessions` — the same
   * module, the same sweep, the same predicate — got none of them, and nobody
   * noticed for a whole plan because the two facts were never written in one
   * place. They are now: `TTL_TABLES` in `api/sessions.ts` drives the sweep, and
   * these three assertions read the live catalogue and `0001_init.sql` so that a
   * third TTL table cannot be added with the same half-fix.
   *
   * Deleting either `CREATE INDEX` line for either table turns this red, and so
   * does adding a table with an `expires_at` column without registering it.
   */
  describe("every TTL table is indexed for its own sweep (R68)", () => {
    beforeAll(async () => {
      await db.migrate();
    });

    it.each([...TTL_TABLES])("indexes %s on address and on expires_at", async (table) => {
      const { rows } = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2",
        [TEST_SCHEMA, table],
      );
      const definitions = rows.map((row) => row.indexdef).join("\n");

      // The per-address `DELETE` inside `capPerAddress`, which scans the whole
      // table without this — twice, counting the subquery.
      expect(definitions).toMatch(new RegExp(`ON ${TEST_SCHEMA}\\.${table} USING btree \\(address\\)`));
      // The hourly sweep's own predicate. This is what makes residency the sweep
      // interval rather than an unbounded accumulation.
      expect(definitions).toMatch(
        new RegExp(`ON ${TEST_SCHEMA}\\.${table} USING btree \\(expires_at\\)`),
      );
    });

    it("has no TTL table outside the list that drives the sweep", async () => {
      // Every table carrying `expires_at` **as a TTL** is a table something
      // sweeps. `jobs.expires_at` is the chain's own field on a chain-derived
      // row, swept by nothing and deleted by nothing, so it is named here rather
      // than silently excluded. `batches.expires_at` is the same kind of column:
      // the completion window's deadline, which decides whether a batch is past
      // its window, not when its row may be deleted. A batch row outlives its
      // deadline deliberately — a caller fetches a completed or expired batch
      // afterwards, and its `batch_lines` rows are the only record of the line
      // set.
      const { rows } = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns " +
          "WHERE table_schema = $1 AND column_name = 'expires_at'",
        [TEST_SCHEMA],
      );
      const withExpiry = rows.map((row) => row.table_name).sort();

      // `job_leases.expires_at` is a lease deadline, pruned by the next provider
      // poll; it is not in `TTL_TABLES` because the open book bounds it (no
      // caller can grow it past that) and `capPerAddress` assumes an
      // `address` column it does not have. `files.expires_at` *is* a residency
      // TTL, and it is swept — by `startFileSweep`, which also removes the
      // object behind the row and so cannot be `sweepExpired`'s fifth table;
      // `files` has an `owner`, not an `address`, so `capPerAddress` does not
      // reach it either.
      expect(withExpiry).toEqual([
        "batches",
        "files",
        "job_leases",
        "jobs",
        ...[...TTL_TABLES].sort(),
      ]);
    });
  });

  /**
   * The rebuild path, exercised (R44, R47, R67).
   *
   * `pinner.test.ts` pins the two *lists*; this pins what `dropDerived` actually
   * does with them, against a real Postgres. The two halves are what make
   * *"delete the database and the node rebuilds it from the chain"* a procedure
   * rather than a slogan — and what stops a future `DROP SCHEMA public CASCADE`
   * from taking `pins` and `quotes_live` with it, neither of which any replay can
   * bring back.
   */
  describe("dropDerived", () => {
    beforeAll(async () => {
      await db.migrate();
    });

    it("drops every derived table and leaves the two that are not", async () => {
      await db.query("INSERT INTO pins (cid, s3_key) VALUES ('bafypinned', 'k')");
      await db.query(
        `INSERT INTO quotes_live (provider_id, snapshot, signature, signed_at)
         VALUES (1, '{}'::jsonb, $1, 1)`,
        [bytes(8, 65)],
      );
      await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 42, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe') ON CONFLICT (id) DO UPDATE SET block_number = 42");

      await dropDerived(db);

      const { rows } = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
        [TEST_SCHEMA],
      );
      // Exactly the preserved set survives — asserted as an equality, not as a
      // set of `toContain`s, so a table that escapes the drop is a failure and
      // not an omission nobody notices.
      expect(rows.map((row) => row.table_name)).toEqual([...PRESERVED].sort());

      // And their rows came with them.
      const pins = await db.query<{ n: bigint }>("SELECT count(*) AS n FROM pins");
      expect(pins.rows[0].n).toBe(1n);
      const quotes = await db.query<{ n: bigint }>("SELECT count(*) AS n FROM quotes_live");
      expect(quotes.rows[0].n).toBe(1n);
    });

    it("keeps a batch and its lines across the drop: no chain log groups them", async () => {
      // `batches` and `batch_lines` earn preservation the same way `pins` does. Every
      // member job is an independent designated order and nothing on chain says it
      // belongs to a batch, so a replay brings back the jobs and no way to attribute
      // one — the two rows here are the only record of the grouping there is.
      await db.migrate();
      await db.query(
        `INSERT INTO batches (batch_id, owner, endpoint, completion_window,
                              input_file_id, created_at, expires_at)
         VALUES ('batch_1', $1, '/v1/responses', 86400, 'file-1', 1, 2)`,
        [bytes(20, 17)],
      );
      await db.query(
        `INSERT INTO batch_lines (batch_id, line_no, job_id) VALUES ('batch_1', 0, $1)`,
        [bytes(32, 9)],
      );

      await dropDerived(db);

      const batches = await db.query<{ input_file_id: string }>(
        "SELECT input_file_id FROM batches WHERE batch_id = 'batch_1'",
      );
      expect(batches.rows[0]?.input_file_id).toBe("file-1");
      const lines = await db.query<{ line_no: bigint }>(
        "SELECT line_no FROM batch_lines WHERE batch_id = 'batch_1'",
      );
      expect(lines.rows.map((row) => row.line_no)).toEqual([0n]);
    });

    it("is safe to run twice, and migrate brings the schema back", async () => {
      await expect(dropDerived(db)).resolves.toBeUndefined();

      await db.migrate();
      const { rows } = await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
        [TEST_SCHEMA],
      );
      expect(rows.map((row) => row.table_name)).toEqual(TABLES);
      // Rebuilt empty: the cursor is gone, so the next boot is a full replay
      // from `deploy_block`.
      const cursor = await db.query("SELECT * FROM cursor");
      expect(cursor.rows).toEqual([]);
    });
  });

  describe("tx", () => {
    beforeAll(async () => {
      await db.migrate();
      // `pins` is the scratch table these three use: two columns and a primary
      // key, so a duplicate insert is a clean constraint violation to roll back
      // against.
      await db.query("DELETE FROM pins");
    });

    it("commits everything the callback wrote and returns its value", async () => {
      const written = await db.tx(async (tx) => {
        await tx.query("INSERT INTO pins (cid, s3_key) VALUES ('bafycommitted', 'k1')");
        const { rows } = await tx.query<{ cid: string }>("SELECT cid FROM pins");
        return rows[0]?.cid;
      });

      expect(written).toBe("bafycommitted");
      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM pins");
      expect(rows[0]?.count).toBe(1n);
    });

    it("rolls back on a throw and lets the error out", async () => {
      await expect(
        db.tx(async (tx) => {
          await tx.query("INSERT INTO pins (cid, s3_key) VALUES ('bafyrolledback', 'k2')");
          throw new Error("reducer gave up");
        }),
      ).rejects.toThrow("reducer gave up");

      const { rows } = await db.query<{ cid: string }>(
        "SELECT cid FROM pins WHERE cid = 'bafyrolledback'",
      );
      expect(rows).toEqual([]);
    });

    it("rolls back on a failed statement and keeps the pool usable afterwards", async () => {
      await expect(
        db.tx(async (tx) => {
          await tx.query("INSERT INTO pins (cid, s3_key) VALUES ('bafycommitted', 'k3')");
        }),
      ).rejects.toThrow(/pins_pkey/);

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM pins");
      expect(rows[0]?.count).toBe(1n);
    });
  });
});
