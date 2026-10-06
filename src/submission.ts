import { Type, type Static } from "typebox";
import { getAddress, verifyTypedData, type Hex } from "viem";
import type { Address } from "./config.js";
import { jobIdOf, type Terms } from "./orders.js";
import { ApiError, badRequest } from "./api/errors.js";
import { usdParam } from "./api/usd.js";
import {
  Address as AddressIn,
  Base64,
  Cid,
  Hex32,
  SafeUint,
  Sig65,
  Uint32,
  Usd,
} from "./api/schemas/common.js";

/**
 * A **submission** — one signed order, its sealed content and its payment.
 *
 * This is the JSON body `POST /v1/jobs` takes, and **one line of a batch input
 * file is exactly that body**: the same flat order fields, the same
 * `container` / `container_cid` pair, the same payment. They are the
 * same shape on purpose — a batch line is a single-job submission that happens
 * to arrive 50 000 at a time — so the parse and the two signature recoveries
 * live here, once, rather than once per door.
 *
 * What is deliberately *not* here is the flow. The single-job door interleaves a
 * `402` challenge between these checks and the batch worker interleaves nothing;
 * each owns its own order of operations, its own answers, and its own decision
 * about which refusals are fatal. What they must not own separately is what an
 * order *is* — the member widths, the `job_id` derivation, and which signature
 * has to recover to whom.
 */

/**
 * A submission, as `POST /v1/jobs` takes it and as one batch-file line carries
 * it.
 *
 * **Flat.** Every member is its own field — `c`, `owner`, `job_id`, the nine
 * chain members, `signature` — with no envelope around them, so one schema reads
 * the door's body and a batch line alike. Every integer member is a JSON
 * integer bounded at the width the chain gives it, or at 2^53 − 1 where that
 * width is wider. `designated` is the deliberately unvalidated one on chain —
 * 0 means "any provider" — so it is bounded to `uint32` and nothing more.
 *
 * The container and the payment are optional here because the challenge carries
 * neither; which combinations a door accepts is the door's decision.
 */
export const Submission = Type.Object(
  {
    c: Hex32({ description: "keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))." }),
    owner: AddressIn({ description: "The payer, who signs the order and the payment." }),
    job_id: Hex32({ description: "keccak256(owner ‖ c), restated so a mismatch is refused here." }),
    model_id: Uint32(),
    sla_secs: Uint32({ description: "The window, in seconds." }),
    rate_in: Usd({ description: "USD per 1M input units." }),
    rate_out: Usd({ description: "USD per 1M output units." }),
    units_in: Uint32(),
    units_out: Uint32(),
    designated: Uint32({ description: "A provider id, or 0 for an open order." }),
    expires_at: SafeUint({ description: "Unix seconds, in (now, now + 86400]." }),
    signature: Sig65({ description: "EIP-712 `Order` over the JobRegistry's v2 domain." }),
    // No decoded cap: the door's `bodyLimit` is the whole bound, and a second cap
    // would refuse a payload the door had already read and parsed.
    container: Type.Optional(Base64(undefined, { description: "The sealed container, base64." })),
    container_cid: Type.Optional(
      Cid({ description: "A `POST /v1/files` upload with `purpose=input`, by this owner." }),
    ),
    auth_sig: Type.Optional(
      Sig65({ description: "EIP-3009 `ReceiveWithAuthorization` over the quoted payment." }),
    ),
    amount: Type.Optional(
      Usd({
        description:
          "The quoted amount in USD, echoed: the payment is stateless, so this is what tells a stale " +
          "quote from a forged authorization.",
      }),
    ),
  },
  { dependentRequired: { auth_sig: ["amount"] } },
);
export type Submission = Static<typeof Submission>;

/** A parsed order: the nine chain members, its owner, its derived id and its signature. */
export interface ParsedOrder {
  terms: Terms;
  owner: Address;
  jobId: Hex;
  signature: Hex;
}

/**
 * A validated submission's order, in the contract's own names and widths: the
 * USD rates become the atomic rates the signature covers.
 */
export function parseOrder(body: Submission, decimals: number): ParsedOrder {
  // Checksummed, exactly as `addressOf` does it on the routes: the same 20 bytes
  // must render as the same string wherever they are compared or logged.
  const owner = getAddress(body.owner) as Address;

  const terms: Terms = {
    c: body.c.toLowerCase() as Hex,
    modelId: BigInt(body.model_id),
    slaSecs: BigInt(body.sla_secs),
    rateIn: usdParam(body.rate_in, decimals, "rate_in", true),
    rateOut: usdParam(body.rate_out, decimals, "rate_out", true),
    unitsIn: BigInt(body.units_in),
    unitsOut: BigInt(body.units_out),
    designated: BigInt(body.designated),
    expiresAt: BigInt(body.expires_at),
  };

  // `job_id` is derived, not trusted: the client sends it so the two sides can
  // disagree loudly here rather than silently on chain, where the id the
  // contract computes is the only one that exists.
  const jobId = jobIdOf(owner, terms.c);
  if (jobId !== body.job_id.toLowerCase()) {
    throw badRequest("job_id is not keccak256(owner ‖ c)", "job_id");
  }

  return { terms, owner, jobId, signature: body.signature as Hex };
}

/**
 * The payment half of a submission: the authorization signature and the echoed
 * amount. **Echoed, not remembered** (R7): the 402 is stateless, so without it
 * there is nothing at relay time to tell an honest client whose quote went
 * stale from a forged authorization.
 */
export function parsePayment(body: Submission, decimals: number): { authSig: Hex; amount: bigint } {
  return { authSig: body.auth_sig as Hex, amount: usdParam(body.amount as string, decimals, "amount") };
}

/** Whether a submission carries its payment: `auth_sig` is present. */
export const hasPayment = (body: Submission): boolean => body.auth_sig !== undefined;

/**
 * How a submission carries its sealed container: the bytes, or the name of an
 * upload that already holds them.
 */
export type Content = { kind: "inline"; bytes: Buffer } | { kind: "cid"; cid: string };

/**
 * The container a body carries — inline or by reference — or `null` when it
 * carries neither.
 *
 * Exactly one of the two, and `container_ambiguous` for both: a body naming two
 * containers does not say which one `c` commits to, and picking either would be
 * this node choosing which bytes a client meant to pay for.
 *
 * **No decoded cap on `container`.** The route's `bodyLimit` is the whole bound,
 * and a second cap here would refuse a payload the door has already read and
 * parsed — spending the allocation the cap existed to prevent and then
 * answering `400` for it. A client over the inline size uploads first and sends
 * `container_cid`.
 */
export function parseContent(body: Submission): Content | null {
  if (body.container !== undefined && body.container_cid !== undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "send exactly one of container and container_cid: two containers do not say which one c " +
        "commits to",
      "container",
      "container_ambiguous",
    );
  }
  if (body.container !== undefined) return { kind: "inline", bytes: Buffer.from(body.container, "base64") };
  if (body.container_cid !== undefined) return { kind: "cid", cid: body.container_cid };
  return null;
}

/** Does `signature` recover to `address` over this typed data? Never throws. */
export async function recovers(
  typedData: { domain: unknown; types: unknown; primaryType: string; message: unknown },
  address: Address,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      ...typedData,
      address,
      signature,
    } as unknown as Parameters<typeof verifyTypedData>[0]);
  } catch {
    // A malformed signature is a `false`, not a 500: `verifyTypedData` throws
    // for some malformed inputs and answers `false` for others, and the caller
    // cannot be made to care which.
    return false;
  }
}

/** Re-exported so a door can name the type it throws without importing two modules. */
export { ApiError };
