-- The coordinator's projection of chain state, plus the few tables that are not
-- derived from it.
--
-- Everything here except `pins`, `quotes_live` and the two advisory matcher
-- tables (`provider_presence`, `job_leases`) is a pure function of the chain: the whole database can be dropped and rebuilt from `deploy_block`, and
-- must come back byte-identical. Two consequences run through the file:
--
--   * nothing that a clock decides is ever stored. Openness is
--     `state = 0 AND expires_at > now`, evaluated at query time, everywhere, and
--     ended cause 5 (expired) is derived at read time exactly as `getJob` does
--     it. There is no `is_open` column, no expiry flag and no trigger.
--   * `as_of_block` travels with the row it describes, so a reader can say how
--     current the answer is without consulting the cursor.
--
-- The first migration: the schema as it stood when migrations began. Never
-- edited again — a change is the next numbered file (see README.md here). Every
-- statement is `IF NOT EXISTS`, so over the database that predates
-- `schema_migrations` this file changes nothing but the RLS pass at the end.
--
-- INTEGER WIDTHS ARE A MECHANICAL RULE, NOT A JUDGEMENT CALL (R48):
--
--     chain uint32 and uint64  ->  BIGINT
--     chain uint128            ->  NUMERIC
--     bounded protocol vocabularies (state, ended_because)  ->  SMALLINT + CHECK
--
-- Postgres INT is int4 and stops at 2 147 483 647; an on-chain uint32 reaches
-- 4 294 967 295. Four columns take uint32 values the contracts deliberately do
-- not validate — `jobs.designated` (any funded client, through `post`),
-- `providers.capacity_requested`, `asks_chain.model_id` and `asks_chain.sla` —
-- and an out-of-range insert is not a bad row but a wedged node: the insert
-- fails, `reduceRange` rolls back, the cursor never advances, and the index
-- stops forever. The rule is applied to every uint32 column and not only to
-- those four on purpose. Widening by reachability would tie this file to which
-- contract functions happen to validate their inputs today, so relaxing one
-- modifier would silently produce a fifth — found the same way the first four
-- were, in production. A width rule can be checked by reading; a reachability
-- argument has to be re-derived every time the contracts move.
--
-- Consequence for every reader (R45): these columns come back as `bigint` in JS,
-- and a row holding one cannot be handed to `JSON.stringify` (R46).

-- The reducer decides whether a chain `bytes` member is storable by asking
-- Postgres itself, with `pg_input_is_valid(…, 'jsonb')` — a JS screen can only
-- cover the malformed shapes someone thought of, and the ones that matter here
-- are reachable by any registered provider with a signature (R50). That function
-- arrived in PostgreSQL 16. Refuse to migrate on anything older rather than let
-- the node boot and then wedge on the first identity event it cannot write,
-- which is exactly the failure the screen exists to prevent.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 160000 THEN
    RAISE EXCEPTION
      'vorq-coordinator-node requires PostgreSQL 16 or newer (pg_input_is_valid), found %',
      current_setting('server_version');
  END IF;
END
$$;

-- Where the indexer has read up to. One row, forever: the CHECK pins the id and
-- the primary key stops a second row from claiming it. `id` is this file's own
-- invention rather than a chain value, and the CHECK bounds it to 1, so it is
-- the one INT the width rule above does not reach. `block_hash` is the hash of
-- `block_number` as indexed — the reorg guard compares it on every tick.
CREATE TABLE IF NOT EXISTS cursor (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id BYTEA PRIMARY KEY,
  owner BYTEA NOT NULL, c BYTEA NOT NULL,
  -- uint32 each. `designated` is the unvalidated one: `JobRegistry.post` checks
  -- `modelId` and `slaSecs` against the catalog and the allowed-SLA set but says
  -- outright that `order.designated` is not validated, because 0 means "any
  -- provider" and `claim` resolves the real id from the signer.
  model_id BIGINT NOT NULL, sla_secs BIGINT NOT NULL, designated BIGINT NOT NULL,
  -- uint128 rates, scaled by RATE_SCALE. NUMERIC, not BIGINT: the value does not
  -- fit a double and must never be read through `Number`.
  rate_in NUMERIC NOT NULL, rate_out NUMERIC NOT NULL,
  units_in BIGINT NOT NULL, units_out BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  -- 0 open, 1 claimed, 2 settled, 3 cancelled.
  state SMALLINT NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 3),
  -- 0 none, 1 settled, 2 cancelled, 3 provider_fail, 4 reclaim, 5 expired.
  -- 5 is bounded out on purpose: `getJob` reports state 3 / cause 5 for a job
  -- that is open but past its expiry, and that pair is computed, never stored.
  -- A reconcile that writes it back unmapped would make the index disagree with
  -- a rebuild from logs, which produces 0/0 for the same job; the constraint
  -- turns that divergence into an error at the write instead of silent drift.
  ended_because SMALLINT NOT NULL DEFAULT 0 CHECK (ended_because BETWEEN 0 AND 4),
  provider_id BIGINT NOT NULL DEFAULT 0, claimed_at BIGINT NOT NULL DEFAULT 0,
  completion_tok BIGINT NOT NULL DEFAULT 0,
  task_cid BYTEA NOT NULL, result_cid BYTEA NOT NULL DEFAULT ''::bytea,
  posted_block BIGINT NOT NULL DEFAULT 0,
  as_of_block BIGINT NOT NULL
);
-- Serves the open-jobs feed: the filter is `model_id`, then `state = 0`, then a
-- range on `expires_at` — the leading columns of this index, in that order.
CREATE INDEX IF NOT EXISTS jobs_open ON jobs (model_id, state, expires_at);
CREATE INDEX IF NOT EXISTS jobs_provider ON jobs (provider_id, state);
-- The reclaim keeper's sweep: claimed rows, oldest claim first. Partial, because
-- claimed jobs are a small and self-draining slice of the table — every one of
-- them reaches a terminal state within its SLA plus a grace window — and an
-- index over the whole table would be mostly settled rows the sweep never reads.
CREATE INDEX IF NOT EXISTS jobs_reclaimable ON jobs (claimed_at) WHERE state = 1;
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs (owner);
-- The file sweep asks "does any job still name this object" once per expired
-- cid, so these two are what keep a backlog from costing a full scan of `jobs`
-- apiece. `stillNamed` compares against the column rather than a function of it
-- precisely so these are usable (see src/pin/sweep.ts). `result_cid` is partial:
-- every unsettled job carries the empty string there, and those rows are the
-- majority and are never what the sweep is looking for.
CREATE INDEX IF NOT EXISTS jobs_task_cid ON jobs (task_cid);
CREATE INDEX IF NOT EXISTS jobs_result_cid ON jobs (result_cid) WHERE result_cid <> ''::bytea;

CREATE TABLE IF NOT EXISTS providers (
  provider_id BIGINT PRIMARY KEY,
  operator BYTEA NOT NULL, box_key BYTEA,
  -- uint16 on chain, clamped to [100,1000] by the registry. BIGINT anyway: a
  -- uint16 does not fit SMALLINT (65535 > 32767), and the width rule is worth
  -- more than one saved byte per row.
  -- The default is landed on by the `ProviderRegistered` insert and overwritten
  -- by the `ReputationChanged` that `register` emits in the same transaction;
  -- it is never read as a seed. The column cannot be NOT NULL without one,
  -- because that insert carries no reputation of its own. `0` rather than any
  -- real figure, so a row still showing it reads as "not yet set" instead of
  -- quoting a seed no part of this system uses.
  reputation BIGINT NOT NULL DEFAULT 0,
  -- `capacity_requested` is the second unvalidated uint32: `requestCapacity`
  -- bounds `issuedAt` but never `n`, and any provider can sign one.
  capacity_ceiling BIGINT NOT NULL DEFAULT 0, capacity_requested BIGINT NOT NULL DEFAULT 0,
  listed BOOLEAN NOT NULL DEFAULT TRUE, allow_all_models BOOLEAN NOT NULL DEFAULT TRUE,
  -- uint32[] on chain, so the ELEMENT type carries the width rule too.
  allowed_models BIGINT[] NOT NULL DEFAULT '{}',
  -- Whatever the identity bytes decoded to: parsed JSON when they were JSON,
  -- otherwise `{"raw":"0x…"}`. Nothing on chain makes them JSON.
  evidence JSONB
);

CREATE TABLE IF NOT EXISTS models (
  model_id BIGINT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Projected from ModelEnabledChanged(uint32,bool). Without it the node cannot
  -- answer "is this model still enabled?" and post validation fronts gas on a
  -- retired model that the chain then rejects. Registration enables the model on
  -- chain and emits only ModelRegistered, so a row born from that event is
  -- enabled — hence the default.
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);

-- `status` is a uint8 on chain and every one of its 256 values fits SMALLINT
-- with room to spare, so the width rule above (which is about uint32 and uint64
-- outgrowing int4) has nothing to say here and this stays narrow.
CREATE TABLE IF NOT EXISTS allowlist (key BYTEA PRIMARY KEY, status SMALLINT NOT NULL, entry JSONB NOT NULL);

-- S3Pinner's name book (R73), and the first of the two declared non-derived
-- tables. The object store mints the CID and this node does not get to choose
-- it: `x-amz-meta-cid` may be any string, so the object key cannot in general be
-- re-derived from the name. Written by `S3Pinner.mint` inside the two calls that
-- carry bytes — the container on `POST /v1/jobs`, the result on `POST /evm/ops`
-- — and never by the reducer.
-- R44/R47: `s3_key` is the ONLY record of where a store-minted name's bytes
-- live, and no chain log carries it. Lose this table and every `taskCid` and
-- `resultCid` on the chain becomes a name this node cannot resolve to an object,
-- so the rebuild path leaves it out of its drop set exactly as it leaves
-- `quotes_live` out (see `DROPPABLE` in src/db/db.ts, which is enforced by a
-- test rather than by this comment).
CREATE TABLE IF NOT EXISTS pins (
  cid TEXT PRIMARY KEY, s3_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The sweep's retention pass runs every 60 s whether or not anything is past
-- retention, so this is the one scan it pays unconditionally.
CREATE INDEX IF NOT EXISTS pins_created_at ON pins (created_at);

-- Asks as they stand on chain. AsksPublished is an upsert, not a replace: a
-- publisher drops a slot by publishing BOTH legs zero. `rate_out = 0` alone is an
-- input-metered model quoting the only side it has, and stays a live slot.
-- `model_id` and `sla` are the remaining two unvalidated uint32s: `setAsks`
-- skips an entry for quote count, clock skew, signature, id mismatch and
-- staleness, and bounds neither of these — a provider can publish a quote naming
-- any uint32 it likes.
CREATE TABLE IF NOT EXISTS asks_chain (
  provider_id BIGINT NOT NULL, model_id BIGINT NOT NULL, sla BIGINT NOT NULL,
  rate_in NUMERIC NOT NULL, rate_out NUMERIC NOT NULL,
  PRIMARY KEY (provider_id, model_id, sla)
);

-- NOT derived from chain. Never merged into asks_chain; never touched by the reducer.
CREATE TABLE IF NOT EXISTS quotes_live (
  provider_id BIGINT PRIMARY KEY,
  snapshot JSONB NOT NULL,          -- the pushed AskSnapshot, on-chain shape; rates as decimal strings
  signature BYTEA NOT NULL,
  signed_at BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_signed_at BIGINT NOT NULL DEFAULT 0
);

-- NOT derived from chain, and NOT preserved: advisory matcher state. One row per
-- (provider, model), rewritten by every provider poll of `GET /evm/jobs` — the
-- poll is the heartbeat. Only what the challenge needs is kept: the slots the
-- daemon can start, and `last_assigned_at`, the per-model round-robin cursor a
-- challenge bumps when it names this provider first. The daemon's private
-- floors are used on the poll that carries them and never stored. A dropped row
-- costs one poll. Bounded at providers x catalog models: the poll refuses a
-- model the catalog does not carry. `free_slots` is BIGINT under R48, never INT.
CREATE TABLE IF NOT EXISTS provider_presence (
  provider_id BIGINT NOT NULL, model_id BIGINT NOT NULL,
  free_slots BIGINT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_assigned_at TIMESTAMPTZ,
  PRIMARY KEY (provider_id, model_id)
);

-- Advisory: which provider currently holds an open job, and until when. Written
-- by the provider poll that took the job, one row per job, and dropped once it
-- lapses; the chain remains the authority — a claim by any provider still
-- relays and lands. Bounded by the open book, so no caller can grow it past
-- that; `expires_at` here is a lease window, not a residency TTL.
CREATE TABLE IF NOT EXISTS job_leases (
  job_id BYTEA PRIMARY KEY,
  provider_id BIGINT NOT NULL,
  offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
-- The poll's held count and the live-lease count in the ranking.
CREATE INDEX IF NOT EXISTS job_leases_provider ON job_leases (provider_id, expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, address BYTEA NOT NULL, role TEXT NOT NULL,
  provider_id BIGINT,               -- NULL for a client session
  expires_at TIMESTAMPTZ NOT NULL
);
-- R68, applied to the second TTL table this time. `sessions` is written by the
-- same module as `nonces`, swept by the same function on the identical
-- predicate, and had neither index nor a per-address cap: one keypair was
-- measured taking 400 sessions at 90/s with no refusal, and the sweep planned as
-- a Seq Scan while the sweep of `nonces` beside it used its index. The nonce cap
-- cannot help here — `consumeNonce` deletes the row as the burn, so a caller
-- that spends each nonce as it is issued never holds two and the cap never
-- binds. Both indexes and the cap in `api/sessions.ts` are one fix; either alone
-- leaves the other half of the growth.
CREATE INDEX IF NOT EXISTS sessions_address ON sessions (address);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY, address BYTEA NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
-- R68. `issueNonce` deletes this address's expired and oldest-live rows on every
-- mint, and `GET /auth/nonce` needs no credential — so without an index on
-- `address` an unauthenticated caller sizes the table and every mint pays two
-- sequential scans of it. Measured at 510k rows: Seq Scan + a second Seq Scan in
-- the SubPlan, 11594 buffer hits, 30.6ms per request, growing linearly
-- (2.0 -> 8.5 -> 33.3 ms). Scoping the predicate to one address does not scope
-- the scan.
CREATE INDEX IF NOT EXISTS nonces_address ON nonces (address);
-- The hourly sweep's own predicate. Rows of an address that never comes back are
-- deleted by nothing else, so the sweep is what actually bounds residency.
CREATE INDEX IF NOT EXISTS nonces_expires_at ON nonces (expires_at);

-- ---------------------------------------------------------------------------
-- The batch surface
-- ---------------------------------------------------------------------------

-- `file_id -> cid`, and **that is the whole row**: the payload itself is filed
-- with the pinning service and this node keeps only the name it minted.
--
-- Q26 is the reason the batch surface came out of Plan 4, and it is this table's
-- entire subject. The old `POST /v1/files` wrote the caller's file to the node's
-- own disk and served it back — the payload at rest that container v1 exists to
-- remove. `mint` closes it: the bytes go where every container already goes, and
-- what is written down here is a locator, a length and a purpose.
--
-- PRESERVED, for exactly `pins`' reason (R44, R47): the `file_id -> cid` pair is
-- on no chain log, so a rebuild that dropped it would leave every batch naming an
-- input file this node can no longer resolve.
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  owner BYTEA NOT NULL,
  -- `batch` (a JSONL input), `input` (a sealed container) and `result` (a sealed
  -- result) are uploaded; `batch_output` is minted by the worker at finalization
  -- for BOTH frozen files and is refused at the upload door. Not `batch_error`:
  -- `openai`'s FileObject.purpose is a closed Literal that has no such value, so
  -- a file object carrying it fails their own parse. Output and error are told
  -- apart by which column of `batches` names them.
  purpose TEXT NOT NULL,
  filename TEXT NOT NULL,
  -- The object's length. BIGINT under R48: it is not a chain width, but it is a
  -- size no `INT` should be trusted to hold on the day the cap moves.
  bytes BIGINT NOT NULL,
  cid TEXT NOT NULL,
  -- OpenAI's own, deprecated on their side and still emitted: uploaded | processed | error.
  status TEXT NOT NULL DEFAULT 'uploaded',
  -- Lines, counted once at upload. Kept because the create door refuses a batch
  -- past the cap and would otherwise have to read the whole object back to know.
  lines BIGINT NOT NULL DEFAULT 0,
  -- The container commitment `c`, 32 bytes, for `purpose='input'` only: the
  -- upload door is the one place the sealed bytes stream past, so it computes
  -- `c` there and the post door compares the client's signed `c` against it
  -- rather than reading the object back.
  commitment BYTEA,
  created_at BIGINT NOT NULL,
  -- Unix seconds, and when the sweep (src/pin/sweep.ts) deletes this row and the
  -- object behind it. `created_at + 300` at upload — an upload nobody attaches to
  -- a job or a batch is not storage this node owes anyone — and
  -- `created_at + FILE_RETENTION_SECONDS` once something attaches it.
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner);
-- Two lookups by name: the post and settle doors resolve an upload the caller
-- referenced by cid, and the sweep asks whether any row still names one. `cid`
-- predates this round, so the index may sit above the ALTER block.
CREATE INDEX IF NOT EXISTS files_cid ON files (cid);
-- The sweep's own predicate.
CREATE INDEX IF NOT EXISTS files_expires_at ON files (expires_at);

-- NOT derived from chain: the row **is** the client's record of its batch.
--
-- Nothing on chain or on the wire says a job belongs to a batch — every line is
-- an independent designated order, which is what lets one batch spread across
-- providers with no coordination. So a replay reproduces every member job and
-- nothing that groups them: drop this table and the batch its caller created is
-- gone while its jobs stand. That puts it in PRESERVED beside `pins`,
-- `batch_lines` and `quotes_live`.
--
-- `custom_id` is deliberately absent: it is the caller's own text, it travels
-- sealed inside each line's container, and it is echoed back inside the sealed
-- result. It never reaches this node in the clear and must not be stored here.
CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  owner BYTEA NOT NULL,
  endpoint TEXT NOT NULL,
  completion_window BIGINT NOT NULL,   -- seconds; mirrors the SLA window
  input_file_id TEXT NOT NULL,
  output_file_id TEXT,                 -- minted once, at finalization (frozen, then pinned)
  error_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'validating',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  in_progress_at BIGINT, finalizing_at BIGINT, completed_at BIGINT,
  failed_at BIGINT, expired_at BIGINT, cancelling_at BIGINT, cancelled_at BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS batches_owner ON batches (owner);

-- Which job is which line, and **the only record of it** — which is why this
-- table is PRESERVED rather than dropped. Nothing on chain says a job belongs to
-- a batch, so a replay brings back every member job and no way to attribute one.
--
-- `job_id` is nullable because a line that was skipped on chain (`postMany`
-- answers `PostSkipped` rather than reverting) has no job to name. `skip_reason`
-- is the raw revert data that came back with it, which is what the error file
-- row for that line is written from.
CREATE TABLE IF NOT EXISTS batch_lines (
  batch_id TEXT NOT NULL REFERENCES batches (batch_id) ON DELETE CASCADE,
  -- BIGINT, not INT. `line_no` is this file's own invention and 50 000 lines fit an int4
  -- with room to spare — but the width rule above is mechanical on purpose, and the one
  -- exception (`cursor.id`) earns it with a CHECK that pins the value. Arguing this one is
  -- safe by reachability is exactly the reasoning that produced the four columns R48 found.
  line_no BIGINT NOT NULL,
  job_id BYTEA,
  task_cid TEXT,
  skip_reason TEXT,
  PRIMARY KEY (batch_id, line_no)
);
-- The fold that produces a batch's status and counts walks its lines; the
-- reverse lookup (which batch does this settled job belong to) is what the job
-- terminal handler needs.
CREATE INDEX IF NOT EXISTS batch_lines_job_id ON batch_lines (job_id);
-- The other half of the sweep's `stillNamed`: a line's container is filed before
-- the batch row exists, so a line is as good a reason to keep an object as a job.
CREATE INDEX IF NOT EXISTS batch_lines_task_cid ON batch_lines (task_cid);

-- Row-level security on every table, and no policies. Hosted Postgres (Supabase)
-- exposes the public schema to its `anon` and `authenticated` roles over its
-- REST API; with RLS on and no policy they read and write nothing. The node
-- connects as the tables' owner, which RLS does not bind unless FORCEd. A loop
-- rather than a list, so it also covers `schema_migrations`. Filtered on
-- `relrowsecurity` because the ALTER takes an exclusive lock, and an ordinary
-- boot must not take one.
DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace
      AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
