import { randomBytes } from "node:crypto";
import { formatUsd } from "../src/money.js";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import {
  batchWorkerTick,
  GAS_PER_LINE,
  MAX_LINES_PER_TRANSACTION,
  postBatch,
  type BatchWorkerDeps,
} from "../src/batches/worker.js";
import { openDb, type Db } from "../src/db/db.js";
import { commitmentOf, CONTAINER_TAG, SEED_WRAP_BYTES } from "../src/container.js";
import { EIP712_NAMES, feeOf } from "../src/orders.js";
import { pinnerFor, type Pinner, put } from "../src/pin/pinner.js";
import { startStubStore, type StubStore } from "./support/stub-store.js";
import { stubChain, testConfig, type StubChain } from "./support/stub-chain.js";

/**
 * The batch worker's posting pass: split the input file, file one container per
 * line that inlined one, land the lines in as few transactions as the block will
 * take, and hand the batch over to the fold.
 *
 * Driven against a canned endpoint and a canned store, so the assertions are
 * about **what the node would have sent**: the `postMany` calldata is decoded
 * back out of the broadcast and compared against the names the store minted.
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

describe.skipIf(!TEST_DATABASE_URL)("the batch worker's posting pass", () => {
  let db: Db;
  let store: StubStore;
  let config: ReturnType<typeof testConfig>;
  let pinner: Pinner;

  const { chainId, jobRegistry, usdc } = testConfig().addresses;

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

  const authTypes = {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
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
    // The pull at claim: the cap, the protocol fee charged on top of it, and the
    // gas fee snapshot.
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
      auth_sig: await owner.signTypedData({
        domain: { name: "USDC", version: "2", chainId, verifyingContract: usdc },
        types: authTypes,
        primaryType: "ReceiveWithAuthorization",
        message: {
          from: owner.address,
          to: jobRegistry,
          value: amount,
          validAfter: 0n,
          // `expiresAt + 1`: the token requires `now < validBefore`, and a claim
          // may land on `expiresAt` itself.
          validBefore: terms.expiresAt + 1n,
          nonce: jobId,
        },
      }),
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
  // The chain
  // -------------------------------------------------------------------------

  /** A `PostSkipped(index, reason)` log, as the contract emits one per refused line. */
  const postSkippedLog = (index: number, errorName: string) =>
    postSkippedRaw(index, selectorOf(errorName));

  /**
   * The same log with the revert data given literally — for `0x`, which is not a
   * refusal at all. See the test that reads it.
   */
  const postSkippedRaw = (index: number, reason: Hex) => ({
    address: jobRegistry,
    topics: encodeEventTopics({
      abi: jobRegistryAbi,
      eventName: "PostSkipped",
      args: { index: BigInt(index) },
    }),
    data: encodeAbiParameters([{ name: "reason", type: "bytes" }], [reason]),
    blockNumber: "0x1",
    blockHash: `0x${"ab".repeat(32)}`,
    transactionHash: `0x${"cd".repeat(32)}`,
    transactionIndex: "0x0",
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  });

  /** One `postMany` order, as it decodes back off the wire. */
  type PostedOrder = {
    c: Hex;
    modelId: number;
    slaSecs: number;
    rateIn: bigint;
    rateOut: bigint;
    unitsIn: number;
    unitsOut: number;
    designated: number;
    expiresAt: bigint;
    taskCid: Hex;
  };

  /** The registry's `Posted` for a relayed order, as the receipt carries it. */
  const postedLog = (order: PostedOrder, lineOwner: Hex) => {
    const args: Record<string, unknown> = {
      ...order,
      jobId: keccak256(`0x${lineOwner.slice(2)}${order.c.slice(2)}` as Hex),
      owner: lineOwner,
      gasFee: GAS_FEE,
    };
    const event = (jobRegistryAbi as Abi).find(
      (item): item is AbiEvent => item.type === "event" && item.name === "Posted",
    ) as AbiEvent;
    const body = event.inputs.filter((input) => !input.indexed);
    return {
      address: jobRegistry,
      topics: encodeEventTopics({ abi: jobRegistryAbi, eventName: "Posted", args }),
      data: encodeAbiParameters(body, body.map((input) => args[input.name as string])),
      blockNumber: "0x3e8",
      blockHash: `0x${"ab".repeat(32)}`,
      transactionHash: `0x${"cd".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
  };

  /** The four-byte selector of a custom error, as `try/catch` hands it back. */
  function selectorOf(errorName: string): Hex {
    return keccak256(new TextEncoder().encode(`${errorName}()`)).slice(0, 10) as Hex;
  }

  function chainWith(options: { receiptLogs?: () => unknown[] } = {}): StubChain {
    return stubChain(config, {
      views: { gasFee: GAS_FEE, feeBps: FEE_BPS },
      receiptLogs: options.receiptLogs,
    });
  }

  const run = (stub: StubChain, batchId: string) =>
    postBatch({ db, config, chain: stub.chain, pinner }, batchId);

  /** The decoded `postMany` arguments of the `n`th broadcast (0-based). */
  function postManyArgs(stub: StubChain, n = 0) {
    const decoded = decodeFunctionData({ abi: jobRegistryAbi, data: stub.relayed[n] });
    expect(decoded.functionName).toBe("postMany");
    const [orders, owners, orderSigs, authSigs] = decoded.args as unknown as [
      { taskCid: Hex; c: Hex }[],
      Hex[],
      Hex[],
      Hex[],
    ];
    return { orders, owners, orderSigs, authSigs };
  }

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

  /** Land a settled `jobs` row for a posted line, so the fold can finish its batch. */
  const settle = (jobId: Buffer) =>
    db.query(
      `INSERT INTO jobs (job_id, owner, c, model_id, sla_secs, designated, rate_in, rate_out,
                         units_in, units_out, expires_at, state, ended_because, provider_id,
                         completion_tok, task_cid, result_cid, as_of_block, gas_fee)
       VALUES ($1, $2, $3, 1, 3600, 7, 30000, 90000, 1000, 2000, $4, 2, 1, 7, 128, $5, $6, 1,
               30000)`,
      [
        jobId,
        OWNER_BYTES,
        randomBytes(32),
        BigInt(Math.floor(Date.now() / 1000)) + 3600n,
        Buffer.from("bafkreitask", "utf8"),
        Buffer.from("bafkreiresult", "utf8"),
      ],
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

  it("lands every line of a batch in one transaction and hands it to the fold", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2), await jsonLine(3)]);
    const stub = chainWith();

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(
      expect.objectContaining({ posted: 3, skipped: 0, transactions: 1 }),
    );
    // One broadcast for three lines — the whole reason `postMany` exists.
    expect(stub.broadcasts).toHaveLength(1);
    expect(postManyArgs(stub).orders).toHaveLength(3);

    const rows = await lineRows(batchId);
    expect(rows.map((row) => Number(row.line_no))).toEqual([1, 2, 3]);
    expect(rows.every((row) => row.job_id !== null)).toBe(true);
    expect(rows.every((row) => row.skip_reason === null)).toBe(true);

    const batch = await batchRow(batchId);
    expect(batch.status).toBe("in_progress");
    expect(batch.in_progress_at).not.toBeNull();
  });

  it("puts the name the store minted for each line's own container into that line's order", async () => {
    const containers = [containerFor(1), containerFor(2)];
    const batchId = await seedBatch([
      await jsonLine(1, { container: containers[0] }),
      await jsonLine(2, { container: containers[1] }),
    ]);
    const stub = chainWith();

    await run(stub, batchId);

    // `taskCid` is a `post` **parameter**, not a signed member — the client cannot
    // know it, because this node is the party that mints it. So the only proof
    // the right bytes reached the right line is this comparison.
    const { orders } = postManyArgs(stub);
    const minted = containers.map((bytes) => store.mintedCid(bytes));
    expect(orders.map((order) => Buffer.from(order.taskCid.slice(2), "hex").toString("utf8"))).toEqual(
      minted,
    );
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

  it("skips a line this node refuses and lands its neighbours anyway", async () => {
    const batchId = await seedBatch([
      await jsonLine(1),
      await jsonLine(2, { signer: stranger }),
      await jsonLine(3),
    ]);
    const stub = chainWith();

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 2, skipped: 1 }));
    // The refused line never reaches the chain: two orders, not three.
    expect(postManyArgs(stub).orders).toHaveLength(2);

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

    expect(outcome).toEqual(expect.objectContaining({ posted: 2, skipped: 1 }));
    expect((await lineRows(batchId))[1].skip_reason).toBe("invalid_json");
  });

  it("skips a line naming a model the catalog does not enable", async () => {
    await enableModel(1, false);
    const batchId = await seedBatch([await jsonLine(1)]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 0, skipped: 1 }));
    expect((await lineRows(batchId))[0].skip_reason).toBe("invalid_model");
  });

  it("skips the second of two lines that name the same job", async () => {
    const same = containerFor(9);
    const batchId = await seedBatch([
      await jsonLine(1, { container: same }),
      await jsonLine(2, { container: same }),
    ]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 1, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].job_id).not.toBeNull();
    expect(rows[1].skip_reason).toBe("duplicate_job_id");
  });

  /**
   * The contract's own receipt. `postMany` skips rather than reverting, so "the
   * transaction succeeded" and "the line landed" are different facts, and only a
   * `PostSkipped` log tells them apart.
   */
  it("reads PostSkipped off the receipt and takes back the line it names", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    const stub = chainWith({ receiptLogs: () => [postSkippedLog(1, "DuplicateJob")] });

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 1, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].job_id).not.toBeNull();
    expect(rows[1].job_id).toBeNull();
    expect(rows[1].skip_reason).toBe("DuplicateJob");
  });

  /**
   * Write-through: each member job is readable by id from the moment the chunk's
   * receipt is in, not a poll later when the indexer reaches that block.
   */
  it("writes the jobs rows of the lines that landed, and none for a skipped line", async () => {
    await db.query("TRUNCATE jobs");
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    const stub: StubChain = chainWith({
      // Built from what was actually relayed, as the contract would emit it.
      receiptLogs: () => {
        const { orders, owners } = postManyArgs(stub);
        return [postedLog(orders[0] as PostedOrder, owners[0] as Hex), postSkippedLog(1, "DuplicateJob")];
      },
    });

    await run(stub, batchId);

    const { orders, owners } = postManyArgs(stub);
    const jobIds = orders.map((order, i) => keccak256(`0x${(owners[i] as Hex).slice(2)}${order.c.slice(2)}` as Hex));
    const { rows } = await db.query<{ job_id: Buffer; posted_block: string }>("SELECT job_id, posted_block FROM jobs");
    expect(rows.map((row) => `0x${row.job_id.toString("hex")}`)).toEqual([jobIds[0]]);
    expect(BigInt(rows[0]?.posted_block ?? 0)).toBe(1000n);
  });

  // -------------------------------------------------------------------------
  // Chunking
  // -------------------------------------------------------------------------

  it("chunks past the per-transaction line cap rather than building one unmineable call", async () => {
    const count = MAX_LINES_PER_TRANSACTION + 2;
    const lines = await Promise.all(
      Array.from({ length: count }, (_, index) => jsonLine(index + 1)),
    );
    const batchId = await seedBatch(lines);
    const stub = chainWith();

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: count, transactions: 2 }));
    expect(stub.broadcasts).toHaveLength(2);
    expect(postManyArgs(stub, 0).orders).toHaveLength(MAX_LINES_PER_TRANSACTION);
    expect(postManyArgs(stub, 1).orders).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Resume, cancel, and the input that is gone
  // -------------------------------------------------------------------------

  it("posts nothing a second time: a line already recorded is a line already decided", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    await run(chainWith(), batchId);

    // The batch is `in_progress` now, so a second pass is only reachable by a
    // worker that crashed mid-run. Put the row back and prove the lines are not
    // re-posted: a double post is escrow committed twice for one line.
    await db.query("UPDATE batches SET status = 'validating' WHERE batch_id = $1", [batchId]);
    const second = chainWith();
    const outcome = await run(second, batchId);

    expect(second.broadcasts).toHaveLength(0);
    expect(outcome).toEqual(expect.objectContaining({ posted: 0, skipped: 0, transactions: 0 }));
    expect(await lineRows(batchId)).toHaveLength(2);
  });

  it("posts nothing for a batch cancelled before the worker reached it", async () => {
    const created = BigInt(Math.floor(Date.now() / 1000));
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)], {
      cancelling_at: created,
    });
    const stub = chainWith();

    const outcome = await run(stub, batchId);

    expect(stub.broadcasts).toHaveLength(0);
    expect(outcome).toEqual(expect.objectContaining({ posted: 0, skipped: 2 }));
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
    const stub = chainWith();

    await expect(run(stub, batchId)).rejects.toThrow();

    expect(stub.broadcasts).toHaveLength(0);
    expect((await batchRow(batchId)).status).toBe("validating");
    // Nothing half-written: a line with no decision is a line the retry re-decides.
    expect(await lineRows(batchId)).toHaveLength(0);
  });

  it("skips a batch that is not validating", async () => {
    const batchId = await seedBatch([await jsonLine(1)], { status: "in_progress" });
    expect(await run(chainWith(), batchId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Gas — the one thing an estimate cannot decide here
  // -------------------------------------------------------------------------

  /**
   * **`postMany` must be sent with a gas limit this node computed.**
   *
   * `eth_estimateGas` searches for the least gas at which the transaction
   * succeeds, and `postMany` succeeds *however many lines it skipped* — that is
   * what `try/catch` per line means. So the estimate converges on a value at which
   * the tail of the chunk runs out of gas inside its sub-call, is caught, and is
   * reported as `PostSkipped` on a transaction whose receipt says success.
   *
   * Measured on the devnet before this existed: a two-line batch estimated at
   * 449 299 gas, used exactly 449 299, landed line 1 and skipped line 2 with empty
   * revert data. Traced with 5 000 000 gas the same calldata lands both for
   * 588 052. The estimate was not wrong about what it was asked — it was asked the
   * wrong question.
   */
  it("sizes the transaction's gas from the chunk instead of letting an estimate decide", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2), await jsonLine(3)]);
    const stub = chainWith();

    await run(stub, batchId);

    expect(stub.relayedGas[0]).toBeGreaterThanOrEqual(GAS_PER_LINE * 3n);
  });

  it("leaves a line the chunk ran out of gas on undecided, rather than recording a skip", async () => {
    // Empty revert data is not a verdict. Every way `post` refuses a line names
    // itself with a custom error selector, so `0x` means the sub-call died without
    // returning — out of gas — and the contract never got as far as an opinion.
    // Recording that as a skip would tell the caller its line was refused when
    // nothing about it was wrong, and would do it permanently: a row is a decision
    // and a later pass does not revisit one.
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    const stub = chainWith({ receiptLogs: () => [postSkippedRaw(1, "0x")] });

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 1, undecided: 1 }));
    expect((await lineRows(batchId)).map((row) => Number(row.line_no))).toEqual([1]);
    // And the batch has **not** moved on. `in_progress` is the promise that every
    // line has a verdict, and one of them does not.
    expect(await batchRow(batchId)).toEqual(expect.objectContaining({ status: "validating" }));
  });

  it("posts the undecided line on the next pass and only then hands the batch over", async () => {
    const batchId = await seedBatch([await jsonLine(1), await jsonLine(2)]);
    let receipt: () => unknown[] = () => [postSkippedRaw(1, "0x")];
    const stub = chainWith({ receiptLogs: () => receipt() });
    await run(stub, batchId);

    receipt = () => [];
    const outcome = await run(stub, batchId);

    // Only the line that has no row: re-posting the one that landed would be
    // answered `DuplicateJob`, and the point of the row is that a later pass can
    // tell the two apart without asking the chain.
    expect(outcome).toEqual(expect.objectContaining({ posted: 1, undecided: 0 }));
    expect(postManyArgs(stub, 1).orders).toHaveLength(1);
    expect((await lineRows(batchId)).map((row) => Number(row.line_no))).toEqual([1, 2]);
    expect((await batchRow(batchId)).status).toBe("in_progress");
  });

  // -------------------------------------------------------------------------
  // Restarting mid-batch
  // -------------------------------------------------------------------------

  /**
   * `batch_lines` is in `PRESERVED`, and that is what replaced the manifest.
   *
   * Everything else about a batch is a fold over its member jobs, which the chain
   * replays. The batch↔job link is not: `batch_id` never reaches the chain, and
   * every line is an independent designated order — which is exactly what lets one
   * batch spread across providers with no coordination. So these rows are the only
   * record of which line is which job, they are never dropped, and nothing has to
   * be read back out of the store to recover them.
   */
  const deps = (stub: StubChain): BatchWorkerDeps => ({
    db,
    config,
    chain: stub.chain,
    pinner,
  });

  it("finishes a batch whose second chunk died between its rows and its relay", async () => {
    // The crash window the row ordering exists for, at chunk granularity. The
    // rows are written **before** the relay, so a broadcast that never happens
    // leaves lines recorded with a `job_id` no transaction ever posted — the
    // bounded worst case the module comment names. A resumed pass must therefore
    // post the chunks that have no rows, leave the recorded ones alone, and still
    // stamp `in_progress`: nothing has to be read back out of the store first,
    // and no row count is reconciled against the input file.
    const count = MAX_LINES_PER_TRANSACTION + 2;
    const lines = await Promise.all(
      Array.from({ length: count }, (_, index) => jsonLine(index + 1)),
    );
    const batchId = await seedBatch(lines);

    // The first pass loses its second chunk's broadcast. `sendError` answers
    // `undefined` for the send it is not failing, so exactly one of the two dies.
    let sent = 0;
    const dying = stubChain(config, {
      views: { gasFee: GAS_FEE, feeBps: FEE_BPS },
      sendError: () => (++sent === 2 ? new Error("the process went away") : undefined),
    });
    await expect(postBatch({ db, config, chain: dying.chain, pinner }, batchId)).rejects.toThrow();

    expect(dying.broadcasts).toHaveLength(1);
    expect((await batchRow(batchId)).status).toBe("validating");
    // Both chunks' rows are on the table — the second chunk's were written
    // before the relay that never landed.
    expect(await lineRows(batchId)).toHaveLength(count);

    const resumed = chainWith();
    const outcome = await run(resumed, batchId);

    // Nothing is re-posted, because every line already carries a decision, and
    // the batch is handed to the fold rather than left validating forever.
    expect(outcome).toEqual(
      expect.objectContaining({ posted: 0, skipped: 0, undecided: 0, transactions: 0 }),
    );
    expect(resumed.broadcasts).toHaveLength(0);
    expect((await batchRow(batchId)).status).toBe("in_progress");
  });

  // -------------------------------------------------------------------------
  // A line that references an upload rather than inlining its container
  // -------------------------------------------------------------------------

  it("posts a container_cid line under the uploaded cid, filing nothing for it", async () => {
    // The cid **is** the `task_cid`: the bytes are already in the store, so this
    // line costs no put, and the row records the name the upload carries.
    const container = containerFor(41);
    const uploadCid = await seedUpload(container);
    const batchId = await seedBatch([await jsonLine(41, { container, containerCid: uploadCid })]);
    const stub = chainWith();
    // Everything the pass files from here on is a *new* object; the upload is
    // already in.
    const before = store.objects.size;

    const outcome = await run(stub, batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 1, skipped: 0 }));
    expect(store.objects.size).toBe(before);
    const [row] = await lineRows(batchId);
    expect(row.task_cid).toBe(uploadCid);
    const { orders } = postManyArgs(stub);
    expect(Buffer.from(orders[0].taskCid.slice(2), "hex").toString("utf8")).toBe(uploadCid);
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

  it("skips a container_cid line whose upload is gone, and lands its neighbour", async () => {
    // A file that expired, or one that belongs to somebody else, is one line's
    // problem: the other 49 999 still post.
    const container = containerFor(43);
    const batchId = await seedBatch([
      await jsonLine(43, { container, containerCid: "bafynothinguploaded" }),
      await jsonLine(44),
    ]);

    const outcome = await run(chainWith(), batchId);

    expect(outcome).toEqual(expect.objectContaining({ posted: 1, skipped: 1 }));
    const rows = await lineRows(batchId);
    expect(rows[0].skip_reason).toBe("unknown_container");
    expect(rows[0].job_id).toBeNull();
    expect(rows[1].job_id).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The pass over every batch
  // -------------------------------------------------------------------------

  it("freezes a batch whose every line is terminal in the same pass", async () => {
    // The other half of a tick, and the one the rebuild pass used to run ahead
    // of: `finalizeBatch` finishes a batch when every line is terminal, reading
    // that off `batch_lines` — which is preserved, so there is nothing to put
    // back first.
    const batchId = await seedBatch([await jsonLine(1)]);
    const stub = chainWith();
    await run(stub, batchId);
    const [line] = await lineRows(batchId);
    await settle(line.job_id as Buffer);

    const done = await batchWorkerTick(deps(stub), () => undefined);

    expect(done.finalized).toEqual([batchId]);
    expect(await outputRowCount(batchId)).toBe(1);
  });

  it("posts every validating batch in one pass", async () => {
    const first = await seedBatch([await jsonLine(1)]);
    const second = await seedBatch([await jsonLine(2)]);
    const stub = chainWith();

    const done = await batchWorkerTick({ db, config, chain: stub.chain, pinner }, () => undefined);

    expect(done.posted.sort()).toEqual([first, second].sort());
    expect(stub.broadcasts).toHaveLength(2);
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
    // and the healthy one still posts. A pass that stopped at the first bad batch
    // would let one unresolvable input hold up every other client's work.
    expect(done.posted).toEqual([healthy]);
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
