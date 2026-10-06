import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  hexToBytes,
  keccak256,
  stringToHex,
  toBytes,
  toEventSelector,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askRegistryAbi } from "../src/abi/askRegistry.js";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import { providerRegistryAbi } from "../src/abi/providerRegistry.js";
import { openDb, type Db } from "../src/db/db.js";
import {
  decodeLog,
  jsonbFromBytes,
  MAX_JSONB_DEPTH,
  PROJECTED_EVENT_NAMES,
  textFromChainString,
} from "../src/index/decode.js";
import { reduceRange as reduceRangeAt } from "../src/index/reducer.js";

/**
 * Reducer tests. No chain and no network: every log here is synthesised from the
 * vendored ABIs with viem's own topic and parameter encoders, so the code under
 * test runs through viem's real decode path while the "chain" is this file.
 *
 * The database half is gated on `TEST_DATABASE_URL` and stays in the **unit** suite
 * (R25) — the no-network rule is about chain access, not a local Postgres:
 *
 *   docker compose -f compose.dev.yml up -d
 *   TEST_DATABASE_URL=postgres://vorq:vorq@localhost:5433/vorq npm test
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TEST_SCHEMA = "vorq_reducer_test";

const JOB_REGISTRY = "0x1111111111111111111111111111111111111111" as const;
const PROVIDER_REGISTRY = "0x2222222222222222222222222222222222222222" as const;
const ASK_REGISTRY = "0x3333333333333333333333333333333333333333" as const;

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OPERATOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

const word = (fill: string): Hex => `0x${fill.repeat(32)}`;

const JOB_A = word("01");
const JOB_B = word("02");
const JOB_C = word("03");
const C_A = word("c1");
const BOX_KEY = word("bc");
const ALLOWLIST_KEY = word("a1");

const EXPIRES = 4_102_444_800n;
const RATE_IN = 1_000_000n;
const RATE_OUT = 2_000_000n;
/** Past the double range: a `Number()` anywhere on the path would be visible. */
const UINT128_RATE = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
/**
 * The largest `uint32`, and 2 147 483 648 past what `int4` can hold. Every
 * column fed by a chain `uint32` is `BIGINT` for this reason (R48).
 */
const MAX_UINT32 = 4_294_967_295;
/** The largest `uint16`, which is what `ReputationChanged.milli` is. */
const MAX_UINT16 = 65_535;
/** The same value as it reads back out of a widened column. */
const WIDE = BigInt(MAX_UINT32);

/**
 * Written as a code unit rather than as a literal, so this file never carries a
 * control character of its own — which would make it the thing under test.
 */
const NUL = String.fromCharCode(0);

/** `[[[…]]]` — `containers` levels of array nesting, and nothing else. */
const nested = (containers: number): string => "[".repeat(containers) + "]".repeat(containers);

/**
 * Payloads that `JSON.parse` accepts and the projection must still not offer
 * Postgres as-is. Each is a permanent wedge unscreened (R50, R50a), and every
 * one is reachable by any registered provider through signature-only
 * `setIdentity`.
 *
 * They fail for two different reasons, which is the point of testing them
 * together: the first four are *refused* by the `jsonb` input function, and the
 * last two make that same input function **raise** — `pg_input_is_valid`
 * converts soft errors only, and the parser's recursion guard is a hard one.
 */
const UNSTORABLE_JSON: readonly [name: string, text: string][] = [
  ["a lone surrogate", '{"a":"\\ud800"}'],
  ["a numeric literal past NUMERIC", '{"n":1e1000000000}'],
  ["an escaped NUL", '{"a":"\\u0000"}'],
  ["a raw NUL byte", `{"a":"x${NUL}y"}`],
  // 16365 is the measured container depth at which `pg_input_is_valid` raises
  // `stack depth limit exceeded` on a default 2 MB stack. 32 730 bytes.
  ["nesting at the measured stack-depth threshold", nested(16_365)],
  ["nesting far past it", nested(100_000)],
];
const TASK_CID = stringToHex("bafkreitaskcid");
const RESULT_CID = stringToHex("bafkreiresultcid");

/** Every table the reducer is allowed to write. `pins` and `quotes_live` are not derived (R44). */
const DERIVED = ["allowlist", "asks_chain", "cursor", "jobs", "models", "providers"] as const;

/** The relay gas fee a `Posted` carries, in atomic units. */
const GAS_FEE = 30_000n;
/** The protocol fee a `Settled` carries, in atomic units. */
const FEE = 2_500n;

// ---------------------------------------------------------------------------
// Log synthesis
// ---------------------------------------------------------------------------

type Encoded = { data: Hex; topics: [Hex, ...Hex[]] | [] };
interface Emit {
  address: Address;
  encoded: Encoded;
}

/**
 * Encodes an event exactly as the EVM would: indexed members into topics,
 * everything else into the data word. viem has no `encodeEventLog`, so this is
 * `encodeEventTopics` plus `encodeAbiParameters` over the non-indexed inputs —
 * both driven off the vendored ABI, so the topics these tests emit are the ones
 * the contracts really emit.
 */
function encodeLog(abi: Abi, eventName: string, args: Record<string, unknown>): Encoded {
  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName,
  );
  if (event === undefined) throw new Error(`the ABI declares no event named ${eventName}`);

  const topics = encodeEventTopics({ abi, eventName, args }) as [Hex, ...Hex[]];
  const body = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    body,
    body.map((input) => args[input.name as string]),
  );
  return { data, topics };
}

const from =
  (address: Address) =>
  (encoded: Encoded): Emit => ({ address, encoded });

const job = from(JOB_REGISTRY);
const registry = from(PROVIDER_REGISTRY);
const asks = from(ASK_REGISTRY);

function logAt(emit: Emit, blockNumber: bigint, logIndex: number): Log {
  return {
    address: emit.address,
    blockHash: word("bb"),
    blockNumber,
    data: emit.encoded.data,
    logIndex,
    removed: false,
    topics: emit.encoded.topics,
    transactionHash: word("cc"),
    transactionIndex: 0,
  };
}

/** Lays emissions out one per block from `firstBlock`, which is the order they were emitted in. */
function stream(emits: readonly Emit[], firstBlock = 1n): Log[] {
  return emits.map((emit, index) => logAt(emit, firstBlock + BigInt(index), 0));
}

interface PostedOverrides {
  jobId?: Hex;
  modelId?: number;
  designated?: number;
  owner?: Address;
  c?: Hex;
  expiresAt?: bigint;
  slaSecs?: number;
  rateIn?: bigint;
  rateOut?: bigint;
  unitsIn?: number;
  unitsOut?: number;
  gasFee?: bigint;
  taskCid?: Hex;
}

const posted = (over: PostedOverrides = {}): Emit =>
  job(
    encodeLog(jobRegistryAbi, "Posted", {
      jobId: JOB_A,
      modelId: 7,
      designated: 0,
      owner: OWNER,
      c: C_A,
      expiresAt: EXPIRES,
      slaSecs: 3600,
      rateIn: RATE_IN,
      rateOut: RATE_OUT,
      unitsIn: 1000,
      unitsOut: 2000,
      gasFee: GAS_FEE,
      taskCid: TASK_CID,
      ...over,
    }),
  );

const claimed = (jobId: Hex, provider = 3, claimedAt = 1_700_000_000n): Emit =>
  job(encodeLog(jobRegistryAbi, "Claimed", { jobId, provider, claimedAt }));

const settled = (jobId: Hex, completionTok = 1500, fee = FEE, resultCid: Hex = RESULT_CID): Emit =>
  job(encodeLog(jobRegistryAbi, "Settled", { jobId, completionTok, fee, resultCid }));

const ended = (jobId: Hex, cause: number): Emit =>
  job(encodeLog(jobRegistryAbi, "Ended", { jobId, cause }));

const providerRegistered = (providerId: number, operator: Address = OPERATOR): Emit =>
  registry(
    encodeLog(providerRegistryAbi, "ProviderRegistered", {
      providerId,
      operator,
    }),
  );

const listedChanged = (providerId: number, listed: boolean): Emit =>
  registry(encodeLog(providerRegistryAbi, "ListedChanged", { providerId, listed }));

const operatorChanged = (providerId: number, operator: Address): Emit =>
  registry(encodeLog(providerRegistryAbi, "OperatorChanged", { providerId, operator }));

/** `milli` is a uint16 on chain, clamped to [100,1000] by the registry. */
const reputationChanged = (providerId: number, milli: number): Emit =>
  registry(encodeLog(providerRegistryAbi, "ReputationChanged", { providerId, milli }));

const capacityChanged = (providerId: number, ceiling: number, requested: number): Emit =>
  registry(
    encodeLog(providerRegistryAbi, "CapacityChanged", {
      providerId,
      ceiling,
      requested,
    }),
  );

const allowedModelsChanged = (providerId: number, allowAll: boolean, modelIds: number[]): Emit =>
  registry(
    encodeLog(providerRegistryAbi, "AllowedModelsChanged", {
      providerId,
      allowAll,
      modelIds,
    }),
  );

const identityUpdated = (providerId: number, boxKey: Hex, evidence: Hex): Emit =>
  registry(
    encodeLog(providerRegistryAbi, "IdentityUpdated", {
      providerId,
      boxKey,
      evidence,
    }),
  );

const modelRegistered = (modelId: number, name: string): Emit =>
  registry(encodeLog(providerRegistryAbi, "ModelRegistered", { modelId, name }));

const modelEnabledChanged = (modelId: number, enabled: boolean): Emit =>
  registry(encodeLog(providerRegistryAbi, "ModelEnabledChanged", { modelId, enabled }));

const allowlistEntrySet = (key: Hex, status: number, entry: Hex): Emit =>
  registry(encodeLog(providerRegistryAbi, "AllowlistEntrySet", { key, status, entry }));

interface Quote {
  modelId: number;
  sla: number;
  rateIn: bigint;
  rateOut: bigint;
}

const asksPublished = (providerId: number, signedAt: bigint, quotes: Quote[]): Emit =>
  asks(
    encodeLog(askRegistryAbi, "AsksPublished", {
      providerId,
      signedAt,
      quotes,
    }),
  );

// ---------------------------------------------------------------------------
// decode — no database
// ---------------------------------------------------------------------------

describe("decodeLog", () => {
  it("decodes Posted with every member off the vendored ABI", () => {
    const event = decodeLog(logAt(posted({ rateIn: UINT128_RATE }), 1n, 0));

    expect(event).toEqual({
      eventName: "Posted",
      args: {
        jobId: JOB_A,
        modelId: 7,
        designated: 0,
        // Checksummed, because that is what viem hands back. Anything comparing
        // a decoded address to a stored one must fold the case first; the
        // projection sidesteps it by storing addresses as BYTEA.
        owner: getAddress(OWNER),
        c: C_A,
        expiresAt: EXPIRES,
        slaSecs: 3600,
        rateIn: UINT128_RATE,
        rateOut: RATE_OUT,
        unitsIn: 1000,
        unitsOut: 2000,
        gasFee: GAS_FEE,
        taskCid: TASK_CID,
      },
    });
  });

  it("decodes every event the projection stores", () => {
    const emits: readonly [Emit, string][] = [
      [posted(), "Posted"],
      [claimed(JOB_A), "Claimed"],
      [settled(JOB_A), "Settled"],
      [ended(JOB_A, 2), "Ended"],
      [providerRegistered(1), "ProviderRegistered"],
      [listedChanged(1, false), "ListedChanged"],
      [capacityChanged(1, 5, 2), "CapacityChanged"],
      [allowedModelsChanged(1, false, [1, 2]), "AllowedModelsChanged"],
      [identityUpdated(1, BOX_KEY, "0x"), "IdentityUpdated"],
      [modelRegistered(1, "model-a"), "ModelRegistered"],
      [modelEnabledChanged(1, false), "ModelEnabledChanged"],
      [allowlistEntrySet(ALLOWLIST_KEY, 1, "0x"), "AllowlistEntrySet"],
      [asksPublished(1, 100n, []), "AsksPublished"],
      [operatorChanged(1, OPERATOR), "OperatorChanged"],
      [reputationChanged(1, 205), "ReputationChanged"],
    ];

    for (const [emit, name] of emits) {
      expect(decodeLog(logAt(emit, 1n, 0))?.eventName).toBe(name);
    }
    // The set is closed: the list above is every topic the reducer subscribes
    // to, so a dropped event shows up here rather than as an index that quietly
    // stops tracking something.
    expect(PROJECTED_EVENT_NAMES).toEqual([...emits.map(([, name]) => name)].sort());
  });

  it("returns null for a topic no VORQ contract emits", () => {
    const transfer = {
      address: JOB_REGISTRY,
      topics: [toEventSelector("Transfer(address,address,uint256)")] as [Hex],
      data: "0x" as Hex,
    };
    expect(decodeLog(transfer)).toBeNull();
    expect(decodeLog({ topics: [], data: "0x" })).toBeNull();
  });

  it("returns null for the JobRegistry config events the index never projects", () => {
    // Fees, SLA and treasury come from Task 2's cached `eth_call` reader. A
    // second copy in the projection could disagree with the chain, so these
    // topics are deliberately absent from the decode table. What a job paid
    // rides on its own `Posted` and `Settled` instead.
    const config = [
      job(encodeLog(jobRegistryAbi, "FeesChanged", { feeBps: 250, gasFee: 1n })),
      job(
        encodeLog(jobRegistryAbi, "SlaAllowedChanged", {
          secs: 3600,
          allowed: true,
        }),
      ),
      job(encodeLog(jobRegistryAbi, "TreasuryChanged", { treasury: OWNER })),
    ];

    for (const emit of config) expect(decodeLog(logAt(emit, 1n, 0))).toBeNull();
  });

  it("subscribes to the tuple-expanded AsksPublished topic, not the human-readable one (R35)", () => {
    const emitted = logAt(asksPublished(1, 100n, []), 1n, 0).topics[0];

    expect(emitted).toBe(
      toEventSelector("AsksPublished(uint32,uint64,(uint32,uint32,uint128,uint128)[])"),
    );
    // Hashing the struct-named form gives a topic nothing ever emits: a reducer
    // keyed on it silently sees zero asks forever.
    const humanReadable = keccak256(toBytes("AsksPublished(uint32,uint64,Ask[])"));
    expect(emitted).not.toBe(humanReadable);
    expect(decodeLog({ topics: [humanReadable], data: "0x" })).toBeNull();
  });

  it("decodes the AsksPublished quote tuples", () => {
    const event = decodeLog(
      logAt(
        asksPublished(4, 1_700_000_000n, [
          { modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: UINT128_RATE },
        ]),
        1n,
        0,
      ),
    );

    expect(event).toEqual({
      eventName: "AsksPublished",
      args: {
        providerId: 4,
        signedAt: 1_700_000_000n,
        quotes: [{ modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: UINT128_RATE }],
      },
    });
  });
});

describe("jsonbFromBytes", () => {
  // R20/R50: nothing on chain makes an event's `bytes` member JSON, or even
  // makes it storable, and the reducer must never throw on a well-formed log.
  // This function offers Postgres a candidate and a fallback; `pg_input_is_valid`
  // in the write is what chooses between them, so the tests that matter are the
  // database-backed ones below.
  it("offers the log's own text, verbatim", () => {
    const text = '{"kind":"cvm","n":12345678901234567890}';
    expect(jsonbFromBytes(stringToHex(text))).toEqual({
      candidate: text,
      raw: JSON.stringify({ raw: stringToHex(text) }),
    });
  });

  it("falls back for bytes that are not text at all", () => {
    // Invalid UTF-8 never reaches Postgres as a parameter, so this one is
    // decided here rather than by `pg_input_is_valid`.
    const bytes = "0xff00" as Hex;
    const { candidate, raw } = jsonbFromBytes(bytes);
    expect(candidate).toBe(raw);
    expect(JSON.parse(raw)).toEqual({ raw: bytes });
  });

  it("falls back on a NUL, the one byte a text parameter cannot carry", () => {
    const bytes = stringToHex(`{"a":"x${NUL}y"}`);
    const { candidate, raw } = jsonbFromBytes(bytes);
    expect(candidate).toBe(raw);
    expect(JSON.parse(raw)).toEqual({ raw: bytes });
  });

  it("does not judge JSON that only Postgres can rule on", () => {
    // A lone surrogate and an over-large numeric literal both parse in JS. This
    // function deliberately passes them through unaltered: judging them here
    // would be a denylist of the shapes someone thought of, and the write asks
    // Postgres instead. The database-backed tests assert what actually lands.
    for (const text of ['{"a":"\\ud800"}', '{"n":1e1000000000}', '{"a":"\\u0000"}']) {
      expect(jsonbFromBytes(stringToHex(text)).candidate).toBe(text);
    }
  });

  it("admits nesting up to the bound, and refuses one level past it (R50a)", () => {
    // A bound, not a denylist: everything at or below it is admitted, so the
    // number needs choosing once rather than maintaining as payloads turn up.
    const atBound = nested(MAX_JSONB_DEPTH);
    expect(jsonbFromBytes(stringToHex(atBound)).candidate).toBe(atBound);

    const overBound = nested(MAX_JSONB_DEPTH + 1);
    const { candidate, raw } = jsonbFromBytes(stringToHex(overBound));
    expect(candidate).toBe(raw);
  });

  it("refuses the measured stack-depth payload without recursing itself", () => {
    // The reason the scanner is a loop and not a parse: `JSON.parse` on this
    // would blow the JS stack while measuring the thing meant to protect the
    // database's.
    for (const containers of [16_365, 100_000]) {
      const { candidate, raw } = jsonbFromBytes(stringToHex(nested(containers)));
      expect(candidate).toBe(raw);
    }
  });

  it("does not count brackets inside strings, which Postgres accepts at any length", () => {
    // `{"a":"[[[[…"}` is one container deep however long the run is, and
    // Postgres takes it — so the scanner must too, escapes included.
    const inString = `{"a":"${"[".repeat(5_000)}"}`;
    expect(jsonbFromBytes(stringToHex(inString)).candidate).toBe(inString);

    const escapedQuote = `{"a":"x\\"${"[".repeat(5_000)}"}`;
    expect(jsonbFromBytes(stringToHex(escapedQuote)).candidate).toBe(escapedQuote);
  });

  it("passes non-JSON text through for Postgres to refuse", () => {
    // `0xdeadbeef` decodes to text, so it is a candidate like any other and
    // `pg_input_is_valid` is what rejects it.
    expect(jsonbFromBytes(stringToHex("not json at all")).candidate).toBe("not json at all");
  });
});

describe("textFromChainString", () => {
  it("leaves an ordinary name alone", () => {
    expect(textFromChainString("model-a")).toBe("model-a");
  });

  it("replaces a NUL, which no TEXT parameter can carry (R50)", () => {
    expect(textFromChainString(`mod${NUL}el`)).toBe("mod\uFFFDel");
  });

  it("leaves a lone surrogate alone, because Postgres takes what Node encodes", () => {
    const name = "mod\ud800el";
    expect(textFromChainString(name)).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// apply / reduceRange — against a real Postgres
// ---------------------------------------------------------------------------

function scopedToTestSchema(url: string): string {
  const options = encodeURIComponent(`-c search_path=${TEST_SCHEMA}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

describe.skipIf(!TEST_DATABASE_URL)("reduceRange", () => {
  let db: Db;

  const bytes = (hex: Hex): Buffer => Buffer.from(hexToBytes(hex));

  /** The hash this suite hands `reduceRange` for block `n`. Distinct per block. */
  const blockHashOf = (block: bigint): Hex => keccak256(toHex(`block:${block}`));

  /**
   * `reduceRange` with the hash of `toBlock` supplied. This suite is about the
   * rows a range produces; that the hash lands with the cursor is asserted once,
   * under "the cursor", and the reorg guard that reads it is the indexer's.
   */
  const reduceRange = (db: Db, logs: Parameters<typeof reduceRangeAt>[1], toBlock: bigint) =>
    reduceRangeAt(db, logs, toBlock, blockHashOf(toBlock));

  async function cursorBlock(): Promise<bigint | undefined> {
    const { rows } = await db.query<{ block_number: bigint }>("SELECT block_number FROM cursor");
    return rows[0]?.block_number;
  }

  /**
   * Every derived table as canonical jsonb text, sorted. `to_jsonb(t)::text`
   * rather than the row itself because jsonb's text form is exact for a NUMERIC
   * and for a BIGINT alike — comparing parsed rows would compare doubles.
   */
  async function dump(): Promise<Record<string, string[]>> {
    const snapshot: Record<string, string[]> = {};
    for (const table of DERIVED) {
      const { rows } = await db.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${table} t`,
      );
      snapshot[table] = rows.map((row) => row.row).sort();
    }
    return snapshot;
  }

  beforeAll(async () => {
    db = openDb(scopedToTestSchema(TEST_DATABASE_URL as string));
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await db.migrate();
  });

  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await db.close();
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE ${DERIVED.join(", ")}`);
  });

  describe("the job lifecycle", () => {
    it("leaves one settled row after post → claim → settle", async () => {
      await reduceRange(db, stream([posted(), claimed(JOB_A, 3), settled(JOB_A, 1500)]), 3n);

      const { rows } = await db.query<{
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
        as_of_block: bigint;
        gas_fee: bigint;
        fee: bigint;
      }>("SELECT * FROM jobs");

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        job_id: bytes(JOB_A),
        owner: bytes(OWNER),
        c: bytes(C_A),
        model_id: 7n,
        sla_secs: 3600n,
        designated: 0n,
        rate_in: RATE_IN,
        rate_out: RATE_OUT,
        units_in: 1000n,
        units_out: 2000n,
        expires_at: EXPIRES,
        state: 2,
        ended_because: 1,
        provider_id: 3n,
        claimed_at: 1_700_000_000n,
        completion_tok: 1500n,
        task_cid: bytes(TASK_CID),
        result_cid: bytes(RESULT_CID),
        posted_block: 1n,
        as_of_block: 3n,
        gas_fee: GAS_FEE,
        fee: FEE,
      });
      expect(await cursorBlock()).toBe(3n);
    });

    it("records posted_block from the log, for Plan 3's escrow-orphan filter", async () => {
      await reduceRange(db, stream([posted()], 4242n), 5000n);

      const { rows } = await db.query<{
        posted_block: bigint;
        as_of_block: bigint;
      }>("SELECT posted_block, as_of_block FROM jobs");
      expect(rows[0]).toEqual({ posted_block: 4242n, as_of_block: 4242n });
    });

    it("carries a uint128 rate through as an exact bigint", async () => {
      await reduceRange(db, stream([posted({ rateIn: UINT128_RATE })]), 1n);

      const { rows } = await db.query<{ rate_in: bigint }>("SELECT rate_in FROM jobs");
      expect(rows[0]?.rate_in).toBe(UINT128_RATE);
    });

    it("maps every exit cause an Ended event can carry (R34)", async () => {
      // 1 (settled) and 5 (expired) never appear in an Ended event: settlement
      // has its own event and 5 is computed at read time.
      await reduceRange(
        db,
        stream([
          posted({ jobId: JOB_A, c: word("c1") }),
          posted({ jobId: JOB_B, c: word("c2") }),
          posted({ jobId: JOB_C, c: word("c3") }),
          ended(JOB_A, 2),
          ended(JOB_B, 3),
          ended(JOB_C, 4),
        ]),
        6n,
      );

      const { rows } = await db.query<{
        job_id: Buffer;
        state: number;
        ended_because: number;
      }>("SELECT job_id, state, ended_because FROM jobs ORDER BY job_id");
      expect(rows).toEqual([
        { job_id: bytes(JOB_A), state: 3, ended_because: 2 },
        { job_id: bytes(JOB_B), state: 3, ended_because: 3 },
        { job_id: bytes(JOB_C), state: 3, ended_because: 4 },
      ]);
    });

    it("cannot store ended cause 5, because the database forbids it (R43)", async () => {
      // Openness is never materialised. `5` exists only in `getJob`'s read-time
      // derivation; the CHECK is what makes that an invariant rather than a
      // convention, and this is the failure mode it is designed to produce.
      await expect(reduceRange(db, stream([posted(), ended(JOB_A, 5)]), 2n)).rejects.toThrow(
        /jobs_ended_because_check/,
      );
    });

    it("never writes an ending for a job that merely expired", async () => {
      await reduceRange(db, stream([posted({ expiresAt: 1n })]), 1n);

      const { rows } = await db.query<{ state: number; ended_because: number }>(
        "SELECT state, ended_because FROM jobs",
      );
      expect(rows[0]).toEqual({ state: 0, ended_because: 0 });
    });

    it("throws on a Claimed with no Posted, and never invents the row", async () => {
      await expect(reduceRange(db, stream([claimed(JOB_A)]), 1n)).rejects.toThrow(/Claimed/);

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM jobs");
      expect(rows[0]?.count).toBe(0n);
    });

    it("throws on an orphan Settled and an orphan Ended too", async () => {
      await expect(reduceRange(db, stream([settled(JOB_A)]), 1n)).rejects.toThrow(/Settled/);
      await expect(reduceRange(db, stream([ended(JOB_A, 2)]), 1n)).rejects.toThrow(/Ended/);
    });
  });

  describe("what a job paid", () => {
    // Both read straight off the job's own logs: `Posted` carries the gas fee
    // the contract snapshotted, `Settled` the protocol fee it took.
    it("stores the gas fee Posted carries, exactly, with no fee before settlement", async () => {
      await reduceRange(
        db,
        stream([
          posted({ jobId: JOB_A, c: word("c1") }),
          posted({ jobId: JOB_B, c: word("c2"), gasFee: UINT128_RATE }),
          posted({ jobId: JOB_C, c: word("c3"), gasFee: 0n }),
          claimed(JOB_B, 3),
        ]),
        4n,
      );

      const { rows } = await db.query<{ job_id: Buffer; gas_fee: bigint; fee: bigint }>(
        "SELECT job_id, gas_fee, fee FROM jobs ORDER BY job_id",
      );
      expect(rows).toEqual([
        { job_id: bytes(JOB_A), gas_fee: GAS_FEE, fee: 0n },
        { job_id: bytes(JOB_B), gas_fee: UINT128_RATE, fee: 0n },
        { job_id: bytes(JOB_C), gas_fee: 0n, fee: 0n },
      ]);
    });

    it("stores the fee Settled carries, and leaves every other ending at 0", async () => {
      await reduceRange(
        db,
        stream([
          posted({ jobId: JOB_A, c: word("c1") }),
          posted({ jobId: JOB_B, c: word("c2") }),
          claimed(JOB_A, 3),
          claimed(JOB_B, 3),
          settled(JOB_A, 1500, UINT128_RATE),
          ended(JOB_B, 2),
        ]),
        6n,
      );

      const { rows } = await db.query<{ job_id: Buffer; gas_fee: bigint; fee: bigint }>(
        "SELECT job_id, gas_fee, fee FROM jobs ORDER BY job_id",
      );
      expect(rows).toEqual([
        { job_id: bytes(JOB_A), gas_fee: GAS_FEE, fee: UINT128_RATE },
        { job_id: bytes(JOB_B), gas_fee: GAS_FEE, fee: 0n },
      ]);
    });
  });

  describe("the registry projection", () => {
    it("lands the four events a provider registration emits", async () => {
      await reduceRange(
        db,
        [
          logAt(providerRegistered(4), 1n, 0),
          logAt(listedChanged(4, false), 1n, 1),
          logAt(capacityChanged(4, 12, 0), 1n, 2),
          logAt(reputationChanged(4, 1000), 1n, 3),
        ],
        1n,
      );

      const { rows } = await db.query<{
        provider_id: bigint;
        operator: Buffer;
        listed: boolean;
        capacity_ceiling: bigint;
        capacity_requested: bigint;
        reputation: bigint;
      }>(
        "SELECT provider_id, operator, listed, capacity_ceiling, capacity_requested, reputation FROM providers",
      );

      expect(rows[0]).toEqual({
        provider_id: 4n,
        operator: bytes(OPERATOR),
        listed: false,
        capacity_ceiling: 12n,
        capacity_requested: 0n,
        // the seed curation registered with, carried by the paired ReputationChanged — the
        // column's own default is never what a real registration leaves behind
        reputation: 1000n,
      });
    });

    /// The `ProviderRegistered` insert carries no reputation, so the column needs a default for
    /// the row to exist at all. This pins what that default is — nothing reads it as a seed.
    it("lands a bare ProviderRegistered on the column default", async () => {
      await reduceRange(db, stream([providerRegistered(4)]), 1n);

      const { rows } = await db.query<{ reputation: bigint }>(
        "SELECT reputation FROM providers",
      );
      expect(rows[0]?.reputation).toBe(0n);
    });

    it("replaces allowed_models with the event's full list, never appending", async () => {
      await reduceRange(
        db,
        stream([
          providerRegistered(4),
          allowedModelsChanged(4, false, [1, 2, 3]),
          allowedModelsChanged(4, false, [9]),
        ]),
        3n,
      );

      const { rows } = await db.query<{
        allow_all_models: boolean;
        allowed_models: bigint[];
      }>("SELECT allow_all_models, allowed_models FROM providers");
      expect(rows[0]).toEqual({ allow_all_models: false, allowed_models: [9n] });
    });

    it("stores JSON identity evidence as JSON (R20)", async () => {
      await reduceRange(
        db,
        stream([
          providerRegistered(4),
          identityUpdated(4, BOX_KEY, stringToHex('{"kind":"cvm","image":"abc"}')),
        ]),
        2n,
      );

      const { rows } = await db.query<{ box_key: Buffer; evidence: unknown }>(
        "SELECT box_key, evidence FROM providers",
      );
      expect(rows[0]?.box_key).toEqual(bytes(BOX_KEY));
      expect(rows[0]?.evidence).toEqual({ kind: "cvm", image: "abc" });
    });

    it("does not throw when identity evidence is not JSON (R20)", async () => {
      await reduceRange(
        db,
        stream([providerRegistered(4), identityUpdated(4, BOX_KEY, "0xdeadbeef")]),
        2n,
      );

      const { rows } = await db.query<{ evidence: unknown }>("SELECT evidence FROM providers");
      expect(rows[0]?.evidence).toEqual({ raw: "0xdeadbeef" });
    });

    it("projects model registration and retirement (R5)", async () => {
      await reduceRange(
        db,
        stream([
          modelRegistered(1, "model-a"),
          modelRegistered(2, "model-b"),
          modelEnabledChanged(2, false),
        ]),
        3n,
      );

      const { rows } = await db.query<{
        model_id: bigint;
        name: string;
        enabled: boolean;
      }>("SELECT model_id, name, enabled FROM models ORDER BY model_id");
      expect(rows).toEqual([
        { model_id: 1n, name: "model-a", enabled: true },
        { model_id: 2n, name: "model-b", enabled: false },
      ]);
    });

    it("upserts an allowlist entry, keeping non-JSON bytes as a raw blob (R20)", async () => {
      await reduceRange(
        db,
        stream([
          allowlistEntrySet(ALLOWLIST_KEY, 1, stringToHex('{"image":"vorq-mock-cvm-image-v1"}')),
          allowlistEntrySet(ALLOWLIST_KEY, 2, "0xc0ffee"),
        ]),
        2n,
      );

      const { rows } = await db.query<{
        key: Buffer;
        status: number;
        entry: unknown;
      }>("SELECT key, status, entry FROM allowlist");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        key: bytes(ALLOWLIST_KEY),
        status: 2,
        entry: { raw: "0xc0ffee" },
      });
    });

    it("throws on a registry event for a provider that was never registered", async () => {
      await expect(reduceRange(db, stream([listedChanged(9, true)]), 1n)).rejects.toThrow(
        /ListedChanged/,
      );
      await expect(reduceRange(db, stream([modelEnabledChanged(9, true)]), 1n)).rejects.toThrow(
        /ModelEnabledChanged/,
      );
    });
  });

  describe("the ask book", () => {
    it("upserts published quotes and leaves untouched slots alone (R35)", async () => {
      await reduceRange(
        db,
        stream([
          asksPublished(4, 100n, [
            { modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: RATE_OUT },
            { modelId: 8, sla: 3600, rateIn: RATE_IN, rateOut: UINT128_RATE },
          ]),
          // A second snapshot naming only model 7: model 8's slot survives,
          // because AsksPublished is an upsert and not a replace.
          asksPublished(4, 200n, [{ modelId: 7, sla: 3600, rateIn: 5n, rateOut: 6n }]),
        ]),
        2n,
      );

      const { rows } = await db.query<{
        provider_id: bigint;
        model_id: bigint;
        sla: bigint;
        rate_in: bigint;
        rate_out: bigint;
      }>("SELECT * FROM asks_chain ORDER BY model_id");

      expect(rows).toEqual([
        { provider_id: 4n, model_id: 7n, sla: 3600n, rate_in: 5n, rate_out: 6n },
        {
          provider_id: 4n,
          model_id: 8n,
          sla: 3600n,
          rate_in: RATE_IN,
          rate_out: UINT128_RATE,
        },
      ]);
    });

    it("drops a slot published with both rates 0", async () => {
      await reduceRange(
        db,
        stream([
          asksPublished(4, 100n, [{ modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: RATE_OUT }]),
          asksPublished(4, 200n, [{ modelId: 7, sla: 3600, rateIn: 0n, rateOut: 0n }]),
        ]),
        2n,
      );

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM asks_chain");
      expect(rows[0]?.count).toBe(0n);
    });

    // The other half of the sentinel, and the one that costs money to get wrong. `AskRegistry`
    // keeps a slot whose `rateOut` is 0 but whose `rateIn` is not — an input-metered model, priced
    // on prompt tokens and settling at `completionTok == 0`. A projection that deleted it would
    // hide every embedding ask from the book while the chain kept clearing jobs against it.
    it("keeps an input-only slot, whose rate_out is 0 but rate_in is not", async () => {
      await reduceRange(
        db,
        stream([asksPublished(4, 100n, [{ modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: 0n }])]),
        1n,
      );

      const { rows } = await db.query<{ model_id: bigint; rate_in: bigint; rate_out: bigint }>(
        "SELECT model_id, rate_in, rate_out FROM asks_chain",
      );
      expect(rows).toEqual([
        { model_id: 7n, rate_in: RATE_IN, rate_out: 0n },
      ]);
    });

    it("withdraws an input-only slot when both legs go to 0", async () => {
      await reduceRange(
        db,
        stream([
          asksPublished(4, 100n, [{ modelId: 7, sla: 3600, rateIn: RATE_IN, rateOut: 0n }]),
          asksPublished(4, 200n, [{ modelId: 7, sla: 3600, rateIn: 0n, rateOut: 0n }]),
        ]),
        2n,
      );

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM asks_chain");
      expect(rows[0]?.count).toBe(0n);
    });

    it("withdrawing a slot that was never published is a no-op, not an orphan", async () => {
      await reduceRange(
        db,
        stream([asksPublished(4, 100n, [{ modelId: 7, sla: 3600, rateIn: 0n, rateOut: 0n }])]),
        1n,
      );

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM asks_chain");
      expect(rows[0]?.count).toBe(0n);
    });
  });

  describe("payloads Postgres will not store (R50)", () => {
    // The same permanent-wedge class as R48, reached through a different door.
    // `setIdentity` is signature-only, so any registered provider can put
    // arbitrary bytes in `evidence` — and `JSON.parse` accepting them says
    // nothing about whether `jsonb` will. Every assertion here checks the cursor
    // as well as the row, because a stalled cursor was the actual damage.
    for (const [what, text] of UNSTORABLE_JSON) {
      it(`stores ${what} as a raw blob and keeps indexing`, async () => {
        const evidence = stringToHex(text);

        await reduceRange(
          db,
          stream([providerRegistered(4), identityUpdated(4, BOX_KEY, evidence)]),
          2n,
        );

        const { rows } = await db.query<{ evidence: unknown }>("SELECT evidence FROM providers");
        expect(rows[0]?.evidence).toEqual({ raw: evidence });
        expect(await cursorBlock()).toBe(2n);
      });
    }

    it("keeps indexing across a run of unstorable payloads in one range", async () => {
      // The failure was never one bad row: it was a range that could not commit,
      // so the cursor stopped and never moved again.
      const emits = [providerRegistered(4)];
      for (const [, text] of UNSTORABLE_JSON) {
        emits.push(identityUpdated(4, BOX_KEY, stringToHex(text)));
      }
      emits.push(allowlistEntrySet(ALLOWLIST_KEY, 1, stringToHex(UNSTORABLE_JSON[0]![1])));

      const applied = await reduceRange(db, stream(emits), BigInt(emits.length));

      expect(applied).toBe(emits.length);
      expect(await cursorBlock()).toBe(BigInt(emits.length));
      // Both jsonb sites are screened, not just the identity one.
      const entry = await db.query<{ entry: unknown }>("SELECT entry FROM allowlist");
      expect(entry.rows[0]?.entry).toEqual({ raw: stringToHex(UNSTORABLE_JSON[0]![1]) });
    });

    it("stores nesting at the bound, and demotes one level past it", async () => {
      // The boundary itself, through a real log: at the bound the payload is
      // stored as itself, one level past it becomes a raw blob. Both land and
      // both leave the cursor advancing.
      const atBound = nested(MAX_JSONB_DEPTH);
      const overBound = nested(MAX_JSONB_DEPTH + 1);

      await reduceRange(
        db,
        stream([
          providerRegistered(4),
          identityUpdated(4, BOX_KEY, stringToHex(atBound)),
          providerRegistered(5),
          identityUpdated(5, BOX_KEY, stringToHex(overBound)),
        ]),
        4n,
      );

      const { rows } = await db.query<{
        provider_id: bigint;
        kind: string;
        text: string;
        raw: string | null;
      }>(
        `SELECT provider_id,
                jsonb_typeof(evidence) AS kind,
                evidence::text AS text,
                evidence->>'raw' AS raw
         FROM providers ORDER BY provider_id`,
      );

      // At the bound: stored as the array it is, byte for byte. Read back as
      // jsonb text rather than through the driver, which would recurse.
      expect(rows[0]?.kind).toBe("array");
      expect(rows[0]?.text).toBe(atBound);
      expect(rows[0]?.raw).toBeNull();

      // One level past: demoted to a blob, and the original bytes are still
      // recoverable from it.
      expect(rows[1]?.kind).toBe("object");
      expect(rows[1]?.raw).toBe(stringToHex(overBound));

      expect(await cursorBlock()).toBe(4n);
    });

    it("still stores a payload Postgres does accept, byte for byte", async () => {
      // The screen must not be a blanket refusal. A 20-digit integer is past a
      // double but well inside NUMERIC, and the point of keeping the original
      // text is that it survives exactly — so it is read back through SQL, not
      // through the driver's JSON parser, which would round it.
      const text = '{"kind":"cvm","n":12345678901234567890}';

      await reduceRange(
        db,
        stream([providerRegistered(4), identityUpdated(4, BOX_KEY, stringToHex(text))]),
        2n,
      );

      const { rows } = await db.query<{ n: string; kind: string }>(
        "SELECT evidence->>'n' AS n, evidence->>'kind' AS kind FROM providers",
      );
      expect(rows[0]).toEqual({ n: "12345678901234567890", kind: "cvm" });
      expect(await cursorBlock()).toBe(2n);
    });

    it("stores a model name carrying a NUL and keeps indexing", async () => {
      // A TEXT column, refused at the wire rather than by a type's input
      // function: `invalid byte sequence for encoding "UTF8": 0x00`. Curation
      // gates `registerModel`, so this is far harder to reach than the identity
      // path — but it wedges the node in exactly the same way.
      await reduceRange(db, stream([modelRegistered(1, `mod${NUL}el`)]), 1n);

      const { rows } = await db.query<{ name: string }>("SELECT name FROM models");
      expect(rows[0]?.name).toBe("mod\uFFFDel");
      expect(await cursorBlock()).toBe(1n);
    });
  });

  describe("chain uint32 widths (R48)", () => {
    it("applies the four uint32 positions no contract validates, and advances the cursor", async () => {
      // The regression this ruling exists for. `int4` stops at 2 147 483 647,
      // and each of these four carries a value the contracts deliberately do
      // not bound. Before the widening every one of them was a permanent denial
      // of service: the insert failed, `reduceRange` rolled the range back, and
      // the cursor never moved again — so the assertion that matters as much as
      // the rows is that the cursor advanced.
      const applied = await reduceRange(
        db,
        stream([
          // `post`, from any funded client. JobRegistry validates `modelId` and
          // `slaSecs` and says outright that `designated` is not validated.
          posted({ designated: MAX_UINT32 }),
          providerRegistered(4),
          // `requestCapacity(uint32 n)`, provider-signed: `issuedAt` is bounded,
          // `n` is not.
          capacityChanged(4, 1, MAX_UINT32),
          // `setAsks`, provider-signed: skips on quote count, skew, signature,
          // id mismatch and staleness, and bounds neither `modelId` nor `sla`.
          asksPublished(4, 100n, [
            { modelId: MAX_UINT32, sla: MAX_UINT32, rateIn: RATE_IN, rateOut: RATE_OUT },
          ]),
        ]),
        4n,
      );

      expect(applied).toBe(4);
      expect(await cursorBlock()).toBe(4n);

      const jobs = await db.query<{ designated: bigint }>("SELECT designated FROM jobs");
      expect(jobs.rows[0]?.designated).toBe(WIDE);

      const providers = await db.query<{ capacity_requested: bigint }>(
        "SELECT capacity_requested FROM providers",
      );
      expect(providers.rows[0]?.capacity_requested).toBe(WIDE);

      const asks = await db.query<{ model_id: bigint; sla: bigint }>(
        "SELECT model_id, sla FROM asks_chain",
      );
      expect(asks.rows).toEqual([{ model_id: WIDE, sla: WIDE }]);
    });

    it("applies a max uint32 through every widened column, gated or not", async () => {
      // The rule is uniform on purpose: widening only the four reachable columns
      // would tie the schema to which contract functions validate their inputs
      // today, so relaxing one modifier would quietly produce a fifth. These are
      // the curation-gated ones, exercised at the same width.
      await reduceRange(
        db,
        stream([
          modelRegistered(MAX_UINT32, "model-wide"),
          modelEnabledChanged(MAX_UINT32, false),
          providerRegistered(MAX_UINT32),
          capacityChanged(MAX_UINT32, MAX_UINT32, MAX_UINT32),
          reputationChanged(MAX_UINT32, MAX_UINT16),
          allowedModelsChanged(MAX_UINT32, false, [MAX_UINT32, 1]),
          posted({ modelId: MAX_UINT32, slaSecs: MAX_UINT32, designated: MAX_UINT32 }),
          claimed(JOB_A, MAX_UINT32),
          asksPublished(MAX_UINT32, 100n, [
            { modelId: MAX_UINT32, sla: MAX_UINT32, rateIn: RATE_IN, rateOut: RATE_OUT },
          ]),
        ]),
        9n,
      );

      expect(await cursorBlock()).toBe(9n);

      const job = await db.query<{
        model_id: bigint;
        sla_secs: bigint;
        designated: bigint;
        provider_id: bigint;
      }>("SELECT model_id, sla_secs, designated, provider_id FROM jobs");
      expect(job.rows[0]).toEqual({
        model_id: WIDE,
        sla_secs: WIDE,
        designated: WIDE,
        provider_id: WIDE,
      });

      const provider = await db.query<{
        provider_id: bigint;
        reputation: bigint;
        capacity_ceiling: bigint;
        capacity_requested: bigint;
        allowed_models: bigint[];
      }>(
        "SELECT provider_id, reputation, capacity_ceiling, capacity_requested, allowed_models FROM providers",
      );
      expect(provider.rows[0]).toEqual({
        provider_id: WIDE,
        reputation: BigInt(MAX_UINT16),
        capacity_ceiling: WIDE,
        capacity_requested: WIDE,
        // The element type is widened too, and reads back as bigint.
        allowed_models: [WIDE, 1n],
      });

      const model = await db.query<{ model_id: bigint; enabled: boolean }>(
        "SELECT model_id, enabled FROM models",
      );
      expect(model.rows[0]).toEqual({ model_id: WIDE, enabled: false });

      const ask = await db.query<{ provider_id: bigint; model_id: bigint; sla: bigint }>(
        "SELECT provider_id, model_id, sla FROM asks_chain",
      );
      expect(ask.rows[0]).toEqual({ provider_id: WIDE, model_id: WIDE, sla: WIDE });
    });

    it("withdraws a max uint32 ask slot, which is the same width on the delete path", async () => {
      await reduceRange(
        db,
        stream([
          asksPublished(MAX_UINT32, 100n, [
            { modelId: MAX_UINT32, sla: MAX_UINT32, rateIn: RATE_IN, rateOut: RATE_OUT },
          ]),
          asksPublished(MAX_UINT32, 200n, [
            { modelId: MAX_UINT32, sla: MAX_UINT32, rateIn: 0n, rateOut: 0n },
          ]),
        ]),
        2n,
      );

      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM asks_chain");
      expect(rows[0]?.count).toBe(0n);
      expect(await cursorBlock()).toBe(2n);
    });
  });

  describe("idempotence", () => {
    it("leaves every derived table byte-identical when the same range is applied twice", async () => {
      const range = stream([
        modelRegistered(1, "model-a"),
        modelRegistered(2, "model-b"),
        modelEnabledChanged(2, false),
        providerRegistered(4),
        listedChanged(4, true),
        capacityChanged(4, 12, 3),
        allowedModelsChanged(4, false, [1, 2]),
        identityUpdated(4, BOX_KEY, stringToHex('{"kind":"cvm"}')),
        allowlistEntrySet(ALLOWLIST_KEY, 1, "0xdeadbeef"),
        asksPublished(4, 100n, [
          { modelId: 1, sla: 3600, rateIn: RATE_IN, rateOut: RATE_OUT },
          { modelId: 2, sla: 3600, rateIn: RATE_IN, rateOut: RATE_OUT },
        ]),
        asksPublished(4, 200n, [{ modelId: 2, sla: 3600, rateIn: 0n, rateOut: 0n }]),
        posted({ jobId: JOB_A, c: word("c1") }),
        posted({ jobId: JOB_B, c: word("c2") }),
        posted({ jobId: JOB_C, c: word("c3") }),
        claimed(JOB_A, 4),
        settled(JOB_A, 1500),
        claimed(JOB_B, 4),
        ended(JOB_B, 3),
        ended(JOB_C, 2),
      ]);
      const toBlock = BigInt(range.length);

      await reduceRange(db, range, toBlock);
      const first = await dump();

      await reduceRange(db, range, toBlock);
      const second = await dump();

      expect(second).toEqual(first);
      // Guards the guard: an assertion over empty tables would pass trivially.
      for (const table of DERIVED) expect(first[table]?.length ?? 0).toBeGreaterThan(0);
      expect(first.jobs).toHaveLength(3);
      expect(first.asks_chain).toHaveLength(1);
    });

    it("does not roll a job's state back when Posted is re-applied", async () => {
      await reduceRange(db, stream([posted(), claimed(JOB_A, 3)]), 2n);
      await reduceRange(db, stream([posted()]), 2n);

      const { rows } = await db.query<{
        state: number;
        provider_id: bigint;
        as_of_block: bigint;
      }>("SELECT state, provider_id, as_of_block FROM jobs");
      // `as_of_block` climbs and never falls: the re-applied Posted sits at
      // block 1, and GREATEST keeps the Claimed's block 2.
      expect(rows[0]).toEqual({ state: 1, provider_id: 3n, as_of_block: 2n });
    });
  });

  describe("the cursor", () => {
    it("advances over a range with nothing in it", async () => {
      await reduceRange(db, [], 900n);
      expect(await cursorBlock()).toBe(900n);

      await reduceRange(db, [], 1000n);
      expect(await cursorBlock()).toBe(1000n);
    });

    it("stores the hash of the block it advanced to, with the number", async () => {
      // The pair is what the indexer's reorg guard compares, and it is written
      // in the same transaction as the rows: a number whose hash belonged to a
      // different block would make the guard assert against the wrong chain.
      await reduceRange(db, [], 900n);

      const { rows } = await db.query<{ block_number: bigint; block_hash: string }>(
        "SELECT block_number, block_hash FROM cursor WHERE id = 1",
      );
      expect(rows[0]).toEqual({ block_number: 900n, block_hash: blockHashOf(900n) });
    });

    it("leaves the cursor and every row unadvanced when an apply throws", async () => {
      await reduceRange(db, stream([posted({ jobId: JOB_A, c: word("c1") })], 1n), 10n);
      const before = await dump();

      // The crash: a good Posted followed by an orphan Claimed in the same range.
      await expect(
        reduceRange(
          db,
          stream([posted({ jobId: JOB_B, c: word("c2") }), claimed(JOB_C)], 11n),
          20n,
        ),
      ).rejects.toThrow(/Claimed/);

      expect(await dump()).toEqual(before);
      expect(await cursorBlock()).toBe(10n);
    });

    it("refuses logs that sit past the block the cursor would claim", async () => {
      await expect(reduceRange(db, stream([posted()], 42n), 41n)).rejects.toThrow(/toBlock/);
      expect(await cursorBlock()).toBeUndefined();
    });
  });

  describe("ordering", () => {
    it("applies interleaved logs from three contracts by (block, logIndex) (R31)", async () => {
      // One block, three contracts, and the Posted must land before the Claimed
      // that follows it two log-indexes later.
      await reduceRange(
        db,
        [
          logAt(providerRegistered(4), 7n, 0),
          logAt(posted(), 7n, 1),
          logAt(asksPublished(4, 100n, []), 7n, 2),
          logAt(claimed(JOB_A, 4), 7n, 3),
        ],
        7n,
      );

      const { rows } = await db.query<{ state: number; as_of_block: bigint }>(
        "SELECT state, as_of_block FROM jobs",
      );
      expect(rows[0]).toEqual({ state: 1, as_of_block: 7n });
    });

    it("refuses a stream that is not in (block, logIndex) order", async () => {
      const outOfBlockOrder = [logAt(posted(), 8n, 0), logAt(claimed(JOB_A), 7n, 0)];
      await expect(reduceRange(db, outOfBlockOrder, 9n)).rejects.toThrow(/order/i);

      const outOfIndexOrder = [logAt(posted(), 7n, 4), logAt(claimed(JOB_A), 7n, 1)];
      await expect(reduceRange(db, outOfIndexOrder, 9n)).rejects.toThrow(/order/i);
    });

    it("refuses two logs at the SAME (block, logIndex), which is the edge (R78)", async () => {
      // The **fail-open** edge of the same guard. `logIndex <= lastIndex` is the
      // assertion that R31's sort held; flipped to `<`, a log repeated at the
      // identical `(blockNumber, logIndex)` passes and is applied **twice** — a
      // `Claimed` counted two times, an `AsksPublished` upserted two times.
      // Every fixture above steps the index by one or goes backwards, so
      // equality — the shape a duplicated log actually has — was never fed in.
      const duplicated = [logAt(posted(), 7n, 3), logAt(claimed(JOB_A), 7n, 3)];

      await expect(reduceRange(db, duplicated, 9n)).rejects.toThrow(/order/i);

      // And nothing of the first one survived: the guard throws inside the
      // transaction, so the range is all-or-nothing.
      const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM jobs");
      expect(rows[0]?.count).toBe(0n);
    });

    it("refuses a pending log, which has no place in the projection", async () => {
      const pending = {
        ...logAt(posted(), 1n, 0),
        blockNumber: null,
        logIndex: null,
      };
      await expect(reduceRange(db, [pending], 1n)).rejects.toThrow(/pending/i);
    });
  });

  it("skips logs it does not project and still advances the cursor", async () => {
    const feesChanged = job(encodeLog(jobRegistryAbi, "FeesChanged", { feeBps: 250, gasFee: 1n }));

    const applied = await reduceRange(db, stream([feesChanged, posted()]), 2n);

    expect(applied).toBe(1);
    const { rows } = await db.query<{ count: bigint }>("SELECT count(*) FROM jobs");
    expect(rows[0]?.count).toBe(1n);
    expect(await cursorBlock()).toBe(2n);
  });
});
