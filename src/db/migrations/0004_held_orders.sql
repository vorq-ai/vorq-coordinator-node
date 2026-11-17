-- A held order: a paid order no live ask cleared when it arrived. It is an
-- open `jobs` row that is not on chain yet and still carries the two signatures
-- `post` takes; `auth_sig IS NOT NULL` is what marks it. The provider poll that
-- leases the row posts it and clears both columns (`src/match/held.ts`). NULL
-- on every row the chain wrote.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS order_sig BYTEA;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auth_sig BYTEA;
