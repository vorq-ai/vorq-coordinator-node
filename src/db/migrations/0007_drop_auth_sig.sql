-- An order no longer carries a payment authorization: the client pays from a
-- prepaid balance inside JobRegistry, and `claim` locks the job's funds from it.
-- A held order is marked by `order_sig IS NOT NULL` alone (src/match/held.ts).
-- Guarded by IF EXISTS, so a re-run — or a rebuild that replays 0004, which adds
-- the column back — ends with no `auth_sig` either way.
ALTER TABLE jobs DROP COLUMN IF EXISTS auth_sig;
