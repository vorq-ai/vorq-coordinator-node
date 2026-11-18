-- What settlement metered, read off `Settled`: the backend's prompt tokens, the
-- cached share of them, and the atomic rate the cached share was priced at.
-- Each is clamped on chain (prompt_tok <= units_in, cached_tok <= prompt_tok,
-- rate_in_cached <= rate_in), and 0 until the job settles. `completion_tok`
-- already exists. NUMERIC for the uint128 rate, as every rate.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS prompt_tok BIGINT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cached_tok BIGINT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS rate_in_cached NUMERIC NOT NULL DEFAULT 0;
