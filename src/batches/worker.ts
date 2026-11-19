import type { Hex } from "viem";
import { chainParams, type Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { fundsLeft, underOwnerFunds } from "../api/funding.js";
import { holdOrder } from "../match/held.js";
import { put, type Pinner } from "../pin/pinner.js";
import { attachFile } from "../api/routes/files.js";
import { finalizeBatch } from "./finalize.js";
import { admitLine, type AdmittedLine, type LineContext } from "./lines.js";

/**
 * The batch worker's **holding pass**: a `validating` batch becomes `in_progress`.
 *
 * ```
 *   read the input object   one fetch, by the CID the `files` row names
 *   split                   one line, one prospective job
 *   admit                   no store, no chain (`lines.ts`)
 *   fund                    each owner's balance, less its open orders, in file order
 *   file                    one container per admitted line that inlined one;
 *                           the name minted for it IS that line's `task_cid`,
 *                           and a line that named an upload already has one
 *   hold                    under each owner's funds queue, funded again in file
 *                           order, then a `batch_lines` row and a held order per
 *                           line, together
 *   stamp                   in_progress, and the fold owns the batch from here
 * ```
 *
 * Nothing is relayed. Each line becomes a held order exactly as a single
 * `POST /v1/jobs` does (`match/held.ts`), and goes on chain inside the claim a
 * provider signs for it.
 *
 * ## Why this cannot be the create request
 *
 * 50 000 lines is 50 000 pins against a service rate-limited to 100 req/s —
 * eight minutes at the ceiling. `POST /v1/batches` answers `validating` and
 * returns; this runs behind it. OpenAI's own `validating → in_progress`
 * lifecycle exists for exactly this, and it is what makes skip-with-receipt the
 * only coherent create semantics: an all-or-nothing refusal would throw away
 * 49 999 good lines, and the pinning already spent on them, for one line with a
 * typo.
 *
 * ## `batch_lines` is the record, and it is preserved
 *
 * **Nothing on chain says a job belongs to a batch** — every line is an
 * independent order, which is exactly what lets one batch spread across
 * providers with no coordination. So `batch_lines` is the only record of which
 * line is which job, it is in `PRESERVED` (`src/db/db.ts`), and this pass writes
 * it rather than a manifest object anybody would have to read back.
 *
 * A line's `batch_lines` row and its held order are written in **one
 * transaction**, so a crash leaves a line either decided and held or undecided
 * and absent. A resumed pass therefore reprocesses **only lines with no row at
 * all**: a row is a decision, and a decision is not revisited.
 */

/**
 * How many containers are filed at once.
 *
 * The storage service is rate-limited to 100 requests a second and a batch is up
 * to 50 000 objects; this is the backpressure. Deliberately well under the
 * ceiling: the same service is on the request path of `POST /v1/jobs` and the
 * settle door, and a worker that saturated it would answer `503 pinner_unavailable`
 * to every live client for the eight minutes it spent filing a batch.
 */
const PIN_CONCURRENCY = 8;

/**
 * How many of one owner's lines are funded and held per turn of its funds queue.
 *
 * The queue is the one that owner's posts and withdrawals wait in, so a batch of
 * 50 000 lines holds it a chunk at a time rather than for the whole file.
 */
const HOLD_CHUNK = 256;

/**
 * How often the worker looks for work.
 *
 * Not configurable, and it does not need to be: it bounds how long a batch sits
 * in `validating` before its first line is held, and against a 1 h floor on the
 * completion window fifteen seconds is noise. A shorter interval would only poll
 * an empty table faster.
 */
export const BATCH_WORKER_INTERVAL_MS = 15_000;

export interface BatchWorkerDeps {
  db: Db;
  config: Config;
  chain: Chain | null;
  pinner: Pinner;
}

/** What one pass did. Returned for the log, and for the tests to assert on. */
export interface HoldRun {
  batchId: string;
  /** Lines held as orders. */
  held: number;
  skipped: number;
}

interface BatchRow {
  batch_id: string;
  endpoint: string;
  owner: Buffer;
  input_file_id: string;
  cancelling_at: string | null;
  cid: string | null;
}

/** One line's decision, before anything is written down. */
type Decision =
  /**
   * `gasFee` is the one this batch was priced at: what the line's amount
   * includes. `feeBps` prices the owner's other open orders when it is funded.
   */
  | { lineNo: number; kind: "hold"; line: AdmittedLine; taskCid: string; gasFee: bigint; feeBps: number }
  | { lineNo: number; kind: "skip"; reason: string };

/**
 * Hold one batch's lines. `null` when there was nothing to do — the batch is not
 * `validating`, or its input object is gone and the batch has been failed.
 *
 * Throws on an outage — a store that will not file bytes, an endpoint that will
 * not answer — leaving the batch `validating` for the next pass. That is the
 * retry, and it is free: object names are content hashes, so re-filing the same
 * container is the same object under the same name.
 */
export async function holdBatch(deps: BatchWorkerDeps, batchId: string): Promise<HoldRun | null> {
  const { rows } = await deps.db.query<BatchRow>(
    `SELECT b.batch_id, b.endpoint, b.owner, b.input_file_id, b.cancelling_at, f.cid
       FROM batches b LEFT JOIN files f ON f.file_id = b.input_file_id
      WHERE b.batch_id = $1 AND b.status = 'validating'`,
    [batchId],
  );
  const batch = rows[0];
  if (batch === undefined) return null;

  // The batch's input file, under the ceiling the create door admitted it at.
  // That cap and {@link MAX_BATCH_LINES} are the only two bounds on a batch:
  // no line carries a size rule of its own.
  const content =
    batch.cid === null ? null : await deps.pinner.fetch(batch.cid, { maxBytes: deps.config.maxBlobBytes });
  if (content === null) {
    // The input file is the one thing this pass cannot do without and the one
    // thing it cannot rebuild: the containers are inside it. `failed` is the
    // batch's own verdict on its input, which is exactly what OpenAI's `failed`
    // means, and it is terminal — there is nothing to retry against.
    await deps.db.query(
      "UPDATE batches SET status = 'failed', failed_at = $2 WHERE batch_id = $1",
      [batchId, nowSeconds()],
    );
    return null;
  }

  const lines = splitLines(content);
  const decided = await decide(deps, batch, lines);

  // Every line that already carries a row is already decided; only the rest is
  // this pass's work. See the header: a row is a decision, and a resumed pass
  // does not revisit one.
  const done = await recordedLines(deps.db, batchId);
  const pending = decided.filter((decision) => !done.has(decision.lineNo));

  const skips = pending.filter((decision) => decision.kind === "skip");
  if (skips.length > 0) await writeSkips(deps.db, batchId, skips);

  const holds = pending.flatMap((decision) => (decision.kind === "hold" ? [decision] : []));
  const held = await holdFunded(deps, batchId, holds);

  await deps.db.query(
    `UPDATE batches
        SET status = 'in_progress', in_progress_at = COALESCE(in_progress_at, $2)
      WHERE batch_id = $1`,
    [batchId, nowSeconds()],
  );

  return { batchId, held, skipped: pending.length - held };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Split on newlines, dropping blank ones.
 *
 * The same rule `POST /v1/files` counted the file's lines by, and it has to be
 * the same rule: the create door refuses a batch past the cap using that count,
 * and a splitter that disagreed would hold a different number of lines than the
 * count the door admitted.
 */
function splitLines(content: Buffer): string[] {
  return content
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The line numbers this batch has already decided. */
async function recordedLines(db: Db, batchId: string): Promise<Set<number>> {
  const { rows } = await db.query<{ line_no: string }>(
    "SELECT line_no FROM batch_lines WHERE batch_id = $1",
    [batchId],
  );
  return new Set(rows.map((row) => Number(row.line_no)));
}

/**
 * Admit every line, then file the bytes of the ones that survived.
 *
 * The two halves are in this order because admission costs no store round trip
 * and pinning does: a file of 50 000 lines whose signatures are all wrong costs
 * one pass over the bytes and no objects at all.
 */
async function decide(
  deps: BatchWorkerDeps,
  batch: BatchRow,
  lines: string[],
): Promise<Decision[]> {
  // A batch cancelled while it was still validating holds nothing. Its lines are
  // recorded as skipped so the fold has something to count — a batch with no
  // lines at all reads as `0 of 0 done`, which is `completed`, which is a lie
  // about a batch nobody ran.
  if (batch.cancelling_at !== null) {
    return lines.map((_, index) => ({ lineNo: index + 1, kind: "skip", reason: "cancelled" }));
  }

  const chain = requireChain(deps.chain);
  const params = chainParams(chain, deps.config.addresses);
  const [gasFee, feeBps] = await Promise.all([params.gasFee(), params.feeBps()]);
  const context: LineContext = {
    db: deps.db,
    endpoint: batch.endpoint,
    owner: batch.owner,
    addresses: deps.config.addresses,
    // One instant for the whole file: two lines with the same expiry must not be
    // judged differently because the split took a second.
    now: nowSeconds(),
    gasFee,
    feeBps,
  };

  const admitted: { lineNo: number; line: AdmittedLine }[] = [];
  const decisions = new Map<number, Decision>();
  const seen = new Set<Hex>();

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const verdict = await admitLine(raw, context);
    if (!verdict.ok) {
      decisions.set(lineNo, { lineNo, kind: "skip", reason: verdict.skip.code });
      continue;
    }
    // Within the file. `job_id` is `keccak256(owner ‖ c)`, so two lines that
    // name it are the same job twice. A collision with an order held *outside*
    // this batch is the held row's own conflict, met when the line is held.
    if (seen.has(verdict.line.jobId)) {
      decisions.set(lineNo, { lineNo, kind: "skip", reason: "duplicate_job_id" });
      continue;
    }
    seen.add(verdict.line.jobId);
    admitted.push({ lineNo, line: verdict.line });
  }

  // One query for the whole file rather than one per line. A model the catalog
  // does not enable is a refusal every claim would meet (`ModelDisabled`), made
  // here before anything is held.
  const enabled = await enabledModels(
    deps.db,
    admitted.map(({ line }) => line.terms.modelId),
  );
  const modelled = admitted.filter(({ lineNo, line }) => {
    if (enabled.has(line.terms.modelId)) return true;
    decisions.set(lineNo, { lineNo, kind: "skip", reason: "invalid_model" });
    return false;
  });

  // The claim locks each line's `amount` from its owner's prepaid balance, so
  // lines are funded in file order out of what each owner can still fund; the
  // rest are skipped rather than held to rest until they expire. One read per
  // owner, here so an unfunded line files no bytes; the read each hold rests on
  // is made again under the owner's funds queue (`holdFunded`).
  const left = new Map<string, bigint>();
  const pinnable: typeof modelled = [];
  for (const entry of modelled) {
    const owner = entry.line.owner.toLowerCase();
    const funds =
      left.get(owner) ??
      (await fundsLeft(chain, deps.db, deps.config.addresses.jobRegistry, entry.line.owner, feeBps, context.now));
    if (funds < entry.line.amount) {
      left.set(owner, funds);
      decisions.set(entry.lineNo, { lineNo: entry.lineNo, kind: "skip", reason: "insufficient_funds" });
      continue;
    }
    left.set(owner, funds - entry.line.amount);
    pinnable.push(entry);
  }

  // The bytes, filed — and for a line that named an upload, the upload adopted
  // instead. A failure here throws and the pass is retried whole: no row has
  // been written yet, so there is nothing half-decided to reconcile. A line
  // whose file the sweep took between admission and here is the same skip a
  // miss in `admitLine` is.
  const filed = await mapLimited(pinnable, PIN_CONCURRENCY, async ({ lineNo, line }) => {
    if (line.content.kind === "inline") {
      return { lineNo, line, taskCid: await put(deps.pinner, line.content.bytes) };
    }
    const attached = await attachFile(
      deps.db,
      { cid: line.content.cid, owner: batch.owner, purpose: "input" },
      deps.config.fileRetentionSeconds,
    );
    return { lineNo, line, taskCid: attached ? line.content.cid : null };
  });
  for (const { lineNo, line, taskCid } of filed) {
    decisions.set(
      lineNo,
      taskCid === null
        ? { lineNo, kind: "skip", reason: "unknown_container" }
        : { lineNo, kind: "hold", line, taskCid, gasFee, feeBps },
    );
  }

  return lines.map((_, index) => {
    const lineNo = index + 1;
    return decisions.get(lineNo) ?? { lineNo, kind: "skip", reason: "invalid_line" };
  });
}

/** Which of these model ids the catalog both knows and enables. */
async function enabledModels(db: Db, modelIds: readonly bigint[]): Promise<Set<bigint>> {
  if (modelIds.length === 0) return new Set();
  const { rows } = await db.query<{ model_id: string }>(
    "SELECT model_id FROM models WHERE model_id = ANY($1::bigint[]) AND enabled",
    [[...new Set(modelIds)].map((id) => id.toString())],
  );
  return new Set(rows.map((row) => BigInt(row.model_id)));
}

/** `mapper` over `items`, at most `limit` at a time, results in input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Writing and holding
// ---------------------------------------------------------------------------

/**
 * The lines to hold, funded again and held under each owner's funds queue.
 * Returns how many were held.
 *
 * The funding in {@link decide} ran before the pins and outside the queue, so a
 * post or a withdrawal of the same owner may have drawn on the balance since.
 * Under the queue nothing else decides against this owner's funds, so each line
 * is held only while what the owner can still fund covers it, in file order,
 * and the rest are recorded as `insufficient_funds`.
 */
async function holdFunded(
  deps: BatchWorkerDeps,
  batchId: string,
  holds: Extract<Decision, { kind: "hold" }>[],
): Promise<number> {
  const chain = requireChain(deps.chain);
  const byOwner = new Map<string, Extract<Decision, { kind: "hold" }>[]>();
  for (const decision of holds) {
    const key = decision.line.owner.toLowerCase();
    const lines = byOwner.get(key) ?? [];
    lines.push(decision);
    byOwner.set(key, lines);
  }

  let held = 0;
  for (const lines of byOwner.values()) {
    for (let start = 0; start < lines.length; start += HOLD_CHUNK) {
      const chunk = lines.slice(start, start + HOLD_CHUNK);
      const { owner } = chunk[0].line;
      held += await underOwnerFunds(owner, async () => {
        let left = await fundsLeft(
          chain,
          deps.db,
          deps.config.addresses.jobRegistry,
          owner,
          chunk[0].feeBps,
          nowSeconds(),
        );
        let count = 0;
        for (const decision of chunk) {
          if (left < decision.line.amount) {
            await writeSkips(deps.db, batchId, [
              { lineNo: decision.lineNo, kind: "skip", reason: "insufficient_funds" },
            ]);
            continue;
          }
          if (await holdLine(deps, batchId, decision)) {
            left -= decision.line.amount;
            count += 1;
          }
        }
        return count;
      });
    }
  }
  return held;
}

async function writeSkips(db: Db, batchId: string, skips: Decision[]): Promise<void> {
  await db.query(
    `INSERT INTO batch_lines (batch_id, line_no, skip_reason)
     SELECT $1, * FROM unnest($2::bigint[], $3::text[])
     ON CONFLICT (batch_id, line_no) DO NOTHING`,
    [
      batchId,
      skips.map((skip) => skip.lineNo),
      skips.map((skip) => (skip.kind === "skip" ? skip.reason : "")),
    ],
  );
}

/**
 * One line, held: its `batch_lines` row and its held order in one transaction.
 * `false` when the line was recorded as a skip instead.
 *
 * A line whose `job_id` is already held outside this batch is recorded as a
 * skip rather than as this batch's job: the row under that id belongs to
 * another order, and attributing its result to this line would be wrong.
 */
async function holdLine(
  deps: BatchWorkerDeps,
  batchId: string,
  decision: Extract<Decision, { kind: "hold" }>,
): Promise<boolean> {
  const { line, taskCid, lineNo, gasFee } = decision;
  return deps.db.tx(async (tx) => {
    const held = await holdOrder(tx, {
      jobId: line.jobId,
      owner: line.owner,
      terms: line.terms,
      taskCid,
      gasFee,
      orderSig: line.signature,
    });
    await tx.query(
      held
        ? `INSERT INTO batch_lines (batch_id, line_no, job_id, task_cid) VALUES ($1, $2, $3, $4)
           ON CONFLICT (batch_id, line_no) DO NOTHING`
        : `INSERT INTO batch_lines (batch_id, line_no, skip_reason) VALUES ($1, $2, 'DuplicateJob')
           ON CONFLICT (batch_id, line_no) DO NOTHING`,
      held
        ? [batchId, lineNo, Buffer.from(line.jobId.slice(2), "hex"), taskCid]
        : [batchId, lineNo],
    );
    return held;
  });
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** What one pass over every batch did. */
export interface TickResult {
  /** The batches this pass held. */
  held: string[];
  /** The batches this pass froze. */
  finalized: string[];
}

/**
 * One pass: hold everything `validating`, freeze everything finished.
 *
 * **A failure in one batch does not stop the next.** One client's unresolvable
 * input, or one endpoint hiccup on one chunk, must not hold up every other
 * client's work — so each batch is attempted on its own and a failure is reported
 * and stepped over. It stays `validating` and the next pass retries it, which is
 * free: object names are content hashes, and a line already recorded is a line
 * already decided.
 */
export async function batchWorkerTick(
  deps: BatchWorkerDeps,
  onError: (error: unknown, batchId: string) => void,
): Promise<TickResult> {
  const result: TickResult = { held: [], finalized: [] };

  const { rows: validating } = await deps.db.query<{ batch_id: string }>(
    "SELECT batch_id FROM batches WHERE status = 'validating' ORDER BY created_at",
  );
  for (const { batch_id: batchId } of validating) {
    try {
      if ((await holdBatch(deps, batchId)) !== null) result.held.push(batchId);
    } catch (error) {
      onError(error, batchId);
    }
  }

  // Only the ones that could possibly be finished — `finalizeBatch` re-checks,
  // but a pass over every batch this node has ever run would grow without bound.
  // The same "not frozen yet" condition `finalizeBatch` guards on, and for its
  // reason: a batch no line of which delivered mints no output file, so
  // `output_file_id IS NULL` selects it forever.
  const { rows: running } = await deps.db.query<{ batch_id: string }>(
    `SELECT batch_id FROM batches
      WHERE status = 'in_progress'
        AND completed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL`,
  );
  for (const { batch_id: batchId } of running) {
    try {
      if ((await finalizeBatch(deps, batchId)) !== null) result.finalized.push(batchId);
    } catch (error) {
      onError(error, batchId);
    }
  }

  return result;
}

/**
 * The worker, on a timer.
 *
 * `unref` so a background timer cannot hold the process open through a SIGTERM,
 * and a re-entrancy guard because one pass can take minutes — a second pass
 * starting on top of the first would read the same `validating` rows and try to
 * hold the same lines twice. The `batch_lines` rows and the held rows' own
 * conflicts make that harmless, but harmless is not a reason to do it.
 */
export function startBatchWorker(
  deps: BatchWorkerDeps,
  onError: (error: unknown, batchId: string) => void,
  intervalMs: number,
): { stop: () => void; tick: () => Promise<TickResult | null> } {
  let running = false;
  const tick = async (): Promise<TickResult | null> => {
    if (running) return null;
    running = true;
    try {
      return await batchWorkerTick(deps, onError);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick().catch((error: unknown) => onError(error, "")), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}

// ---------------------------------------------------------------------------

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

function requireChain(chain: Chain | null): Chain {
  if (chain === null) throw new Error("the batch worker needs a chain to read balances and fees from");
  return chain;
}
