import { afterAll, describe, expect, it } from "vitest";
import { formatUsd } from "../../src/money.js";
import { decodeEventLog, type Hex } from "viem";
import { askRegistryAbi } from "../../src/abi/askRegistry.js";
import { askSnapshotTypedData, type Snapshot } from "../../src/asks/push.js";
import {
  bearer,
  jsonBody,
  nowSeconds,
  openSession,
  providerAccount,
  startNode,
  waitFor,
  waitForHead,
  waitForReady,
  type RunningNode,
} from "./support/harness.js";

/**
 * Scenario 6 — **asks end-to-end**: a signed snapshot pushed to the node lands
 * on chain, the indexer mirrors it into `asks_chain`, and the book serves it.
 *
 * **R29 governs every assertion here: a successful `setAsks` transaction proves
 * nothing.** `setAsks` *skips* rather than reverts, per entry — for quote count,
 * clock skew, signature, id mismatch and staleness — so a `status: success`
 * receipt is entirely compatible with the chain having recorded nothing at all.
 * The proof is the **`AsksPublished` log** carrying this provider's id and this
 * snapshot's `signedAt`, and that is what this file reads. A test that asserted
 * the receipt would stay green through a door that had stopped publishing.
 *
 * The withdrawal half is R35: `AsksPublished` is an **upsert, not a replace**.
 * A publisher drops a slot by naming it with `rateOut == 0`, which the reducer
 * applies as a DELETE — so a snapshot that omits a slot must leave it standing,
 * and one that names it with a zero rate must remove it. Both directions are
 * asserted, because a reducer that replaced the provider's whole book would pass
 * the first and fail only the second.
 */

const SCHEMA = "vorq_devnet_asks";

/** Model 1 is the one the devnet deploy registers. Two SLAs the chain allows. */
const MODEL_ID = 1;
const SLA_KEEP = 3600;
const SLA_DROP = 86_400;

let node: RunningNode;

afterAll(async () => {
  await node?.stop();
});

/** The stored snapshot, all-strings, exactly as `pushOf` canonicalises it. */
const snapshotOf = (
  providerId: number,
  signedAt: bigint,
  quotes: { model_id: number; sla: number; rate_in: bigint; rate_out: bigint }[],
): Snapshot => ({
  provider_id: String(providerId),
  signed_at: String(signedAt),
  quotes: quotes.map((quote) => ({
    model_id: String(quote.model_id),
    sla: String(quote.sla),
    rate_in: String(quote.rate_in),
    rate_out: String(quote.rate_out),
  })),
});

/** The snapshot as `PUT /evm/asks` takes it: every member a JSON integer. */
const wireOf = (snapshot: Snapshot) => ({
  provider_id: Number(snapshot.provider_id),
  signed_at: Number(snapshot.signed_at),
  quotes: snapshot.quotes.map((quote) => ({
    model_id: Number(quote.model_id),
    sla: Number(quote.sla),
    rate_in: formatUsd(BigInt(quote.rate_in), 6),
    rate_out: formatUsd(BigInt(quote.rate_out), 6),
  })),
});

/**
 * The `AsksPublished` logs of one receipt, for this provider.
 *
 * **R35's other half.** `topic0` derives from the ABI-canonical, tuple-expanded
 * signature `AsksPublished(uint32,uint64,(uint32,uint32,uint128,uint128)[])`,
 * never from the human-readable `AsksPublished(uint32,uint64,Ask[])`. Decoding
 * through the vendored ABI is what keeps that right without restating it:
 * `decodeEventLog` derives the topic the same way the reducer does.
 */
async function publishedLogs(
  running: RunningNode,
  txHash: Hex,
  providerId: number,
): Promise<{ providerId: number; signedAt: bigint; quotes: readonly unknown[] }[]> {
  const receipt = await running.chain.publicClient.getTransactionReceipt({ hash: txHash });
  const found: { providerId: number; signedAt: bigint; quotes: readonly unknown[] }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== running.config.addresses.askRegistry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: askRegistryAbi,
        data: log.data,
        topics: log.topics,
      }) as { eventName: string; args: Record<string, unknown> };
      if (decoded.eventName !== "AsksPublished") continue;
      if (Number(decoded.args.providerId) !== providerId) continue;
      found.push({
        providerId: Number(decoded.args.providerId),
        signedAt: BigInt(decoded.args.signedAt as bigint),
        quotes: decoded.args.quotes as readonly unknown[],
      });
    } catch {
      // Not an AskRegistry event this ABI knows. Skipped rather than failed:
      // a receipt carries every contract's logs, not only the one under test.
    }
  }
  return found;
}

describe("asks end to end", () => {
  it("publishes a signed snapshot, mirrors the log, and serves the book", async () => {
    node = await startNode({ schema: SCHEMA });
    await waitForReady(node);

    const provider = providerAccount();
    const session = await openSession(node, provider, "provider");
    const { chainId, askRegistry } = node.config.addresses;

    // The floor is `max(stored, chain)` (R11), and the chain's is what survives a
    // wipe — so the snapshot is signed strictly ahead of the chain's own value.
    const chainFloor = (await node.chain.publicClient.readContract({
      address: askRegistry,
      abi: askRegistryAbi,
      functionName: "lastSignedAt",
      args: [1],
    })) as bigint;
    const signedAt = (chainFloor > nowSeconds() ? chainFloor : nowSeconds()) + 1n;

    const snapshot = snapshotOf(1, signedAt, [
      { model_id: MODEL_ID, sla: SLA_KEEP, rate_in: 30_000n, rate_out: 90_000n },
      { model_id: MODEL_ID, sla: SLA_DROP, rate_in: 25_000n, rate_out: 75_000n },
    ]);
    const signature = await provider.signTypedData(
      askSnapshotTypedData(snapshot, chainId, askRegistry) as never,
    );

    const pushed = await node.json<{
      provider_id: number;
      signed_at: number;
      published: boolean;
      tx_hash: Hex;
    }>(
      "/evm/asks",
      { ...jsonBody({ snapshot: wireOf(snapshot), signature }, bearer(session)), method: "PUT" },
    );
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.published).toBe(true);

    // ---- R29: the LOG, never the receipt ---------------------------------

    const logs = await publishedLogs(node, pushed.body.tx_hash, 1);
    expect(logs).toHaveLength(1);
    expect(logs[0].signedAt).toBe(signedAt);
    expect(logs[0].quotes).toHaveLength(2);

    // ---- the indexer mirrors it ------------------------------------------

    const receipt = await node.chain.publicClient.getTransactionReceipt({
      hash: pushed.body.tx_hash,
    });
    await waitForHead(node.chain.publicClient, receipt.blockNumber);

    await waitFor("asks_chain to mirror the published snapshot", async () => {
      const { rows } = await node.db.query<{ sla: bigint; rate_in: string; rate_out: string }>(
        "SELECT sla, rate_in, rate_out FROM asks_chain WHERE provider_id = 1 AND model_id = $1 ORDER BY sla",
        [MODEL_ID],
      );
      return rows.length === 2 ? rows : null;
    });

    // ---- and the book serves it ------------------------------------------

    const book = await node.json<{
      asks: { provider_id: string; model_id: string; sla: string; rate_in: string; rate_out: string }[];
      as_of_block: string;
    }>(`/evm/asks?model=${MODEL_ID}&limit=100`);
    expect(book.status).toBe(200);

    const mine = book.body.asks.filter((ask) => ask.provider_id === "1");
    expect(mine).toEqual([
      { provider_id: "1", model_id: "1", sla: String(SLA_KEEP), rate_in: "30000", rate_out: "90000" },
      { provider_id: "1", model_id: "1", sla: String(SLA_DROP), rate_in: "25000", rate_out: "75000" },
    ]);
    // Every index-backed response says how current it is.
    expect(BigInt(book.body.as_of_block)).toBeGreaterThanOrEqual(receipt.blockNumber);
  }, 300_000);

  it("is an upsert, not a replace: an omitted slot stands and rate_out=0 drops it (R35)", async () => {
    const provider = providerAccount();
    const session = await openSession(node, provider, "provider");
    const { chainId, askRegistry } = node.config.addresses;

    const chainFloor = (await node.chain.publicClient.readContract({
      address: askRegistry,
      abi: askRegistryAbi,
      functionName: "lastSignedAt",
      args: [1],
    })) as bigint;
    const signedAt = chainFloor + 1n;

    // Names only `SLA_DROP`, and names it with `rate_out = 0`. `SLA_KEEP` is
    // absent from this snapshot entirely — under a replace it would vanish, and
    // under the upsert the chain actually implements it must stand untouched.
    const snapshot = snapshotOf(1, signedAt, [
      { model_id: MODEL_ID, sla: SLA_DROP, rate_in: 0n, rate_out: 0n },
    ]);
    const signature = await provider.signTypedData(
      askSnapshotTypedData(snapshot, chainId, askRegistry) as never,
    );

    const pushed = await node.json<{ published: boolean; tx_hash: Hex }>("/evm/asks", {
      ...jsonBody({ snapshot: wireOf(snapshot), signature }, bearer(session)),
      method: "PUT",
    });
    expect(pushed.status).toBe(200);
    expect(await publishedLogs(node, pushed.body.tx_hash, 1)).toHaveLength(1);

    const receipt = await node.chain.publicClient.getTransactionReceipt({
      hash: pushed.body.tx_hash,
    });
    await waitForHead(node.chain.publicClient, receipt.blockNumber);

    const rows = await waitFor("the withdrawn slot to leave asks_chain", async () => {
      const { rows } = await node.db.query<{ sla: bigint }>(
        "SELECT sla FROM asks_chain WHERE provider_id = 1 AND model_id = $1 ORDER BY sla",
        [MODEL_ID],
      );
      return rows.length === 1 ? rows : null;
    });
    expect(rows[0].sla).toBe(BigInt(SLA_KEEP));

    const book = await node.json<{ asks: { sla: number }[] }>(
      `/evm/asks?model=${MODEL_ID}&limit=100`,
    );
    expect(book.body.asks.map((ask) => ask.sla)).toEqual([SLA_KEEP]);
  }, 300_000);
});
