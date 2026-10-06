import { Type } from "typebox";
import { orphanBookFilter, POSTING_KNOWN } from "../../escrow/orphans.js";
import type { KeyEpochStart } from "../../escrow/release.js";
import { chainParams, type Chain, type ChainParams } from "../../chain/client.js";
import { viewRead } from "../chain-failure.js";
import { chainGate, requireChain, sessionGate, sessionOf, type App, type RouteDeps } from "../deps.js";
import { ApiError, badRequest } from "../errors.js";
import { budgeted, pageOf, Paging } from "../paging.js";
import {
  Address,
  AsOfBlock,
  BEARER,
  errors,
  Hex32,
  HexOut,
  Int,
  Nullable,
  SafeUint,
  Uint32,
  Usd,
  UsdOut,
} from "../schemas/common.js";
import { cid } from "../wire.js";
import { usdParam } from "../usd.js";
import { formatUsd } from "../../money.js";
import { leaseOpenJobs } from "../../match/lease.js";
import { upsertPresence } from "../../match/rank.js";

/**
 * The job book: the chain-shaped listing and detail, and the client-shaped view.
 *
 * **Openness is computed, never stored** (R3, R43). There is no `is_open`
 * column, the database rejects `ended_because = 5`, and every query that cares
 * writes the predicate out. A job past its expiry reads as
 * `state 3 / ended_because 5`, exactly as `getJob` reports it, while the stored
 * row is still what the reducer wrote.
 *
 * **The comparison is the contract's, to the second** (R78, A-D). `JobRegistry`
 * derives an ending only when `block.timestamp > j.expiresAt` (`:526`), and
 * `claim` lets a claim landing *at* `expiresAt` through with a comment saying so
 * (`:242`, which agrees with the payment authorization's `validBefore = expiresAt + 1` at that instant).
 * So a job whose `expires_at` is exactly now is **still open**. This node said
 * the opposite for one second: `expires_at > now` for Open and
 * `expires_at <= now` for expired, which hid a job the chain would still let a
 * provider claim and reported it `Cancelled` a second early. Nothing caught it
 * because every fixture probed a far future and a long past, never the edge —
 * which is R78's entire point, and it took writing the edge test to find that
 * the code, believed right, was wrong by one.
 */

/** The node's clock, as unix seconds, to compare against `expires_at`. */
export const NOW = "floor(extract(epoch from now()))::bigint";

/**
 * Open but past its expiry: the pair `getJob` reports as `state 3 / cause 5`.
 *
 * `<`, not `<=`: expired means `now > expires_at`, so equality is still open.
 */
export const EXPIRED = `(state = 0 AND expires_at < ${NOW})`;

/**
 * The chain-shaped job projection, with the view state computed the way the
 * contracts compute it. `state` and `ended_because` are the *derived* pair; the
 * stored columns are never rewritten (R3).
 */
const JOB_COLUMNS = `
  job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
  units_in, units_out, expires_at,
  CASE WHEN ${EXPIRED} THEN 3 ELSE state END AS state,
  CASE WHEN ${EXPIRED} THEN 5 ELSE ended_because END AS ended_because,
  provider_id, claimed_at, completion_tok, task_cid, result_cid, posted_block, gas_fee, fee`;

/**
 * Per R45, every row type here is derived from the column's SQL type and not
 * from what is convenient at the call site: `BIGINT` and `NUMERIC` → `bigint`,
 * `SMALLINT` → `number`, `BYTEA` → `Buffer`.
 */
interface JobRow {
  job_id: Buffer;
  owner: Buffer;
  c: Buffer;
  model_id: bigint;
  sla_secs: bigint;
  designated: bigint;
  rate_in: bigint;
  rate_out: bigint;
  units_in: bigint;
  units_out: bigint;
  expires_at: bigint;
  state: number;
  ended_because: number;
  provider_id: bigint;
  claimed_at: bigint;
  completion_tok: bigint;
  task_cid: Buffer;
  result_cid: Buffer;
  posted_block: bigint;
  gas_fee: bigint;
  fee: bigint;
}

/**
 * The chain-shaped row. `bigint`s and `Buffer`s are the serializer's problem.
 *
 * No `as_of_block`: it describes the *answer*, not the row, so it belongs once
 * on the envelope. The detail routes add it there, exactly as `/evm/providers`
 * does — repeating it on every element of a listing would be one copy per row of
 * a value that is the same for all of them.
 */
const evmJob = (row: JobRow, decimals: number) => ({
  job_id: row.job_id,
  owner: row.owner,
  c: row.c,
  model_id: row.model_id,
  sla_secs: row.sla_secs,
  designated: row.designated,
  rate_in: formatUsd(row.rate_in, decimals),
  rate_out: formatUsd(row.rate_out, decimals),
  units_in: row.units_in,
  units_out: row.units_out,
  expires_at: row.expires_at,
  state: row.state,
  ended_because: row.ended_because,
  provider_id: row.provider_id,
  claimed_at: row.claimed_at,
  completion_tok: row.completion_tok,
  task_cid: cid(row.task_cid),
  result_cid: cid(row.result_cid),
  posted_block: row.posted_block,
  gas_fee: formatUsd(row.gas_fee, decimals),
  fee: formatUsd(row.fee, decimals),
});

/**
 * The client-facing status, computed from the **view** state.
 *
 * A literal port of the emulator's `clientStatus` reads the stored state and
 * answers `queued` for an expired order — a job that can never be claimed. The
 * emulator materialised expiry; this node never does, so expiry has to be
 * resolved before the mapping, not after it.
 */
function clientStatus(state: number, endedBecause: number): string {
  switch (state) {
    case 0:
      return "queued";
    case 1:
      return "in_progress";
    case 2:
      return "completed";
    default:
      // 3 provider_fail, 4 reclaim — both are failures of delivery. 2 cancelled
      // and 5 expired are not: nobody was ever on the hook.
      return endedBecause === 3 || endedBecause === 4 ? "failed" : "cancelled";
  }
}

const clientJob = (row: JobRow, decimals: number, model: string | null, asOfBlock: bigint | null) => ({
  id: row.job_id,
  object: "job",
  model,
  status: clientStatus(row.state, row.ended_because),
  in_progress_at: row.claimed_at === 0n ? null : row.claimed_at,
  result_cid: cid(row.result_cid),
  vorq: {
    job_id: row.job_id,
    owner: row.owner,
    model_id: row.model_id,
    sla_secs: row.sla_secs,
    rate_in: formatUsd(row.rate_in, decimals),
    rate_out: formatUsd(row.rate_out, decimals),
    units_in: row.units_in,
    units_out: row.units_out,
    designated: row.designated,
    provider_id: row.provider_id,
    expires_at: row.expires_at,
    task_cid: cid(row.task_cid),
    completion_tok: row.completion_tok,
    state: row.state,
    ended_because: row.ended_because,
    gas_fee: formatUsd(row.gas_fee, decimals),
    fee: formatUsd(row.fee, decimals),
  },
  as_of_block: asOfBlock,
});

/**
 * Open: on the book, and claimable right now.
 *
 * `>=`, not `>`: the chain expires a job only once `now` is STRICTLY past
 * `expiresAt`, so the expiry second itself is still Open (R78).
 *
 * Exported and used twice — by the `Open` listing and by Plan 3's escrow-orphan
 * filter, which suppresses only what the book *advertises*. One definition on
 * purpose: two copies of this rule already disagreed once by a second, and the
 * orphan filter would have been the second copy.
 */
export const OPEN = `state = 0 AND expires_at >= ${NOW}`;

/** The four listings, one per chain state. Together they partition the book. */
const STATE_FILTERS = new Map<JobState, string>([
  ["Open", OPEN],
  ["Claimed", "state = 1"],
  ["Settled", "state = 2"],
  // An expired order fell out of Open and has to reappear here, or it is in
  // no listing at all.
  ["Cancelled", `(state = 3 OR ${EXPIRED})`],
]);

/**
 * The two orders the listing serves. Both are total (`job_id` breaks every
 * tie), which is what makes offset paging over them stable.
 *
 * `newest` puts an UNKNOWN block first: `posted_block = 0` is a row reconcile
 * inserted ahead of its log — the newest job on the book, not the oldest
 * (see `posted_before` below). `oldest` is the ascending order this route has
 * always served, where 0 is first for the same reason.
 */
const ORDERS = new Map<"oldest" | "newest", string>([
  ["oldest", "posted_block, job_id"],
  ["newest", "NULLIF(posted_block, 0) DESC NULLS FIRST, job_id DESC"],
]);

type JobState = "Open" | "Claimed" | "Settled" | "Cancelled";

const Cid = Nullable(Type.String({ description: "The storage name; `null` when not set." }));

const EvmJob = Type.Object({
  job_id: HexOut("keccak256(owner ‖ c)."),
  owner: HexOut(),
  c: HexOut("The commitment to the sealed container."),
  model_id: Int(),
  sla_secs: Int(),
  designated: Int("The provider the order is designated to; 0 for an open order."),
  rate_in: UsdOut(),
  rate_out: UsdOut(),
  units_in: Int(),
  units_out: Int(),
  expires_at: Int("Unix seconds."),
  state: Type.Integer({ description: "0 Open, 1 Claimed, 2 Settled, 3 Ended." }),
  ended_because: Type.Integer({
    description: "0 none, 2 cancelled, 3 provider fail, 4 reclaimed, 5 expired.",
  }),
  provider_id: Int(),
  claimed_at: Int(),
  completion_tok: Int(),
  task_cid: Cid,
  result_cid: Cid,
  posted_block: Int("0 when not yet known."),
  gas_fee: UsdOut(
    "The relay gas fee snapshotted at post: the treasury keeps it on every exit of a claimed job.",
  ),
  fee: UsdOut("The protocol fee settlement took on top of the charge; 0 for a job that did not settle."),
});

const JobsQuery = Type.Object({
  state: Type.Optional(
    Type.Enum(["Open", "Claimed", "Settled", "Cancelled"], {
      description: "Cancelled includes expired.",
    }),
  ),
  model: Type.Optional(Uint32({ description: "An integer `model_id`." })),
  provider: Type.Optional(Uint32()),
  owner: Type.Optional(Address()),
  order: Type.Optional(
    Type.Enum(["oldest", "newest"], { default: "oldest" }),
  ),
  min_rate_in: Type.Optional(Usd()),
  min_rate_out: Type.Optional(Usd()),
  posted_before: Type.Optional(Uint32({ description: "Posted at or before this block." })),
  free: Type.Optional(
    Uint32({
      description:
        "The provider poll: lease up to this many open jobs to the caller's provider session. " +
        "Needs a provider session, `state=Open` and `model`.",
    }),
  ),
  ...Paging,
});

/**
 * @param keyEpochStart when this node's custody of its key material began, or
 * `null` — read **fresh on every request**, because a handover replaces it
 * (Task 5) and a value captured at registration time would be wrong for the rest
 * of the process's life. Absent, and at `ESCROW_MODE=off`, nothing is
 * filtered.
 */
export function jobRoutes(
  gated: App,
  deps: RouteDeps,
  asOfBlock: () => Promise<bigint | null>,
  keyEpochStart: () => KeyEpochStart | null = () => null,
): void {
  const { db } = deps;
  const { decimals } = deps.config.addresses;
  // The summary prices escrow at the live `feeBps`, through the same 60 s cell
  // `/evm/chain` keeps, so the read is an `eth_call` a minute, not one a hit.
  let params: ChainParams | null = null;
  const configOf = (chain: Chain): ChainParams =>
    (params ??= chainParams(chain, deps.config.addresses));

  // The poll's session gate: `free` is the only parameter that makes this
  // listing anybody's in particular, so only a request carrying it is gated.
  const pollGate = sessionGate(db);

  gated.get(
    "/evm/jobs",
    {
      onRequest: async (request) => {
        if ((request.query as Record<string, unknown>).free !== undefined) await pollGate(request);
      },
      schema: {
        tags: ["jobs"],
        summary: "The job book",
        description:
          "Ordered `posted_block, job_id` (or newest first), so filters — not deep paging — are how " +
          "a caller reaches the bids it can act on. With `free`, the provider poll: the same call " +
          "leases matching open jobs to the caller and is its liveness heartbeat.",
        security: BEARER,
        querystring: JobsQuery,
        response: {
          200: Type.Object({ jobs: Type.Array(EvmJob), as_of_block: AsOfBlock }),
          ...errors(400, 401, 403, 503),
        },
      },
    },
    async (request, reply) => {
    const where: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => `$${params.push(value)}`;
    const { state, model, provider, owner } = request.query;

    if (state !== undefined) where.push(STATE_FILTERS.get(state) as string);

    // An integer `model_id`, not a model name (R26). Breaking change from the
    // emulator, and deliberate: the chain has no notion of a model name, and
    // resolving one here would make the book's filter depend on the catalog.
    if (model !== undefined) where.push(`model_id = ${bind(BigInt(model))}`);
    if (provider !== undefined) where.push(`provider_id = ${bind(BigInt(provider))}`);
    if (owner !== undefined) where.push(`owner = ${bind(Buffer.from(owner.slice(2), "hex"))}`);

    const orderBy = ORDERS.get(request.query.order ?? "oldest") as string;

    /**
     * **No index was added for these three, and the measurement says why.**
     *
     * Measured on a seeded 500 k-row book (200 k open, ~25 k open per model)
     * against `jobs_open (model_id, state, expires_at)`: with and without the
     * filters the plan is the *same shape* — one bitmap index scan on
     * `jobs_open`, then these predicates as a `Filter`, then the top-N sort —
     * and touches the *same* 17 242 heap blocks. The rows were already being
     * fetched, so the filters are structurally free and there is no regression
     * to index away. A probe `(model_id, rate_out) WHERE state = 0` did cut the
     * heap fetch to ~2 400 blocks at a highly selective floor, but the floor is
     * load-derived and moves, the planner declined the index outright at the
     * median, and a new `CREATE INDEX` migration is a non-concurrent build
     * under the migration advisory lock, on the node's hottest write table.
     *
     * **Reopen when** a `GET /evm/jobs` sweep carrying these filters exceeds
     * ~50 ms in Fastify's own request log (`responseTime` on the `res` line;
     * `main.ts` runs with `logger: true`). Latency is the whole trigger — the
     * ~25 k-open-rows-per-model figure above is where it was measured and found
     * fine, so it is a calibration point and not a threshold to wait for.
     *
     * **What the remedy does not cover.** A sweep sent *without* `model` cannot
     * use `jobs_open` at all — its leading column is `model_id` — and already
     * parallel-seq-scans the whole table today, filters or no filters. That plan
     * degrades with the size of the whole book rather than one model's slice,
     * and a `(model_id, rate_out)` index would not touch it. If that is the path
     * that gets slow, the answer is a different index, or requiring `model`.
     */
    /**
     * The book, narrowed to what a caller can actually act on.
     *
     * This exists because the listing is **bounded and, by default, ordered
     * oldest-first**: `PAGE_DEFAULT_LIMIT` rows of `ORDER BY posted_block,
     * job_id`. A caller that does not page therefore reads the hundred oldest
     * open bids and nothing else, so on a large book a queue of cheap stale
     * orders hides every profitable bid permanently behind it — a provider
     * sitting idle in front of work it would take. Paging past that is
     * `OFFSET n` at O(n) and the wrong answer (see `paging.ts`); filtering here
     * is the right one.
     *
     * The USD floors are converted to the atomic rates the rows hold.
     */
    const { min_rate_in: minRateIn, min_rate_out: minRateOut } = request.query;
    if (minRateOut !== undefined) {
      where.push(`rate_out >= ${bind(usdParam(minRateOut, decimals, "min_rate_out", true).toString())}`);
    }
    if (minRateIn !== undefined) {
      where.push(`rate_in >= ${bind(usdParam(minRateIn, decimals, "min_rate_in", true).toString())}`);
    }

    /**
     * Bid age, in the only unit the row actually carries. `posted_block` is
     * chain data the indexer already stores and this projection already serves,
     * and the envelope carries `as_of_block` — so age is
     * `as_of_block - posted_block` from data already on the wire. Nothing here
     * derives or stores a time, and no column is added. `<=`, so the named block
     * is included: "posted by block N".
     *
     * **{@link POSTING_KNOWN} is not optional here (I9).** `posted_block` is
     * `DEFAULT 0` and 0 means *unknown*, never *ancient*: `reconcileJob` inserts
     * a row from `getJob` — which carries no posting block — ahead of the
     * reducer's `Posted` event, so the column reads 0 on exactly the newest jobs
     * in the book. Without the guard every reconciled, not-yet-reduced bid
     * satisfies *every* `posted_before` bound and is served to an age-filtering
     * caller as maximally old, which is the answer inverted. Excluding it is the
     * right call and costs nothing: a caller asking for old bids is not asking
     * for this one, and an unfiltered sweep — the normal case — never reaches
     * this clause. Same constant as the escrow-orphan clause below, so the two
     * readings of block 0 cannot diverge.
     */
    const postedBefore = request.query.posted_before;
    if (postedBefore !== undefined) {
      where.push(`(${POSTING_KNOWN} AND posted_block <= ${bind(BigInt(postedBefore))})`);
    }

    // Plan 3, Task 6: an open, undesignated job posted before this node's keys
    // began carries a wrap naming a key nobody holds, so the book stops offering
    // it. ANDed in unconditionally rather than only under `state=Open`, because
    // the unfiltered listing advertises open jobs too — a guard fixed on one
    // door and not its sibling is this project's recurring defect. The clause
    // carries its own openness term, so nothing outside the Open book is
    // touched. Nothing is deleted and no detail route filters: see
    // `escrow/orphans.ts`.
    const orphans = orphanBookFilter(deps.config.escrow.mode, keyEpochStart(), OPEN, bind);
    if (orphans !== null) where.push(orphans);

    /**
     * The provider poll. `free` turns the open book into **this provider's**
     * assignments: a work queue with a visibility timeout, where the caller
     * states what it will accept (`model`, the floors above) and how much it
     * can start (`free`), and the node hands it the oldest open jobs that pass,
     * for `MATCH_LEASE_MS`, then answers only what the caller holds. Nobody
     * else sees those rows on their poll until the lease lapses; the chain
     * still decides every claim.
     *
     * The same call is the heartbeat: it records the caller's presence for the
     * model — free slots and freshness, never the floors, which are used here
     * and discarded — so a daemon that stops polling stops being named on a
     * challenge one liveness window later.
     *
     * **The first door to read `session.providerId`.** Every other provider
     * door takes its identity from an operator signature, and R14 keeps the
     * session a transport gate. Here there is nothing to sign — a poll
     * authorises nothing — so the ambient identity the handshake bound to the
     * token is the only identity there is, which `auth.ts` sanctions for
     * exactly this case. A client session, or a provider session whose wallet
     * resolved to no registry id, is refused: nobody leases to an id that does
     * not exist. Without `free` the book stays session-blind: the same URL is
     * the public listing for every other reader.
     */
    const freeSlots = request.query.free;
    if (freeSlots !== undefined) {
      const session = sessionOf(request);
      if (session.role !== "provider" || session.providerId === null) {
        throw new ApiError(
          403,
          "authentication",
          "a provider session is required: leases are held by registry id",
          null,
          "not_registered",
        );
      }
      if (state !== "Open") throw badRequest("free needs state=Open", "state");
      if (model === undefined) throw badRequest("free needs model", "model");
      // The catalog bounds the presence table at providers x models. Without
      // this one registered provider could write a row per uint32.
      const known = await db.query("SELECT 1 FROM models WHERE model_id = $1", [model.toString()]);
      if (known.rows.length === 0) throw badRequest("model is not in the catalog", "model");

      const providerId = session.providerId;
      await db.tx(async (tx) => {
        await upsertPresence(tx, { providerId, modelId: BigInt(model), freeSlots: BigInt(freeSlots) });
        await leaseOpenJobs(tx, {
          providerId,
          free: BigInt(freeSlots),
          leaseMs: deps.config.match.leaseMs,
          filter: where.join(" AND "),
          params,
        });
      });
      where.push(
        "job_id IN (SELECT job_id FROM job_leases" +
          ` WHERE provider_id = ${bind(providerId.toString())} AND expires_at > now())`,
      );
    }

    // A total order, which is what makes paging over it stable: `posted_block`
    // alone ties for every job posted in the same block.
    const page = pageOf(request.query);
    const asOf = await asOfBlock();
    const { rows } = await db.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs` +
        (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
        ` ORDER BY ${orderBy} LIMIT ${bind(page.limit)} OFFSET ${bind(page.offset)}`,
      params,
    );

    return { jobs: budgeted(rows, page, reply, (row) => evmJob(row, decimals)), as_of_block: asOf };
    },
  );

  /**
   * One wallet's totals: counts and the escrow ceilings summed, per model.
   *
   * `ceiling` is `JobRegistry._atomicCharge` (`JobRegistry.sol:616-628`) in
   * integer NUMERIC arithmetic — `div()` is exact integer division, `+ 999999`
   * makes it a ceiling, `GREATEST(1, …)` is the contract's one-unit floor.
   * Never `/` and `CEIL` on NUMERIC: the quotient's scale is the planner's
   * choice, not the contract's. `completed` is the stored `state = 2`; expiry
   * never rewrites a settled row.
   *
   * `owner` is REQUIRED: per owner this walks `jobs_owner`; over the whole
   * book it is a full scan any anonymous caller could trigger. Unpaged, because
   * `post` validates `model_id` against the catalog, so a wallet's groups are
   * bounded by the catalog.
   */
  const Totals = {
    jobs: Int(),
    completed: Int(),
    escrowed: UsdOut(
      "What claims lock, summed: each cap, the protocol fee on it at today's `fee_bps`, and its gas fee, in USD.",
    ),
  };

  gated.get(
    "/evm/jobs/summary",
    {
      onRequest: chainGate(deps.chain),
      schema: {
        tags: ["jobs"],
        summary: "One wallet's totals",
        description: "Counts and summed escrow, overall and per model.",
        querystring: Type.Object({ owner: Address() }),
        response: {
          200: Type.Object({
            ...Totals,
            by_model: Type.Array(Type.Object({ model_id: Int(), ...Totals })),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 503),
        },
      },
    },
    async (request) => {
    const key = Buffer.from(request.query.owner.slice(2), "hex");
    const chain = requireChain(deps.chain);
    const asOf = await asOfBlock();
    // R77: an unreadable `feeBps` is an unreachable endpoint, never a verdict on this GET.
    const feeBps = await viewRead("config_read", () => configOf(chain).feeBps());

    const { rows } = await db.query<{
      model_id: bigint;
      jobs: bigint;
      completed: bigint;
      escrowed: bigint;
    }>(
      `SELECT model_id,
              COUNT(*) AS jobs,
              COUNT(*) FILTER (WHERE state = 2) AS completed,
              SUM(ceiling + div(ceiling * $2, 10000) + gas_fee) AS escrowed
         FROM (
           SELECT model_id, state, gas_fee,
                  GREATEST(1, div(rate_in * units_in + rate_out * units_out + 999999, 1000000)) AS ceiling
             FROM jobs
            WHERE owner = $1
         ) j
        GROUP BY model_id
        ORDER BY model_id`,
      [key, feeBps],
    );

    const total = { jobs: 0n, completed: 0n, escrowed: 0n };
    const byModel = rows.map((row) => {
      total.jobs += row.jobs;
      total.completed += row.completed;
      total.escrowed += row.escrowed;
      return {
        model_id: row.model_id,
        jobs: row.jobs,
        completed: row.completed,
        escrowed: formatUsd(row.escrowed, decimals),
      };
    });
    return {
      ...total,
      escrowed: formatUsd(total.escrowed, decimals),
      by_model: byModel,
      as_of_block: asOf,
    };
    },
  );

  /**
   * One job from the projection, or a 404. **Never a chain read.**
   *
   * A miss used to reconcile against `getJob`, to bridge the finality window: a
   * post answers off the latest receipt while the indexer reaches that block a
   * poll later.
   * Both post doors now write the row from that receipt before answering (see
   * `index/write-through.ts`), so a miss is a job **this node** has no record of:
   * either nobody posted it, or its row has not been written yet. That also retires the scan concern the chain read carried: a
   * caller walking random ids costs one indexed `SELECT` each, not two RPC round
   * trips.
   *
   * What that gives up, named rather than implied: a job posted to the registry
   * by somebody else — a client relaying its own `post`, or a second coordinator
   * — has no receipt this node ever saw, so it now `404`s until its indexed log
   * reaches the indexer where the reconcile used to serve it inside that window.
   * The same holds for the two swallowed write-throughs (`routes/post.ts`,
   * `batches/worker.ts`) and for a crash between a broadcast and its timeout
   * marker. Every one of them is a job this node is not the source of truth for,
   * and the indexer closes all of them.
   */
  async function jobRow(jobId: string): Promise<JobRow> {
    const key = Buffer.from(jobId.slice(2), "hex");
    const { rows } = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = $1`, [key]);
    const row = rows[0];
    if (row !== undefined) return row;

    throw new ApiError(404, "not_found", `no such job: ${jobId}`);
  }

  gated.get(
    "/evm/jobs/:job_id",
    {
      schema: {
        tags: ["jobs"],
        summary: "Read one job",
        params: Type.Object({ job_id: Hex32() }),
        response: {
          200: Type.Object({ ...EvmJob.properties, as_of_block: AsOfBlock }),
          ...errors(400, 404, 503),
        },
      },
    },
    async (request) => {
    const row = await jobRow(request.params.job_id);
    // Read **after** the row, unlike the listings: a write-through row can sit
    // past the cursor, and a stamp taken before the read would understate the
    // freshness of the answer it goes out with.
    const asOf = await asOfBlock();
    return { ...evmJob(row, decimals), as_of_block: asOf };
    },
  );

  gated.get(
    "/v1/jobs/:id",
    {
      schema: {
        tags: ["jobs"],
        summary: "Read one job (client view)",
        description: "`status` is computed from the chain state, expiry included.",
        params: Type.Object({ id: Hex32({ description: "The job id." }) }),
        response: {
          200: Type.Object({
            id: HexOut(),
            object: Type.Literal("job"),
            model: Nullable(Type.String()),
            status: Type.Union(
              ["queued", "in_progress", "completed", "failed", "cancelled"].map((s) => Type.Literal(s)),
            ),
            in_progress_at: Nullable(Int("Unix seconds of the claim.")),
            result_cid: Cid,
            vorq: Type.Object({
              job_id: HexOut(),
              owner: HexOut(),
              model_id: Int(),
              sla_secs: Int(),
              rate_in: UsdOut(),
              rate_out: UsdOut(),
              units_in: Int(),
              units_out: Int(),
              designated: Int(),
              provider_id: Int(),
              expires_at: Int(),
              task_cid: Cid,
              completion_tok: Int(),
              state: Type.Integer(),
              ended_because: Type.Integer(),
              gas_fee: UsdOut(),
              fee: UsdOut(),
            }),
            as_of_block: AsOfBlock,
          }),
          ...errors(400, 404, 503),
        },
      },
    },
    async (request) => {
    const row = await jobRow(request.params.id);
    const asOf = await asOfBlock();
    // Left as its own read rather than a join: the catalog is tiny, and a job
    // whose model was never registered still has to be servable.
    const { rows } = await db.query<{ name: string }>(
      "SELECT name FROM models WHERE model_id = $1",
      [row.model_id],
    );
    return clientJob(row, decimals, rows[0]?.name ?? null, asOf);
    },
  );
}
