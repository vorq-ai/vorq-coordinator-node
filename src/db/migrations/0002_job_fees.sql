-- What each job paid on top of its charge, both read straight off its own logs.
-- `gas_fee` is the relay gas fee `JobRegistry` snapshotted at post, carried by
-- `Posted`; the treasury keeps it on every exit of a claimed job. `fee` is the
-- protocol fee settlement took, carried by `Settled`; 0 until then, and 0 for
-- good on every other ending, because only settlement takes one. NUMERIC, like
-- every uint128.

-- Rows indexed before these columns existed have no gas fee to fill them with,
-- so the chain-derived tables are emptied once and the cold start replays them
-- from `deploy_block`. The node answers `503 not_ready` until that replay is
-- done, so no reader sees the book half-built. Guarded on the column, so a
-- re-run never empties anything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'jobs' AND column_name = 'gas_fee'
  ) THEN
    TRUNCATE cursor, jobs, providers, models, allowlist, asks_chain;
    ALTER TABLE jobs ADD COLUMN gas_fee NUMERIC NOT NULL;
    ALTER TABLE jobs ADD COLUMN fee NUMERIC NOT NULL DEFAULT 0;
  END IF;
END $$;
