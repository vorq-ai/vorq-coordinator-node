-- The relayer that landed the job's claim, read off `Claimed`: the trailing
-- member of the exit `Terms`, which `submitAndSettle`, `fail` and `reclaim` must
-- pass back, and the address that earns the job's gas fee on every exit. 20
-- bytes, as every address column. NULL until the claim is indexed, and for good
-- on a job nobody claimed; an exit is never built from a row without it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS relayer BYTEA;
