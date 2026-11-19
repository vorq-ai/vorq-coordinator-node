import { randomBytes } from "node:crypto";
import { formatUsd } from "../src/money.js";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { batchWorkerTick, holdBatch, type BatchWorkerDeps } from "../src/batches/worker.js";
import { openDb, type Db } from "../src/db/db.js";
import { commitmentOf, CONTAINER_TAG, SEED_WRAP_BYTES } from "../src/container.js";
import { holdOrder } from "../src/match/held.js";
import { EIP712_NAMES, feeOf } from "../src/orders.js";
import { pinnerFor, type Pinner, put } from "../src/pin/pinner.js";
import { startStubStore, type StubStore } from "./support/stub-store.js";
import { stubChain, testConfig, type StubChain } from "./support/stub-chain.js";

/**
 * The batch worker's holding pass: split the input file, file one container per
 * line that inlined one, hold every admitted line as an order — its
 * `batch_lines` row and its held `jobs` row together — and hand the batch over
 * to the fold. Nothing is relayed: each line goes on chain inside the claim a
 * provider signs for it.
 *
 * Driven against a canned endpoint and a canned store, so the assertions are
 * about what the node holds: the held rows are read back and compared against
 * the names the store minted, and the endpoint proves no transaction was sent.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_batch_worker_test";

const owner = privateKeyToAccount(`0x${"66".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"77".repeat(32)}`);
const OWNER_BYTES = Buffer.from(owner.address.slice(2), "hex");

const GAS_FEE = 500_000n;
/** The protocol's own fee, and the one the stub chain here charges. */
const FEE_BPS = 100;

describe.skipIf(!TEST_DATABASE_URL)("the batch worker's holding pass", () => {
  let db: Db;
  let store: StubStore;
  let config: ReturnType<typeof testConfig>;
  let pinner: Pinner;

  const { chainId, jobRegistry } = testConfig().addresses;

  // -------------------------------------------------------------------------
  // A line, signed to the contracts' own typehash strings (R32, R64)
  // -------------------------------------------------------------------------

  const orderDomain = {
    name: EIP712_NAMES.job,
    version: "2",
    chainId,
    verifyingContract: jobRegistry,
  } as const;

  const orderTypes = {
    Order: [
      { name: "c", type: "bytes32" },
      { name: "modelId", type: "uint32" },
      { name: "slaSecs", type: "uint32" },
      { name: "rateIn", type: "uint128" },
      { name: "rateOut", type: "uint128" },
      { name: "unitsIn", type: "uint32" },
      { name: "unitsOut", type: "uint32" },
      { name: "designated", type: "uint32" },
      { name: "expiresAt", type: "uint64" },
    ],
  } as const;

  /** A distinct container per line, so every line mints a distinct `task_cid`. */
  const containerFor = (n: number): Buffer =>
    Buffer.concat([
      CONTAINER_TAG,
      Buffer.alloc(SEED_WRAP_BYTES, 0xd1),
      Buffer.from(`sealed prompt ${n}`, "utf8"),
    ]);

  const jobIdFor = (c: Hex): Hex => keccak256(`0x${owner.address.slice(2)}${c.slice(2)}` as Hex);

  const expiresAt = (): bigint => BigInt(Math.floor(Date.now() / 1000)) + 3600n;

  interface LineOptions {
    signer?: typeof owner;
    container?: Buffer;
    /**
     * Sent instead of `container`, for a line that references an upload.
     *
     * `container` is still given, because `c` is derived from those bytes: the
     * line signs the commitment either way, and only how the bytes reach the
     * node changes.
     */
    containerCid?: string;
    /** Replaces the whole rendered line — for the malformed cases. */
    raw?: string;
  }

  async function jsonLine(n: number, options: LineOptions = {}): Promise<string> {
    if (options.raw !== undefined) return options.raw;
    const container = options.container ?? containerFor(n);
    const c = commitmentOf(container);
    const terms = {
      c,
      modelId: 1,
      slaSecs: 3600,
      rateIn: 30_000n,
      rateOut: 90_000n,
      unitsIn: 1000,
      unitsOut: 2000,
      designated: 7,
      expiresAt: expiresAt(),
    };
    const cap = (terms.rateIn * 1000n + terms.rateOut * 2000n + 999_999n) / 1_000_000n;
    // The lock at claim: the cap, the protocol fee charged on top of it, and the
    // gas fee.
    const amount = cap + feeOf(cap, FEE_BPS) + GAS_FEE;
    const jobId = jobIdFor(c);
    const signer = options.signer ?? owner;
    return JSON.stringify({
      url: "/v1/responses",
      c,
      owner: owner.address,
      job_id: jobId,
      model_id: terms.modelId,
      sla_secs: terms.slaSecs,
      rate_in: formatUsd(terms.rateIn, 6),
      rate_out: formatUsd(terms.rateOut, 6),
      units_in: terms.unitsIn,
      units_out: terms.unitsOut,
      designated: terms.designated,
      expires_at: Number(terms.expiresAt),
      signature: await signer.signTypedData({
        domain: orderDomain,
        types: orderTypes,
        primaryType: "Order",
        message: terms,
      }),
      ...(options.containerCid === undefined
        ? { container: container.toString("base64") }
        : { container_cid: options.containerCid }),
      amount: formatUsd(amount, 6),
    });
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  /** Files the JSONL with the stub store and writes the `files` row that names it. */
  async function seedInput(lines: string[]): Promise<string> {
    const content = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const cid = await put(pinner, content);
    const fileId = `file-${randomBytes(12).toString("hex")}`;
    const created = BigInt(Math.floor(Date.now() / 1000));
    await db.query(
      `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, status, lines,
                          created_at, expires_at)
       VALUES ($1, $2, 'batch', 'in.jsonl', $3, $4, 'uploaded', $5, $6, $7)`,
      [fileId, OWNER_BYTES, content.length, cid, lines.length, created, created + 2_592_000n],
    );
    return fileId;
  }

  /**
   * Files a container with the stub store and writes the `input` upload row a
   * line's `container_cid` names, commitment and all — what `POST /v1/files`
   * leaves behind. Answers the cid.
   */
  async function seedUpload(
    container: Buffer,
    options: { owner?: Buffer; expiresAt?: bigint } = {},
  ): Promise<string> {
    const cid = await put(pinner, container);
    const created = BigInt(Math.floor(Date.now() / 1000));
    await db.query(
      `INSERT INTO files (file_id, owner, purpose, filename, bytes, cid, status, lines,
                          commitment, created_at, expires_at)
       VALUES ($1, $2, 'input', 'container', $3, $4, 'uploaded', 0, $5, $6, $7)`,
      [
        `file-${randomBytes(12).toString("hex")}`,
        options.owner ?? OWNER_BYTES,
        container.length,
        cid,
        Buffer.from(commitmentOf(container).slice(2), "hex"),
        created,
        created + (options.expiresAt ?? 2_592_000n),
      ],
    );
    return cid;
  }

  async function seedBatch(
    lines: string[],
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const batchId = `batch_${randomBytes(8).toString("hex")}`;
    const created = BigInt(Math.floor(Date.now() / 1000));
    const row = {
      batch_id: batchId,
      owner: OWNER_BYTES,
      endpoint: "/v1/responses",
      completion_window: 86400n,
      input_file_id: await seedInput(lines),
      status: "validating",
      created_at: created,
      expires_at: created + 86400n,
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO batches (${columns.join(", ")}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`,
      Object.values(row),
    );
    return batchId;
  }

  /** The catalog row every admitted line is checked against. */
  const enableModel = (modelId: number, enabled = true) =>
    db.query(
      `INSERT INTO models (model_id, name, enabled) VALUES ($1, 'a-model', $2)
       ON CONFLICT (model_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [modelId, enabled],
    );

  // -------------------------------------------------------------------------
  // The chain: two config reads and the owner's balance, nothing relayed
  // -------------------------------------------------------------------------

  function chainWith(options: { tokenBalance?: Record<string, bigint> } = {}): StubChain {
    return stubChain(config, {
      views: { gasFee: GAS_FEE, feeBps: FEE_BPS },
      tokenBalance: options.tokenBalance,
    });
  }

  const run = (stub: StubChain, batchId: string) =>
    holdBatch({ db, config, chain: stub.chain, pinner }, batchId);

  /** What one line locks at claim. */
  const lineAmount = (): bigint => {
    const cap = (30_000n * 1000n + 90_000n * 2000n + 999_999n) / 1_000_000n;
    return cap + feeOf(cap, FEE_BPS) + GAS_FEE;
  };

  /** The held `jobs` rows, keyed by job id. */
  const heldRows = async () =>
    (
      await db.query<{
        job_id: Buffer;
        owner: Buffer;
        task_cid: Buffer;
        order_sig: Buffer | null;
        gas_fee: bigint;
        state: number;
      }>("SELECT job_id, owner, task_cid, order_sig, gas_fee, state FROM jobs ORDER BY job_id")
    ).rows;

  const heldFor = async (jobId: Buffer | null) =>
    (await heldRows()).find((row) => jobId !== null && row.job_id.equals(jobId));

  const lineRows = async (batchId: string) =>
    (
      await db.query<{ line_no: string; job_id: Buffer | null; task_cid: string | null; skip_reason: string | null }>(
        "SELECT line_no, job_id, task_cid, skip_reason FROM batch_lines WHERE batch_id = $1 ORDER BY line_no",
        [batchId],
      )
    ).rows;

  const batchRow = async (batchId: string) =>
    (
      await db.query<{ status: string; in_progress_at: string | null }>(
        "SELECT status, in_progress_at FROM batches WHERE batch_id = $1",
        [batchId],
      )
    ).rows[0];

  /**
   * Settle a held line's order as the indexer would once its claim and settle
   * land: the reducer's `Posted` clears the signature, `Settled` ends the row.
   */
  const settle = (jobId: Buffer) =>
    db.query(
      `UPDATE jobs SET state = 2, ended_because = 1, provider_id = 7, completion_tok = 128,
                       result_cid = $2, order_sig = NULL
        WHERE job_id = $1`,
      [jobId, Buffer.from("bafkreiresult", "utf8")],
    );

  /** How many rows the frozen output file holds — read back out of the store. */
  async function outputRowCount(batchId: string): Promise<number> {
    const { rows } = await db.query<{ lines: string }>(
      `SELECT f.lines FROM batches b JOIN files f ON f.file_id = b.output_file_id
        WHERE b.batch_id = $1`,
      [batchId],
    );
    return rows.length === 0 ? 0 : Number(rows[0].lines);
  }

  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
    store = await startStubStore();
    config = testConfig({ dbUrl: url, pinS3: store.config() });
    pinner = pinnerFor(config, db);
  });

  afterAll(async () => {
    await store?.close();
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    for (const table of ["batch_lines", "batches", "files", "jobs", "models", "pins"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    store.objects.clear();
    await enableModel(1);
  });

  afterEach(() => {
    store.omitCid = false;
  });

  // -------------------------------------------------------------------------
  // The happy path
  // -------------------------------------------------------------------------

  it("holds every line of a batch as an order and hands it to the fold, relaying nothing", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2), await jsonLine(3)]);
    const stub = chainWith();

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual({ batchId, held: 3, skipped: 0 });
    // Nothing goes on chain here: a line's order rides the claim a provider signs.
    expect(stub.broadcasts).toHaveLength(0);
    expect(stub.simulated).toHaveLength(0);

    const rows = await lineRows(batchId);
    expect(rows.map((row) => Number(row.line_no))).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.job_id !== null)).toBe(true);
    expect(rows.every((row) => row.skip_reason === null)).toBe(true);

    // Each line's job id names one held order: open, carrying its order
    // signature, at the gas fee the batch was priced at.
    for (const row of rows) {
      const held = await heldFor(row.job_id);
      expect(held).toEqual(
        expect.objectContaining({ state: 0, gas_fee: GAS_FEE, owner: OWNER_BYTES }),
      );
      expect(held?.order_sig).toHaveLength(65);
    }

    const batch = await batchRow(batchId);
    expect(batch.status).toBe("in_progress");
    expect(batch.in_progress_at).not.toBeNull();
  });

  it("holds each line under the name the store minted for its own container", async () => {
    const containers = [containerFor(1), containerFor(2)];
    const batchId = await seedBatch([
      await jsonLine(1, { container: containers[0] }),
      await jsonLine(2, { container: containers[1] }),
    ]);

    await run(chainWith(), batchId);

    // The client cannot know the name — this node mints it — so the only proof
    // the right bytes reached the right line is this comparison.
    const rows = await lineRows(batchId);
    const minted = containers.map((bytes) => store.mintedCid(bytes));
    for (const [index, row] of rows.entries()) {
      expect((await heldFor(row.job_id))?.task_cid.toString("utf8")).toBe(minted[index]);
    }
    // And each object really is in the store, under its own name.
    for (const container of containers) {
      expect([...store.objects.values()].some((bytes) => bytes.equals(container))).toBe(true);
    }
  });

  it("records each line's task_cid: batch_lines is the only record of which job is which line", async () => {
    const batchId = await seedBatch([await jsonLine(1)]);
    await run(chainWith(), batchId);

    const [row] = await lineRows(batchId);
    expect(row.task_cid).toBe(store.mintedCid(containerFor(1)));
  });

  // -------------------------------------------------------------------------
  // Skip with a receipt
  // -------------------------------------------------------------------------

  it("skips a line this node refuses and holds its neighbours anyway", async () => {
    const batchId = await seedBatch([
      await jsonLine(1),
      await jsonLine(2, { signer: stranger }),
      await jsonLine(3),
    ]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 2, skipped: 1 }));
    expect(await heldRows()).toHaveLength(2);

    const rows = await lineRows(batchId);
    expect(rows[1].skip_reason).toBe("invalid_order_signature");
    expect(rows[1].job_id).toBeNull();
    expect(rows[1].task_cid).toBeNull();
    expect(rows[0].job_id).not.toBeNull();
    expect(rows[2].job_id).not.toBeNull();
  });

  it("skips a line that is not JSON without reading the rest of the file differently", async () => {
    const batchId = await seedBatch([await jsonLine(1), "{ this is not json", await jsonLine(3)]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 2, skipped: 1 }));
    expect((await lineRows(batchId))[1].skip_reason).toBe("invalid_json");
  });

  it("skips a line naming a model the catalog does not enable", async () => {
    await enableModel(1, false);
    const batchId = await seedBatch([await jsonLine(1)]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 0, skipped: 1 }));
    expect((await lineRows(batchId))[0].skip_reason).toBe("invalid_model");
    expect(await heldRows()).toEqual([]);
  });

  /**
   * Funded in file order out of the owner's prepaid balance: the claim locks
   * each line's amount, so a line past the balance would be held and rest until
   * it expired with nothing able to claim it.
   */
  it("skips the lines the owner's balance cannot fund, in file order", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2), await jsonLine(3)]);
    // Two lines' worth and one atomic unit short of a third.
    const stub = chainWith({
      tokenBalance: { [owner.address.toLowerCase()]: lineAmount() * 3n - 1n },
    });

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 2, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].job_id).not.toBeNull();
    expect(rows[1].job_id).not.toBeNull();
    expect(rows[2].skip_reason).toBe("insufficient_funds");
    // The balance read is the registry's prepaid balance, not the token's.
    const balanceReads = stub.requests.filter((r) => {
      if (r.method !== "eth_call") return false;
      const [call] = r.params as [{ to: string; data: string }];
      return call.data.startsWith("0x70a08231");
    });
    expect(balanceReads.length).toBeGreaterThan(0);
    for (const read of balanceReads) {
      const [call] = read.params as [{ to: string }];
      expect(call.to.toLowerCase()).toBe(jobRegistry.toLowerCase());
    }
  });

  it("counts the owner's other open orders against what the batch can fund", async () => {
    // One order already held for this owner, outside the batch, reserves one
    // line's lock of a two-line balance: only one line of the batch fits.
    await holdOrder(db, {
      jobId: `0x${"ee".repeat(32)}`,
      owner: owner.address,
      terms: {
        c: `0x${"ee".repeat(32)}`,
        modelId: 1n,
        slaSecs: 3600n,
        rateIn: 30_000n,
        rateOut: 90_000n,
        unitsIn: 1000n,
        unitsOut: 2000n,
        designated: 7n,
        expiresAt: expiresAt(),
      },
      taskCid: "bafkreiother",
      gasFee: GAS_FEE,
      orderSig: `0x${"0a".repeat(65)}`,
    });
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    const stub = chainWith({ tokenBalance: { [owner.address.toLowerCase()]: lineAmount() * 2n } });

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 1, skipped: 1 }));
    expect((await lineRows(batchId))[1].skip_reason).toBe("insufficient_funds");
  });

  it("skips the second of two lines that name the same job", async () => {
    const same = containerFor(9);
    const batchId = await seedBatch([
      await jsonLine(1, { container: same }),
      await jsonLine(2, { container: same }),
    ]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 1, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].job_id).not.toBeNull();
    expect(rows[1].skip_reason).toBe("duplicate_job_id");
  });

  /**
   * A line whose job id is already held outside this batch — the same order
   * posted to `POST /v1/jobs` as well, say — names a row that belongs to that
   * order. It is skipped rather than attributed: the batch would otherwise read
   * another submission's result as its own line's.
   */
  it("skips a line whose job is already held outside the batch, and leaves that order alone", async () => {
    const line = await jsonLine(1);
    const parsed = JSON.parse(line) as { job_id: Hex; c: Hex; signature: Hex };
    await holdOrder(db, {
      jobId: parsed.job_id,
      owner: owner.address,
      terms: {
        c: parsed.c,
        modelId: 1n,
        slaSecs: 3600n,
        rateIn: 30_000n,
        rateOut: 90_000n,
        unitsIn: 1000n,
        unitsOut: 2000n,
        designated: 7n,
        expiresAt: expiresAt(),
      },
      taskCid: "bafkreioutside",
      gasFee: GAS_FEE,
      orderSig: parsed.signature,
    });
    const batchId = await seedBatch([line, await jsonLine(2)]);

    const outcome = await run(chainWith(), batchId);

    const rows = await lineRows(batchId);
    expect(rows[0]).toEqual(
      expect.objectContaining({ job_id: null, task_cid: null, skip_reason: "DuplicateJob" }),
    );
    expect(rows[1].job_id).not.toBeNull();
    // The outside order keeps its own name.
    const outside = await heldFor(Buffer.from(parsed.job_id.slice(2), "hex"));
    expect(outside?.task_cid.toString("utf8")).toBe("bafkreioutside");
    // And the pass reports the line as the skip it recorded, not as held.
    expect(outcome).toEqual({ batchId, held: 1, skipped: 1 });
  });

  // -------------------------------------------------------------------------
  // Resume, cancel, and the input that is gone
  // -------------------------------------------------------------------------

  it("holds nothing a second time: a line already recorded is a line already decided", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    await run(chainWith(), batchId);

    // The batch is `in_progress` now, so a second pass is only reachable by a
    // worker that crashed mid-run. Put the row back and prove the lines are not
    // held again.
    await db.query("UPDATE batches SET status = 'validating' WHERE batch_id = $1", [batchId]);
    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual({ batchId, held: 0, skipped: 0 });
    expect(await lineRows(batchId)).toHaveLength(2);
    expect(await heldRows()).toHaveLength(2);
    expect((await batchRow(batchId)).status).toBe("in_progress");
  });

  /**
   * **A line's row and its held order are one transaction.** A crash between
   * them must leave the line either decided and held, or undecided and absent —
   * never a held order no line names (an order nobody can attribute) nor a line
   * naming a job nobody holds. The failure is injected with a trigger on
   * `batch_lines`, so it lands after the held row is written inside the same
   * transaction.
   */
  it("rolls a line's held order back with its batch_lines row, and resumes from there", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2), await jsonLine(3)]);
    await db.query(`
      CREATE OR REPLACE FUNCTION refuse_line_two() RETURNS trigger AS $$
      BEGIN
        IF NEW.line_no = 2 THEN RAISE EXCEPTION 'the process went away'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.query(
      "CREATE TRIGGER refuse_line_two BEFORE INSERT ON batch_lines FOR EACH ROW EXECUTE FUNCTION refuse_line_two()",
    );
    try {
      await expect(run(chainWith(), batchId)).rejects.toThrow("the process went away");
    } finally {
      await db.query("DROP TRIGGER refuse_line_two ON batch_lines");
      await db.query("DROP FUNCTION refuse_line_two()");
    }

    // Line 1 is decided and held; line 2's held order went with its row.
    expect((await lineRows(batchId)).map((row) => Number(row.line_no))).toEqual([1]);
    expect(await heldRows()).toHaveLength(1);
    expect((await batchRow(batchId)).status).toBe("validating");

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual({ batchId, held: 2, skipped: 0 });
    expect((await lineRows(batchId)).map((row) => Number(row.line_no))).toEqual([1, 2, 3]);
    expect(await heldRows()).toHaveLength(3);
    expect((await batchRow(batchId)).status).toBe("in_progress");
  });

  it("holds nothing for a batch cancelled before the worker reached it", async () => {
    const created = BigInt(Math.floor(Date.now() / 1000));
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)], {
      cancelling_at: created,
    });

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 0, skipped: 2 }));
    expect(await heldRows()).toEqual([]);
    expect((await lineRows(batchId)).map((row) => row.skip_reason)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("fails a batch whose input object the store can no longer resolve", async () => {
    const batchId = await seedBatch([await jsonLine(1)]);
    store.objects.clear();

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toBeNull();
    const batch = await batchRow(batchId);
    expect(batch.status).toBe("failed");
  });

  it("leaves a batch validating when the store refuses a pin, so the next pass retries it", async () => {
    const batchId = await seedBatch([await jsonLine(1)]);
    store.omitCid = true;

    await expect(run(chainWith(), batchId)).rejects.toThrow();

    expect((await batchRow(batchId)).status).toBe("validating");
    // Nothing half-written: a line with no decision is a line the retry re-decides.
    expect(await lineRows(batchId)).toHaveLength(0);
    expect(await heldRows()).toEqual([]);
  });

  it("skips a batch that is not validating", async () => {
    const batchId = await seedBatch([await jsonLine(1)], { status: "in_progress" });
    expect(await run(chainWith(), batchId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Restarting mid-batch
  // -------------------------------------------------------------------------

  const deps = (stub: StubChain): BatchWorkerDeps => ({
    db,
    config,
    chain: stub.chain,
    pinner,
  });

  // -------------------------------------------------------------------------
  // A line that references an upload rather than inlining its container
  // -------------------------------------------------------------------------

  it("holds a container_cid line under the uploaded cid, filing nothing for it", async () => {
    // The cid **is** the `task_cid`: the bytes are already in the store, so this
    // line costs no put, and the row records the name the upload carries.
    const container = containerFor(41);
    const uploadCid = await seedUpload(container);
    const batchId = await seedBatch([await jsonLine(41, { container, containerCid: uploadCid })]);
    // Everything the pass files from here on is a *new* object; the upload is
    // already in.
    const before = store.objects.size;

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 1, skipped: 0 }));
    expect(store.objects.size).toBe(before);
    const [row] = await lineRows(batchId);
    expect(row.task_cid).toBe(uploadCid);
    expect((await heldFor(row.job_id))?.task_cid.toString("utf8")).toBe(uploadCid);
  });

  it("attaches the upload a container_cid line names, so the sweep leaves it alone", async () => {
    const container = containerFor(42);
    const uploadCid = await seedUpload(container, { expiresAt: 300n });
    const batchId = await seedBatch([await jsonLine(42, { container, containerCid: uploadCid })]);

    await run(chainWith(), batchId);

    const { rows } = await db.query<{ created_at: string; expires_at: string }>(
      "SELECT created_at, expires_at FROM files WHERE cid = $1",
      [uploadCid],
    );
    expect(BigInt(rows[0].expires_at) - BigInt(rows[0].created_at)).toBe(
      BigInt(config.fileRetentionSeconds),
    );
  });

  it("skips a container_cid line whose upload is gone, and holds its neighbour", async () => {
    // A file that expired, or one that belongs to somebody else, is one line's
    // problem: the other 49 999 are still held.
    const container = containerFor(43);
    const batchId = await seedBatch([
      await jsonLine(43, { container, containerCid: "bafynothinguploaded" }),
      await jsonLine(44),
    ]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ held: 1, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].skip_reason).toBe("unknown_container");
    expect(rows[0].job_id).toBeNull();
    expect(rows[1].job_id).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The pass over every batch
  // -------------------------------------------------------------------------

  it("freezes a batch whose every line is terminal in the same pass", async () => {
    // The other half of a tick: `finalizeBatch` finishes a batch when every
    // line is terminal, reading that off `batch_lines`.
    const batchId = await seedBatch([await jsonLine(1)]);
    const stub = chainWith();
    await run(stub, batchId);
    const [line] = await lineRows(batchId);
    await settle(line.job_id as Buffer);

    const done = await batchWorkerTick(deps(stub), () => undefined);

    expect(done.finalized).toEqual([batchId]);
    expect(await outputRowCount(batchId)).toBe(1);
  });

  it("holds every validating batch in one pass", async () => {
    const first = await seedBatch([await jsonLine(1)]);
    const second = await seedBatch([await jsonLine(2)]);
    const stub = chainWith();

    const done = await batchWorkerTick({ db, config, chain: stub.chain, pinner }, () => undefined);

    expect(done.held.sort()).toEqual([first, second].sort());
    expect(stub.broadcasts).toHaveLength(0);
    expect(await heldRows()).toHaveLength(2);
  });

  it("keeps going when one batch fails, and says which", async () => {
    // No `files` row behind this one, so reading its input throws rather than
    // resolving to "the object is gone".
    const broken = `batch_${randomBytes(8).toString("hex")}`;
    const created = BigInt(Math.floor(Date.now() / 1000));
    await db.query(
      `INSERT INTO batches (batch_id, owner, endpoint, completion_window, input_file_id,
                            status, created_at, expires_at)
       VALUES ($1, $2, '/v1/responses', 86400, 'file-missing', 'validating', $3, $4)`,
      [broken, OWNER_BYTES, created, created + 86_400n],
    );
    const healthy = await seedBatch([await jsonLine(1)]);
    const stub = chainWith();
    const failures: string[] = [];

    const done = await batchWorkerTick({ db, config, chain: stub.chain, pinner }, (_error, id) =>
      failures.push(id),
    );

    // The broken one has no input object, so it is failed rather than thrown on —
    // and the healthy one is still held. A pass that stopped at the first bad
    // batch would let one unresolvable input hold up every other client's work.
    expect(done.held).toEqual([healthy]);
    expect(failures).toEqual([]);
    expect(
      (
        await db.query<{ status: string }>("SELECT status FROM batches WHERE batch_id = $1", [
          broken,
        ])
      ).rows[0].status,
    ).toBe("failed");
  });
});
