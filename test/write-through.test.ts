import {
  encodeAbiParameters,
  encodeEventTopics,
  stringToHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { openDb, type Db } from "../src/db/db.js";
import { reduceRange } from "../src/index/reducer.js";
import { dropUnconfirmed, writePostedRows } from "../src/index/write-through.js";

/**
 * Write-through: a post's `jobs` rows, written from its own receipt.
 *
 * Against a real projection, because what has to hold is a property of the
 * reducer's upsert rather than of this module: the row written here is the row a
 * replay writes, and the indexed log that follows lands on it without moving
 * anything a later event already moved.
 *
 * Database-gated (R25):
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = "vorq_write_through_test";

const JOB_REGISTRY: Address = "0x1111111111111111111111111111111111111111";
const STRANGER: Address = "0x9999999999999999999999999999999999999999";
const OWNER: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const word = (fill: string): Hex => `0x${fill.repeat(32)}`;

/** Encodes one event off the vendored ABI: indexed members to topics, the rest to data. */
function eventLog(address: Address, eventName: string, args: Record<string, unknown>, blockNumber = 1000n): Log {
  const event = (jobRegistryAbi as Abi).find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  ) as AbiEvent;
  const body = event.inputs.filter((input) => !input.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi: jobRegistryAbi, eventName, args } as never) as [Hex, ...Hex[]],
    data: encodeAbiParameters(body, body.map((input) => args[input.name as string])),
    blockHash: word("bb"),
    blockNumber,
    logIndex: 0,
    removed: false,
    transactionHash: word("cc"),
    transactionIndex: 0,
  };
}

/** The gas fee a `Posted` here carries, in atomic units. */
const GAS_FEE = 30_000n;

const posted = (jobId: Hex, address: Address = JOB_REGISTRY, blockNumber = 1000n, gasFee = GAS_FEE): Log =>
  eventLog(
    address,
    "Posted",
    {
      jobId,
      modelId: 7,
      designated: 0,
      owner: OWNER,
      c: word("c1"),
      expiresAt: 4_102_444_800n,
      slaSecs: 3600,
      rateIn: 1_000_000n,
      rateOut: 2_000_000n,
      unitsIn: 1000,
      unitsOut: 2000,
      gasFee,
      taskCid: stringToHex("bafkreitaskcid"),
    },
    blockNumber,
  );

/** The hash of whatever block a `reduceRange` here advances the cursor to. */
const BLOCK_HASH = word("be");

const JOB_A = word("01");
const JOB_B = word("02");
const JOB_C = word("03");

describe.skipIf(!TEST_DATABASE_URL)("write-through from a post's receipt", () => {
  let db: Db;

  beforeAll(async () => {
    const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
    const url = TEST_DATABASE_URL as string;
    db = openDb(`${url}${url.includes("?") ? "&" : "?"}options=${options}`);
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE jobs, cursor");
  });

  const rowOf = async (jobId: Hex) =>
    (
      await db.query<{ state: number; posted_block: bigint; as_of_block: bigint }>(
        "SELECT state, posted_block, as_of_block FROM jobs WHERE job_id = $1",
        [Buffer.from(jobId.slice(2), "hex")],
      )
    ).rows[0];

  it("writes the job at the receipt's block, so posted_block is known at once", async () => {
    const count = await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);

    expect(count).toBe(1);
    expect(await rowOf(JOB_A)).toEqual({ state: 0, posted_block: 1000n, as_of_block: 1000n });
  });

  it("writes every Posted of a postMany receipt, and nothing for its skipped lines or other logs", async () => {
    const skipped = eventLog(JOB_REGISTRY, "PostSkipped", { index: 1n, reason: "0x12345678" });
    const settled = eventLog(JOB_REGISTRY, "Settled", {
      jobId: JOB_A,
      completionTok: 1,
      fee: 2_500n,
      resultCid: stringToHex("bafkreiresult"),
    });

    const count = await writePostedRows(
      db,
      JOB_REGISTRY,
      [posted(JOB_A), skipped, posted(JOB_B), settled, posted(JOB_C)],
      1000n,
    );

    // `Settled` is an update behind the orphan check and stays the indexer's; a
    // write-through that applied it would be applying a transition it never saw.
    expect(count).toBe(3);
    const { rows } = await db.query<{ n: bigint }>("SELECT count(*) AS n FROM jobs");
    expect(rows[0]?.n).toBe(3n);
    expect((await rowOf(JOB_A))?.state).toBe(0);
  });

  it("ignores a Posted that some other contract emitted", async () => {
    const count = await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A, STRANGER)], 1000n);

    expect(count).toBe(0);
    expect(await rowOf(JOB_A)).toBeUndefined();
  });

  it("matches a checksummed registry against a lowercase log address", async () => {
    const checksummed: Address = "0xAbCdEf0000000000000000000000000000000001";

    const count = await writePostedRows(db, checksummed, [posted(JOB_A, checksummed.toLowerCase() as Address)], 1000n);

    expect(count).toBe(1);
  });

  /**
   * The indexed log arrives after the job has moved on. The `Posted` upsert
   * leaves lifecycle columns alone, so a row written through and then claimed
   * is not rolled back to Open when the indexer replays the range.
   */
  it("is overtaken cleanly by the indexer's replay of the same range", async () => {
    await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);
    const claimed = eventLog(JOB_REGISTRY, "Claimed", { jobId: JOB_A, provider: 3, claimedAt: 1_700_000_000n }, 1001n);

    await reduceRange(db, [posted(JOB_A), { ...claimed, logIndex: 0 }], 1001n, BLOCK_HASH);

    expect(await rowOf(JOB_A)).toEqual({ state: 1, posted_block: 1000n, as_of_block: 1001n });
  });

  /**
   * The gas fee the contract snapshotted rides on the receipt's own `Posted`,
   * so the row written ahead already holds it, and the replay of the same log
   * writes the same value back. The protocol fee waits for `Settled`.
   */
  it("writes the gas fee the receipt's Posted carries, with no fee yet", async () => {
    await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A, JOB_REGISTRY, 1000n, 45_000n)], 1000n);
    const fees = async () =>
      (
        await db.query<{ gas_fee: bigint; fee: bigint }>("SELECT gas_fee, fee FROM jobs WHERE job_id = $1", [
          Buffer.from(JOB_A.slice(2), "hex"),
        ])
      ).rows[0];
    expect(await fees()).toEqual({ gas_fee: 45_000n, fee: 0n });

    await reduceRange(db, [posted(JOB_A, JOB_REGISTRY, 1000n, 45_000n)], 1000n, BLOCK_HASH);

    expect(await fees()).toEqual({ gas_fee: 45_000n, fee: 0n });
  });

  /**
   * Both post doors retry, and a receipt can be handed here twice — the batch
   * worker re-enters `postChunk` for a chunk whose write threw after the lines
   * were already decided. The second pass must be a no-op, not a second row and
   * not a reset.
   */
  it("applies the same receipt twice without changing the row", async () => {
    await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);
    const first = await rowOf(JOB_A);

    const count = await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);

    expect(count).toBe(1);
    expect(await rowOf(JOB_A)).toEqual(first);
    const { rows } = await db.query<{ n: bigint }>("SELECT count(*) AS n FROM jobs");
    expect(rows[0]?.n).toBe(1n);
  });

  /**
   * R10: the cursor is the indexer's alone. A write-through that advanced it
   * would tell the indexer a range was applied when only one event of it was,
   * and every log between would be skipped forever.
   */
  it("leaves the cursor alone", async () => {
    await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);

    const { rows } = await db.query("SELECT block_number FROM cursor");
    expect(rows).toEqual([]);
  });

  describe("dropUnconfirmed", () => {
    const key = (jobId: Hex) => Buffer.from(jobId.slice(2), "hex");

    it("deletes a row the indexer has not reached, which is the orphaned post", async () => {
      await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);
      await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 999, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')");

      expect(await dropUnconfirmed(db, key(JOB_A))).toBe(true);
      expect(await rowOf(JOB_A)).toBeUndefined();
    });

    /**
     * The guard that keeps one lagging RPC endpoint from emptying the book: at
     * or behind the cursor the row came from an indexed log, so a `found =
     * false` read disagreeing with it is the endpoint's problem, not the row's.
     */
    it("keeps a row the indexer has confirmed", async () => {
      await writePostedRows(db, JOB_REGISTRY, [posted(JOB_A)], 1000n);
      await db.query("INSERT INTO cursor (id, block_number, block_hash) VALUES (1, 1000, '0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe')");

      expect(await dropUnconfirmed(db, key(JOB_A))).toBe(false);
      expect(await rowOf(JOB_A)).toBeDefined();
    });

    it("reports nothing dropped when there is no such row", async () => {
      expect(await dropUnconfirmed(db, key(JOB_B))).toBe(false);
    });
  });
});
