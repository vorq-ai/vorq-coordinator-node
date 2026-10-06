# Migrations

The database schema is the SQL files in this directory, applied in filename order when the coordinator starts.

## Adding a migration

- Create `NNNN_description.sql` with the next zero-padded number. Never rename or edit a file that has been released.
- Make it re-runnable: use `IF NOT EXISTS`, `IF EXISTS` and guarded backfills. A database rebuild replays every file over the tables it keeps.
- Enable row-level security on any new table in the same file: `ALTER TABLE x ENABLE ROW LEVEL SECURITY;` (no policies).
- For an index on a large table, build it beforehand with `CREATE INDEX CONCURRENTLY`; the migration's `IF NOT EXISTS` then finds it. Migrations run in a single transaction, where `CONCURRENTLY` is not allowed.

Applied migrations are recorded in `schema_migrations`. If any file fails, the whole set is rolled back and the node does not start.
