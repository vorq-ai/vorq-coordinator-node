import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { jobRegistryAbi } from "../src/abi/jobRegistry.js";
import type { Db } from "../src/db/db.js";
import { payoutTick, startPayoutKeeper } from "../src/keepers/payouts.js";
import { refusedBroadcast, stubChain, testConfig, type Simulate } from "./support/stub-chain.js";

/**
 * The payout keeper: `payProvider(id)` for each provider with earnings, then
 * `payRelayer(<this node's relayer>)`, then `payTreasury()`.
 *
 * Settlement only credits balances inside the registry, so nothing reaches a
 * provider, a relayer or the treasury until somebody calls these. Driven against a canned
 * endpoint and a stub store holding only the provider list, so every assertion
 * is about what the keeper read and what it relayed.
 */

const config = testConfig();
const OPERATOR = `0x${"0a".repeat(20)}` as Hex;
const TREASURY = `0x${"0f".repeat(20)}` as Hex;

/** The stub store: the provider list, and nothing else. */
function providersDb(ids: number[]): Db {
  const query = (async (text: string) => {
    if (text.includes("FROM providers")) return { rows: ids.map((id) => ({ provider_id: BigInt(id) })) };
    throw new Error(`stubDb: unexpected query ${text}`);
  }) as unknown as Db["query"];
  return {
    query,
    tx: (fn) => fn({ query }),
    migrate: () => Promise.reject(new Error("no migration expected")),
    close: async () => undefined,
  };
}

const log = (topics: Hex[], data: Hex) => ({
  address: config.addresses.jobRegistry,
  topics,
  data,
  blockNumber: "0x3e8",
  blockHash: `0x${"ab".repeat(32)}`,
  transactionHash: `0x${"cd".repeat(32)}`,
  transactionIndex: "0x0",
  logIndex: "0x0",
  removed: false,
});

const providerPaid = (providerId: number, amount: bigint) =>
  log(
    encodeEventTopics({ abi: jobRegistryAbi, eventName: "ProviderPaid", args: { providerId, to: OPERATOR } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }], [amount]),
  );

const relayerPaid = (relayer: Hex, amount: bigint) =>
  log(
    encodeEventTopics({ abi: jobRegistryAbi, eventName: "RelayerPaid", args: { relayer } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }], [amount]),
  );

const treasuryPaid = (amount: bigint) =>
  log(
    encodeEventTopics({ abi: jobRegistryAbi, eventName: "TreasuryPaid", args: { to: TREASURY } }) as Hex[],
    encodeAbiParameters([{ type: "uint128" }], [amount]),
  );

function build(options: {
  earned: Record<number, bigint>;
  accrued: bigint;
  /** `relayerEarned`, by lowercase address; every other address has earned nothing. */
  relayerEarned?: Record<string, bigint>;
  simulate?: () => Simulate;
  sendError?: () => unknown;
}) {
  // Each receipt carries the event of the payout it answers, so the keeper's
  // "the event is the proof" rule has something true to read.
  const pending: unknown[][] = [];
  const stub = stubChain(config, {
    views: {
      earned: (args: readonly unknown[]) => options.earned[Number(args[0])] ?? 0n,
      accrued: options.accrued,
      relayerEarned: (args: readonly unknown[]) =>
        options.relayerEarned?.[String(args[0]).toLowerCase()] ?? 0n,
    },
    simulate: options.simulate,
    sendError: options.sendError,
    receiptLogs: () => pending.shift() ?? [],
  });
  return { stub, pending };
}

const decoded = (data: Hex) => decodeFunctionData({ abi: jobRegistryAbi, data });

describe("the payout keeper", () => {
  it("pays every provider with earnings, skips the ones with none, then pays the treasury", async () => {
    const { stub, pending } = build({ earned: { 1: 500n, 2: 0n, 3: 700n }, accrued: 90n });
    pending.push([providerPaid(1, 500n)], [providerPaid(3, 700n)], [treasuryPaid(90n)]);
    const errors: unknown[] = [];

    const run = await payoutTick(
      { db: providersDb([1, 2, 3]), chain: stub.chain, config },
      (error) => errors.push(error),
    );

    expect(errors).toEqual([]);
    expect(run).toEqual({ candidates: 2, providersPaid: 2, relayerPaid: false, treasuryPaid: true });
    expect(stub.relayed.map((data) => [decoded(data).functionName, decoded(data).args ?? []])).toEqual([
      ["payProvider", [1]],
      ["payProvider", [3]],
      ["payTreasury", []],
    ]);
    // Every payout was simulated from the relayer before it was sent.
    expect(stub.simulated).toHaveLength(3);
    for (const from of stub.simulatedFrom) {
      expect(from?.toLowerCase()).toBe(stub.chain.account.address.toLowerCase());
    }
  });

  it("pays this node's relayer what it has earned, read and paid at its own address", async () => {
    const { stub: probe } = build({ earned: {}, accrued: 0n });
    const relayer = probe.chain.account.address;
    const { stub, pending } = build({
      earned: { 1: 500n },
      accrued: 90n,
      relayerEarned: { [relayer.toLowerCase()]: 7n, [OPERATOR.toLowerCase()]: 99n },
    });
    pending.push([providerPaid(1, 500n)], [relayerPaid(relayer, 7n)], [treasuryPaid(90n)]);
    const errors: unknown[] = [];

    const run = await payoutTick({ db: providersDb([1]), chain: stub.chain, config }, (error) =>
      errors.push(error),
    );

    expect(errors).toEqual([]);
    expect(run).toEqual({ candidates: 1, providersPaid: 1, relayerPaid: true, treasuryPaid: true });
    expect(stub.relayed.map((data) => [decoded(data).functionName, decoded(data).args ?? []])).toEqual([
      ["payProvider", [1]],
      ["payRelayer", [relayer]],
      ["payTreasury", []],
    ]);
  });

  it("relays nothing when nobody has earned anything and nothing has accrued", async () => {
    const { stub } = build({ earned: {}, accrued: 0n });
    const run = await payoutTick({ db: providersDb([1, 2]), chain: stub.chain, config }, () => undefined);
    expect(run).toEqual({ candidates: 0, providersPaid: 0, relayerPaid: false, treasuryPaid: false });
    expect(stub.simulated).toHaveLength(0);
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("skips a payout the simulate refuses — paid out by somebody else since the read", async () => {
    const { stub } = build({
      earned: { 1: 500n },
      accrued: 0n,
      simulate: () => ({ kind: "revert", errorName: "NothingToPay" }),
    });
    const run = await payoutTick({ db: providersDb([1]), chain: stub.chain, config }, () => undefined);
    expect(run).toEqual({ candidates: 1, providersPaid: 0, relayerPaid: false, treasuryPaid: false });
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("reports a simulate refusal other than NothingToPay, and relays nothing", async () => {
    // Only `NothingToPay` means drained. Any other refusal is a payout that
    // cannot be made, and a pass that read it as drained would hide it.
    const { stub } = build({
      earned: { 1: 500n },
      accrued: 90n,
      simulate: () => ({ kind: "opaque", data: "0xdeadbeef" }),
    });
    const errors: string[] = [];
    const run = await payoutTick({ db: providersDb([1]), chain: stub.chain, config }, (_e, payee) =>
      errors.push(payee),
    );
    expect(errors).toEqual(["provider 1", "treasury"]);
    expect(run).toEqual({ candidates: 1, providersPaid: 0, relayerPaid: false, treasuryPaid: false });
    expect(stub.broadcasts).toHaveLength(0);
  });

  it("does not count a mined transaction with no payout event as a payout (R29)", async () => {
    const { stub } = build({ earned: { 1: 500n }, accrued: 0n });
    const run = await payoutTick({ db: providersDb([1]), chain: stub.chain, config }, () => undefined);
    expect(stub.broadcasts).toHaveLength(1);
    expect(run?.providersPaid).toBe(0);
  });

  it("reports one provider's failed payout and carries on to the next and to the treasury", async () => {
    let sends = 0;
    const { stub, pending } = build({
      earned: { 1: 500n, 2: 600n },
      accrued: 90n,
      sendError: () => ((sends += 1) === 1 ? refusedBroadcast() : undefined),
    });
    pending.push([providerPaid(2, 600n)], [treasuryPaid(90n)]);
    const errors: string[] = [];

    const run = await payoutTick({ db: providersDb([1, 2]), chain: stub.chain, config }, (_e, payee) =>
      errors.push(payee),
    );

    expect(errors).toEqual(["provider 1"]);
    expect(run).toEqual({ candidates: 2, providersPaid: 1, relayerPaid: false, treasuryPaid: true });
  });

  it("does nothing on a node with no chain", async () => {
    expect(await payoutTick({ db: providersDb([1]), chain: null, config }, () => undefined)).toBeNull();
  });

  it("runs one pass at a time on its timer", async () => {
    const { stub, pending } = build({ earned: { 1: 500n }, accrued: 0n });
    pending.push([providerPaid(1, 500n)]);
    const keeper = startPayoutKeeper(
      { db: providersDb([1]), chain: stub.chain, config },
      () => undefined,
      config.payoutIntervalMs,
    );
    try {
      const [first, second] = await Promise.all([keeper.tick(), keeper.tick()]);
      expect(first?.providersPaid).toBe(1);
      expect(second).toBeNull();
    } finally {
      keeper.stop();
    }
  });
});
