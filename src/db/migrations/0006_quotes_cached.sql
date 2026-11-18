-- The cached input rate a provider lists beside each pushed ask, keyed
-- "model_id:sla", the atomic rate as a decimal string. Not signed and not on
-- chain: settle signs the rate it charges. Written with the snapshot, so the two
-- never split; a slot with no entry lists rate_in (no discount).
ALTER TABLE quotes_live ADD COLUMN IF NOT EXISTS rates_in_cached JSONB NOT NULL DEFAULT '{}'::jsonb;
