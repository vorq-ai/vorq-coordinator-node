-- The display name this coordinator shows for a provider. NOT derived from
-- chain: no log carries a name, an operator sets one by hand (see the network
-- operations runbook), and neither the reducer nor any route writes it. No
-- foreign key to `providers`, so a replay that empties `providers` keeps every
-- name, and a name may be set before its provider is indexed. PRESERVED in
-- src/db/db.ts for the same reason.
CREATE TABLE IF NOT EXISTS provider_names (
  provider_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64)
);
ALTER TABLE provider_names ENABLE ROW LEVEL SECURITY;
