import { decodeErrorResult, encodeFunctionData, parseEventLogs, type Hex, type Log } from "viem";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import { chainParams, type Chain } from "../chain/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import { writePostedRows } from "../index/write-through.js";
import { taskCidHex } from "../orders.js";
import { put, type Pinner } from "../pin/pinner.js";
import { attachFile } from "../api/routes/files.js";
import { finalizeBatch } from "./finalize.js";
import { admitLine, type AdmittedLine, type LineContext } from "./lines.js";

/**
 * The batch worker's **posting pass**: a `validating` batch becomes `in_progress`.
 *
 * ```
 *   read the input object   one fetch, by the CID the `files` row names
 *   split                   one line, one prospective job
 *   admit                   no store, no chain (`lines.ts`)
 *   file                    one container per admitted line that inlined one;
 *                           the name minted for it IS that line's `task_cid`,
 *                           and a line that named an upload already has one
 *   record                  a `batch_lines` row per line, BEFORE the relay
 *   post                    `postMany`, chunked; PostSkipped takes lines back
 *   stamp                   in_progress, and the fold owns the batch from here
 * ```
 *
 * ## Why this cannot be the create request
 *
 * 50 000 lines is 50 000 pins against a service rate-limited to 100 req/s —
 * eight minutes at the ceiling, before a single transaction is signed. `POST
 * /v1/batches` answers `validating` and returns; this runs behind it. OpenAI's
 * own `validating → in_progress` lifecycle exists for exactly this, and it is
 * what makes skip-with-receipt the only coherent create semantics: an
 * all-or-nothing refusal would throw away 49 999 good lines, and the pinning
 * already spent on them, for one line with a typo.
 *
 * ## `batch_lines` is the record, and it is preserved
 *
 * **Nothing on chain says a job belongs to a batch** — every line is an
 * independent designated order, which is exactly what lets one batch spread
 * across providers with no coordination. So `batch_lines` is the only record of
 * which line is which job, it is in `PRESERVED` (`src/db/db.ts`), and this pass
 * writes it rather than a manifest object anybody would have to read back.
 *
 * ## The rows are written before the relay, and that ordering is the whole
 * crash story
 *
 * A `postMany` that lands and a `batch_lines` row that names its job are two
 * writes to two different systems, and a process can die between them. Written
 * **after** the relay, a crash in that window leaves lines that are posted,
 * escrow-committed and unrecorded — and a resumed pass would post them a second
 * time. On chain that is answered `DuplicateJob`, which is indistinguishable from
 * a client that genuinely reused a `c`; one reading strands a paid job as
 * "skipped", the other attributes an unrelated job's result to this line. Neither
 * is acceptable, so the ambiguity is removed rather than resolved.
 *
 * Written **before**, the worst case is the opposite and it is bounded: a line
 * recorded with a `job_id` that never posted. Nothing on chain will ever move it,
 * so the fold reads it as in flight until the batch's own `expires_at`, at which
 * point it counts as failed and lands in the error file. One chunk's lines, one
 * window late, and no line is ever posted twice.
 *
 * A resumed pass therefore reprocesses **only lines with no row at all**: a row
 * is a decision, and a decision is not revisited.
 *
 * ## No simulate
 *
 * Deliberately, and for `AskRegistry.setAsks`' reason (R29): `postMany` skips
 * rather than reverting, so a simulate proves nothing about any individual line —
 * it would answer "success" for a call in which every line is refused. The
 * receipt's `PostSkipped` logs are the only per-line verdict there is, and they
 * exist only after the transaction has mined.
 */

/**
 * How many lines ride in one `postMany`.
 *
 * `post` writes a full `Job` struct — fourteen slots, several of them cold — and
 * a twelve-argument `Posted` event, which measures at roughly 250 000 gas a line
 * before the self-call's own overhead. Fifty of them is ~13 M, comfortably inside
 * a 30 M block and leaving room for a line that costs more than the average
 * (a long `authSig`, a long `taskCid`). It is a line count rather than a gas
 * estimate because the estimate would have to be made per line against a chain
 * this pass has deliberately not asked anything yet — and being wrong about it
 * means an unmineable transaction, not a slow one.
 */
export const MAX_LINES_PER_TRANSACTION = 50;

/**
 * The gas budget one line is sent with, and **why this pass does not estimate**.
 *
 * `eth_estimateGas` searches for the least gas at which the transaction succeeds.
 * `postMany` succeeds however many of its lines it skipped — that is what a
 * `try/catch` per line means — so the search converges on a limit at which the
 * tail of the chunk runs out of gas *inside its sub-call*, is caught, and is
 * reported as `PostSkipped` on a receipt that says success. The estimate is not
 * wrong about the question it was asked. It is the wrong question.
 *
 * Measured on the devnet: a two-line chunk estimated at 449 299, used exactly
 * 449 299, landed line 1 and skipped line 2 with empty revert data. The same
 * calldata traced with 5 000 000 gas lands both for 588 052 — 278 350 and 267 850
 * in the two sub-calls, the first paying the cold-slot premium.
 *
 * 350 000 is that measurement with room for a line that costs more than the
 * average (a long `authSig`, a long `taskCid`). Fifty of them is 17.6 M, inside
 * a 30 M block. Unused gas is not spent — this is a limit, not a price — so the
 * only cost of the headroom is block space the chunk was going to ask for anyway.
 */
export const GAS_PER_LINE = 350_000n;

/** Intrinsic cost, calldata and the loop itself, on top of {@link GAS_PER_LINE}. */
const GAS_OVERHEAD = 150_000n;

/**
 * How many containers are filed at once.
 *
 * The storage service is rate-limited to 100 requests a second and a batch is up
 * to 50 000 objects; this is the backpressure. Deliberately well under the
 * ceiling: the same service is on the request path of `POST /v1/jobs` and the
 * settle door, and a worker that saturated it would answer `503 pinner_unavailable`
 * to every live client for the eight minutes it spent posting a batch.
 */
const PIN_CONCURRENCY = 8;

/** How long the worker waits for one chunk's receipt. */
const RECEIPT_TIMEOUT_MS = 120_000;

/**
 * How often the worker looks for work.
 *
 * Not configurable, and it does not need to be: it bounds how long a batch sits
 * in `validating` before its first line is posted, and against a 1 h floor on the
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
export interface PostRun {
  batchId: string;
  posted: number;
  skipped: number;
  /**
   * Lines the transaction ran out of gas on. They carry no row, no verdict and no
   * job; the batch stays `validating` and the next pass posts them.
   */
  undecided: number;
  transactions: number;
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
  | { lineNo: number; kind: "post"; line: AdmittedLine; taskCid: string }
  | { lineNo: number; kind: "skip"; reason: string };

/**
 * Post one batch. `null` when there was nothing to do — the batch is not
 * `validating`, or its input object is gone and the batch has been failed.
 *
 * Throws on an outage — a store that will not file bytes, an endpoint that will
 * not answer — leaving the batch `validating` for the next pass. That is the
 * retry, and it is free: object names are content hashes, so re-filing the same
 * container is the same object under the same name.
 */
export async function postBatch(deps: BatchWorkerDeps, batchId: string): Promise<PostRun | null> {
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

  const posts = pending.filter((decision) => decision.kind === "post");
  let posted = 0;
  let undecided = 0;
  let transactions = 0;
  for (let start = 0; start < posts.length; start += MAX_LINES_PER_TRANSACTION) {
    const chunk = posts.slice(start, start + MAX_LINES_PER_TRANSACTION);
    const run = await postChunk(deps, batchId, chunk);
    posted += run.posted;
    undecided += run.undecided;
    transactions += 1;
  }

  // A line with no verdict is a line this batch is not finished with, and
  // `in_progress` is the promise that every line has one — it is what the fold
  // counts against. So the batch stays `validating` and the next pass posts the
  // rest, which costs nothing: a line that already has a row is already decided.
  if (undecided > 0) {
    return { batchId, posted, skipped: pending.length - posted - undecided, undecided, transactions };
  }

  await deps.db.query(
    `UPDATE batches
        SET status = 'in_progress', in_progress_at = COALESCE(in_progress_at, $2)
      WHERE batch_id = $1`,
    [batchId, nowSeconds()],
  );

  return { batchId, posted, skipped: pending.length - posted, undecided, transactions };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Split on newlines, dropping blank ones.
 *
 * The same rule `POST /v1/files` counted the file's lines by, and it has to be
 * the same rule: the create door refuses a batch past the cap using that count,
 * and a splitter that disagreed would post a different number of lines than the
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
  // A batch cancelled while it was still validating never posts. Its lines are
  // recorded as skipped so the fold has something to count — a batch with no
  // lines at all reads as `0 of 0 done`, which is `completed`, which is a lie
  // about a batch nobody ran.
  if (batch.cancelling_at !== null) {
    return lines.map((_, index) => ({ lineNo: index + 1, kind: "skip", reason: "cancelled" }));
  }

  const chain = requireChain(deps.chain);
  const params = chainParams(chain, deps.config.addresses);
  const [gasFee, feeBps] = await Promise.all([params.gasFee(), params.feeBps()]);
  // One `eth_getCode` per payer for the whole file, the way `gasFee` and `feeBps`
  // are read once for the whole file. A batch's lines may be signed by several
  // wallets, so this is keyed by the payer rather than taken once — but a file of
  // 50 000 lines from one wallet must not be 50 000 calls. The memo dies with the
  // batch: code appears and disappears with a single 7702 transaction, and
  // nothing here should remember it longer than the decision it feeds.
  const codeOf = new Map<string, Promise<boolean>>();
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
    hasCode: (address) => {
      const key = address.toLowerCase();
      let answer = codeOf.get(key);
      if (answer === undefined) {
        answer = chain.hasCode(address);
        codeOf.set(key, answer);
      }
      return answer;
    },
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
    // Within the file, and only within it. `job_id` is `keccak256(owner ‖ c)`, so
    // two lines that name it are the same job twice and the second could only ever
    // be refused `DuplicateJob` on chain — caught here, for free, rather than for
    // gas. A collision with a job posted *outside* this batch is left to the
    // chain: this node's index is not the authority on what has been posted, and
    // the receipt says so definitively.
    if (seen.has(verdict.line.jobId)) {
      decisions.set(lineNo, { lineNo, kind: "skip", reason: "duplicate_job_id" });
      continue;
    }
    seen.add(verdict.line.jobId);
    admitted.push({ lineNo, line: verdict.line });
  }

  // One query for the whole file rather than one per line. A model the catalog
  // does not enable is a refusal the chain would make anyway (`ModelDisabled`),
  // made here before the gas is fronted.
  const enabled = await enabledModels(
    deps.db,
    admitted.map(({ line }) => line.terms.modelId),
  );
  const pinnable = admitted.filter(({ lineNo, line }) => {
    if (enabled.has(line.terms.modelId)) return true;
    decisions.set(lineNo, { lineNo, kind: "skip", reason: "invalid_model" });
    return false;
  });

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
        : { lineNo, kind: "post", line, taskCid },
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
// Writing and posting
// ---------------------------------------------------------------------------

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

/** What one `postMany` did. See {@link postChunk}. */
interface ChunkRun {
  /** Lines that landed as jobs. */
  posted: number;
  /** Lines the contract refused, with a reason. */
  skipped: number;
  /**
   * Lines the transaction ran out of gas on — no verdict, no row, and the next
   * pass posts them again.
   */
  undecided: number;
}

/**
 * One `postMany`: record the chunk, relay it, then take back the lines the
 * contract refused.
 */
async function postChunk(
  deps: BatchWorkerDeps,
  batchId: string,
  chunk: Decision[],
): Promise<ChunkRun> {
  const lines = chunk.flatMap((decision) => (decision.kind === "post" ? [decision] : []));

  // **Before the relay** — see the header. The row claims the job the chunk is
  // about to post, so a crash cannot leave a posted job unrecorded.
  await deps.db.query(
    `INSERT INTO batch_lines (batch_id, line_no, job_id, task_cid)
     SELECT $1, * FROM unnest($2::bigint[], $3::bytea[], $4::text[])
     ON CONFLICT (batch_id, line_no) DO NOTHING`,
    [
      batchId,
      lines.map((decision) => decision.lineNo),
      lines.map((decision) => Buffer.from(decision.line.jobId.slice(2), "hex")),
      lines.map((decision) => decision.taskCid),
    ],
  );

  const chain = requireChain(deps.chain);
  const data = encodeFunctionData({
    abi: jobRegistryAbi,
    functionName: "postMany",
    args: [
      lines.map(({ line, taskCid }) => ({
        c: line.terms.c,
        modelId: Number(line.terms.modelId),
        slaSecs: Number(line.terms.slaSecs),
        rateIn: line.terms.rateIn,
        rateOut: line.terms.rateOut,
        unitsIn: Number(line.terms.unitsIn),
        unitsOut: Number(line.terms.unitsOut),
        designated: Number(line.terms.designated),
        expiresAt: line.terms.expiresAt,
        // The name this node minted, not one the client chose: `taskCid` is a
        // `post` parameter and not a signed member, precisely because the client
        // cannot know it.
        taskCid: taskCidHex(taskCid),
      })),
      lines.map(({ line }) => line.owner),
      lines.map(({ line }) => line.signature),
      lines.map(({ line }) => line.authSig),
    ],
  });

  const txHash = await chain.relay({
    to: deps.config.addresses.jobRegistry,
    data,
    gas: GAS_OVERHEAD + GAS_PER_LINE * BigInt(lines.length),
  });
  const receipt = await chain.receipt(txHash, RECEIPT_TIMEOUT_MS);

  const run = await takeBackRefused(deps, batchId, lines, receipt.logs);

  // The member jobs' rows, from this receipt, so each is readable by id at once
  // rather than after finality. **After** the lines are settled above, so a
  // failure here cannot leave a refused line recorded as posted: it throws to the
  // pass, which logs it, and the next pass finds every line decided.
  await writePostedRows(deps.db, deps.config.addresses.jobRegistry, receipt.logs, receipt.blockNumber);
  return run;
}

/** Takes back the lines the receipt's `PostSkipped` logs refused. */
async function takeBackRefused(
  deps: BatchWorkerDeps,
  batchId: string,
  lines: Extract<Decision, { kind: "post" }>[],
  logs: Log[],
): Promise<ChunkRun> {
  const refused = parseEventLogs({ abi: jobRegistryAbi, eventName: "PostSkipped", logs });
  if (refused.length === 0) return { posted: lines.length, skipped: 0, undecided: 0 };

  let undecided = 0;
  for (const event of refused) {
    const { index, reason } = event.args as { index: bigint; reason: Hex };
    const decision = lines[Number(index)];
    if (decision === undefined) continue;
    if (reason === "0x") {
      // **Empty revert data is not a verdict.** Every way `post` refuses a line
      // names itself with a custom error selector, so nothing coming back means
      // the sub-call died without returning — out of gas — and the contract never
      // formed an opinion about this line. Recording that as a skip would tell the
      // caller its line was refused when nothing about it was wrong, and would do
      // it permanently: a row is a decision and a later pass does not revisit one.
      //
      // Deleting the row instead is sound for exactly the reason the row exists.
      // Its whole job is to answer "did this line post?" without asking the chain,
      // and here the receipt has already answered: the sub-call reverted, so there
      // is no job and no escrow commitment, and re-posting cannot collide with
      // one. The next pass re-decides the line and posts it again.
      undecided += 1;
      await deps.db.query("DELETE FROM batch_lines WHERE batch_id = $1 AND line_no = $2", [
        batchId,
        decision.lineNo,
      ]);
      continue;
    }
    // The contract's own error name, decoded from the revert data `try/catch`
    // handed it — the same vocabulary `POST /v1/jobs` answers a refused post
    // with, so one cause reads the same however it was met.
    await deps.db.query(
      "UPDATE batch_lines SET job_id = NULL, task_cid = NULL, skip_reason = $3 WHERE batch_id = $1 AND line_no = $2",
      [batchId, decision.lineNo, errorNameOf(reason)],
    );
  }
  return {
    posted: lines.length - refused.length,
    skipped: refused.length - undecided,
    undecided,
  };
}

/**
 * The contract's own error name, out of the revert data `postMany`'s `catch`
 * handed the event.
 *
 * Not `decodeRevert`: that reads the data off a thrown RPC error, and this is not
 * an error — it is a `bytes` argument of a log on a transaction that **succeeded**.
 * The vocabulary is the same one `POST /v1/jobs` answers a refused post with, so
 * one cause reads the same however it was met. `"unknown"` for revert data no ABI
 * decodes, which is the honest answer and never a guess.
 */
function errorNameOf(data: Hex): string {
  try {
    return decodeErrorResult({ abi: jobRegistryAbi, data }).errorName;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/** What one pass over every batch did. */
export interface TickResult {
  /** The batches this pass posted. */
  posted: string[];
  /** The batches this pass froze. */
  finalized: string[];
}

/**
 * One pass: post everything `validating`, freeze everything finished.
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
  const result: TickResult = { posted: [], finalized: [] };

  const { rows: validating } = await deps.db.query<{ batch_id: string }>(
    "SELECT batch_id FROM batches WHERE status = 'validating' ORDER BY created_at",
  );
  for (const { batch_id: batchId } of validating) {
    try {
      if ((await postBatch(deps, batchId)) !== null) result.posted.push(batchId);
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
 * post the same lines twice. The `batch_lines` rows written before each relay
 * make that harmless rather than catastrophic, but harmless is not a reason to do
 * it.
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
  if (chain === null) throw new Error("the batch worker needs a chain to post with");
  return chain;
}
