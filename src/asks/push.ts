import { Type, type Static } from "typebox";
import { badRequest } from "../api/errors.js";
import { usdParam } from "../api/usd.js";
import { integer, object, UINT32_MAX, UINT64_MAX } from "../api/params.js";
import { SafeUint, Sig65, Uint32, Usd } from "../api/schemas/common.js";
import type { Address } from "../config.js";
import { EIP712_NAMES, UINT128_MAX } from "../orders.js";

/**
 * The ask push: what a provider signs, how it is validated, and the exact bytes
 * that go into `quotes_live`.
 *
 * **A push is the signed snapshot.** The provider signs an EIP-712 `AskSnapshot`
 * over the AskRegistry's own domain, and this node's only jobs are to check that
 * the signature belongs to the provider it names, that the chain will not skip
 * it, and to keep the exact values so the publisher can encode them back into
 * `setAsks` calldata. The node never re-prices, never merges and never re-signs:
 * it has no key that could.
 *
 * Everything here is derived from `vorq-evm-contracts/src/AskRegistry.sol`
 * (R32) — the type strings, the domain, `MAX_QUOTES`, the skew ceiling and the
 * monotonic rule are the contract's, restated so the node refuses in advance
 * what the chain would silently **skip**. `setAsks` skips rather than reverts,
 * so every check below exists to make an accepted push one the chain will
 * actually land (R29).
 */

/**
 * `AskRegistry.MAX_QUOTES`. The contract skips an entry with **more** than this;
 * 64 exactly is fine (R19).
 */
export const MAX_QUOTES = 64;

/**
 * `AskRegistry`'s clock-skew ceiling: `signedAt > block.timestamp + 3600` is
 * skipped on chain.
 *
 * Mirrored here, and it is not cosmetic. A snapshot the chain skips for skew but
 * this node recorded as pushed would sit at the top of the node's monotonic
 * floor forever while the chain's `lastSignedAt` stayed behind it — every later
 * honest push refused as stale, and the provider's book frozen with no way back
 * short of a database edit. The bound is what makes "accepted here" imply "the
 * chain will take it".
 */
export const SKEW_SECONDS = 3600n;

export { UINT128_MAX };

/**
 * One quote, exactly the contract's `Ask` — and, as stored, every value a
 * **decimal string**.
 *
 * The wire carries USD strings and the row the atomic rates they convert to,
 * as decimal strings; `BigInt(string)` is the one conversion back. The publisher encodes calldata from these same
 * values and never from a re-quote (R54).
 *
 * That the *stored* form is strings is what makes R51 unreachable here. A
 * `jsonb` value carrying a JSON **number** is stored exactly as `NUMERIC` and
 * then rounded on the way back through the driver — `12345678901234567890`
 * reads back as `…67000` — so a snapshot stored with numeric members would come
 * back to the publisher subtly wrong, and the calldata would no longer match the
 * signature that authorised it. Strings cross that boundary unchanged.
 */
export interface Quote {
  model_id: string;
  sla: string;
  rate_in: string;
  rate_out: string;
}

/** The snapshot as it is stored and as it is signed. */
export interface Snapshot {
  provider_id: string;
  signed_at: string;
  quotes: Quote[];
}

/** A validated push: the snapshot, its signature, and the text that is stored. */
export interface Push {
  snapshot: Snapshot;
  /** Exactly 65 bytes — `AskRegistry._recover` refuses any other length. */
  signature: Buffer;
  providerId: bigint;
  signedAt: bigint;
  /** The canonical JSON text written to `quotes_live.snapshot`. */
  snapshotText: string;
}

/** The EIP-712 types, spelled as `SNAPSHOT_TYPEHASH` spells them. */
export const ASK_SNAPSHOT_TYPES = {
  AskSnapshot: [
    { name: "providerId", type: "uint32" },
    { name: "signedAt", type: "uint64" },
    { name: "quotes", type: "Ask[]" },
  ],
  Ask: [
    { name: "modelId", type: "uint32" },
    { name: "sla", type: "uint32" },
    { name: "rateIn", type: "uint128" },
    { name: "rateOut", type: "uint128" },
  ],
} as const;

/** The AskRegistry's own v2 domain. Never the session domain, never JobRegistry's. */
export interface AskDomain {
  name: typeof EIP712_NAMES.ask;
  version: "2";
  chainId: number;
  verifyingContract: Address;
}

/**
 * Version `2` over **the AskRegistry**, because that is the contract that
 * verifies this signature (`DOMAIN_SEPARATOR` is computed in its own
 * constructor over `address(this)`).
 *
 * Naming the JobRegistry here would recover a different address from the same
 * bytes and refuse every honest push with a `403` — and naming the session
 * domain (`VORQ Session`/`1`/chainId 1, no verifying contract) would make a captured
 * login replayable as an ask push. The domain separation is the whole of that
 * defence.
 */
export function askDomain(chainId: number, askRegistry: Address): AskDomain {
  return { name: EIP712_NAMES.ask, version: "2", chainId, verifyingContract: askRegistry };
}

/** The typed data a provider signs, built from the stored decimal strings. */
export interface AskSnapshotTypedData {
  domain: AskDomain;
  types: typeof ASK_SNAPSHOT_TYPES;
  primaryType: "AskSnapshot";
  message: {
    /**
     * `uint32` members cross as **numbers** and `uint64`/`uint128` as `bigint`,
     * because that is the split viem's typed-data encoder declares — and it is
     * the safe split: a `uint32` is exactly representable as a double, a
     * `uint64` is not. `Number()` is applied here, at the one boundary, to a
     * value already bounded to `uint32` by {@link parsePush} (R49a).
     */
    providerId: number;
    signedAt: bigint;
    quotes: { modelId: number; sla: number; rateIn: bigint; rateOut: bigint }[];
  };
}

export function askSnapshotTypedData(
  snapshot: Snapshot,
  chainId: number,
  askRegistry: Address,
): AskSnapshotTypedData {
  return {
    domain: askDomain(chainId, askRegistry),
    types: ASK_SNAPSHOT_TYPES,
    primaryType: "AskSnapshot",
    message: {
      // The one conversion out of the decimal strings, and exact at every width
      // the contract declares: `uint32` to a double, everything wider to
      // `bigint`.
      providerId: Number(snapshot.provider_id),
      signedAt: BigInt(snapshot.signed_at),
      quotes: snapshot.quotes.map((quote) => ({
        modelId: Number(quote.model_id),
        sla: Number(quote.sla),
        rateIn: BigInt(quote.rate_in),
        rateOut: BigInt(quote.rate_out),
      })),
    },
  };
}

/**
 * The `PUT /evm/asks` body, bounded before any chain access: an oversized,
 * malformed or absurd push costs one JSON parse and nothing else. Each field is
 * bounded at the width the contract declares for it, which is also the width
 * `quotes_live` and `asks_chain` are declared at (R48) — a `model_id` past
 * `uint32` would be an insert the reducer could never make.
 *
 * `provider_id` starts at 1: `ProviderRegistry.idOf` answers 0 for an address it
 * does not know, and `setAsks` refuses id 0 outright. A zero on either rate is
 * not a malformed quote: both legs zero is how a publisher **withdraws** a slot
 * (R35), and `rate_out` alone at zero is an input-metered model quoting the only
 * side it has.
 */
export const PushBody = Type.Object({
  snapshot: Type.Object({
    provider_id: Uint32({ minimum: 1 }),
    signed_at: SafeUint({ description: "Unix seconds; must exceed the provider's last." }),
    quotes: Type.Array(
      Type.Object({
        model_id: Uint32(),
        sla: Uint32({ description: "The window, in seconds." }),
        rate_in: Usd({ description: "USD per 1M input units." }),
        rate_out: Usd({ description: "USD per 1M output units." }),
      }),
      {
        // R19: the chain skips a snapshot with more than `MAX_QUOTES`, so
        // relaying one would pay gas for a snapshot that is silently dropped.
        maxItems: MAX_QUOTES,
        "x-vorq-error": { message: `must hold at most ${MAX_QUOTES} quotes` },
      },
    ),
  }),
  signature: Sig65({
    description: "EIP-712 `AskSnapshot` over the AskRegistry's own v2 domain.",
  }),
});

/**
 * A stored `snapshot.quotes` as an array, bounded by {@link MAX_QUOTES} — the
 * boot sweep's copy of the bound {@link PushBody} puts on the push path. Both
 * read the one constant, and `edges.test.ts` defends each at its edge.
 */
function quotesArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw badRequest("snapshot.quotes must be an array of quotes", "snapshot.quotes");
  }
  if (value.length > MAX_QUOTES) {
    throw badRequest(
      `snapshot.quotes must hold at most ${MAX_QUOTES} quotes, got ${value.length}`,
      "snapshot.quotes",
    );
  }
  return value;
}

/**
 * A validated `PUT /evm/asks` body, as the push the door works with: the USD
 * rates become the atomic rates the snapshot signature covers.
 */
export function pushOf(body: Static<typeof PushBody>, decimals: number): Push {
  const snapshot: Snapshot = {
    provider_id: String(body.snapshot.provider_id),
    signed_at: String(body.snapshot.signed_at),
    quotes: body.snapshot.quotes.map((quote, index) => {
      const at = `snapshot.quotes[${index}]`;
      return {
        model_id: String(quote.model_id),
        sla: String(quote.sla),
        rate_in: usdParam(quote.rate_in, decimals, `${at}.rate_in`, true).toString(),
        rate_out: usdParam(quote.rate_out, decimals, `${at}.rate_out`, true).toString(),
      };
    }),
  };

  return {
    snapshot,
    signature: Buffer.from(body.signature.slice(2), "hex"),
    providerId: BigInt(body.snapshot.provider_id),
    signedAt: BigInt(body.snapshot.signed_at),
    // Canonical, not the caller's bytes. The signature authorises the EIP-712
    // **values**, not any particular JSON spelling of them, so normalising every
    // member to a decimal string loses nothing that was signed and gains the one
    // property the publisher needs: reading this text back can round nothing.
    snapshotText: JSON.stringify(snapshot),
  };
}

/**
 * Reads a `quotes_live.snapshot` back, refusing anything that is not the
 * canonical all-strings form this module writes.
 *
 * Checked rather than trusted because the publisher turns it into calldata the
 * relayer pays for: a row that is not what this node wrote is one whose
 * signature cannot match, and skipping it at boot is strictly better than
 * broadcasting it.
 */
export function parseStoredSnapshot(json: string): Snapshot {
  const value: unknown = JSON.parse(json);
  const root = object(value, "snapshot");
  const providerId = integer(root.provider_id, "snapshot.provider_id", 1n, UINT32_MAX);
  const signedAt = integer(root.signed_at, "snapshot.signed_at", 0n, UINT64_MAX);
  const quotes = quotesArray(root.quotes);
  return {
    provider_id: providerId.toString(),
    signed_at: signedAt.toString(),
    quotes: quotes.map((entry, index) => {
      const at = `snapshot.quotes[${index}]`;
      const quote = object(entry, at);
      return {
        model_id: integer(quote.model_id, `${at}.model_id`, 0n, UINT32_MAX).toString(),
        sla: integer(quote.sla, `${at}.sla`, 0n, UINT32_MAX).toString(),
        rate_in: integer(quote.rate_in, `${at}.rate_in`, 0n, UINT128_MAX).toString(),
        rate_out: integer(quote.rate_out, `${at}.rate_out`, 0n, UINT128_MAX).toString(),
      };
    }),
  };
}
