import type { FastifyRequest } from "fastify";
import { NO_CID_MINTED, OVERSIZED_CID, StoreRejected } from "../pin/pinner.js";
import { ApiError } from "./errors.js";

/**
 * How a failure of the pinning service is answered, in one place because both
 * write doors now pin (R70's shape, R72's rule).
 *
 * Pinning happens inside `POST /v1/jobs` and inside the `settle` branch of
 * `POST /evm/ops`, so two doors need this classification and it lives below both
 * of them as one definition rather than a shape each re-derives — which is how
 * three other doors came to be missing `viewRead`.
 */

/**
 * The store answered and said no, in a way no amount of waiting will change:
 * wrong credentials, a bucket that is not there, a host clock outside the
 * fifteen-minute window, a bucket in another region. Every one is an operator's
 * misconfiguration, and every one of them would otherwise be reported as
 * `retryable: true` with no way to tell it from a store that was merely down —
 * so a fleet of clients retries a permanently broken node forever and nothing
 * above `debug` says why.
 *
 * `NO_CID_MINTED` and `OVERSIZED_CID` are the same thing said differently: a
 * `2xx` put that came back with no name in it, or with a name too long to put on
 * chain. The store answered, so it is not unavailable — it is a bucket or gateway
 * configured wrongly, and it will answer identically until a human changes that.
 */
const OPERATOR_MUST_ACT = new Set([
  "SignatureDoesNotMatch",
  "InvalidAccessKeyId",
  "AccessDenied",
  "NoSuchBucket",
  "RequestTimeTooSkewed",
  "redirect",
  NO_CID_MINTED,
  OVERSIZED_CID,
]);

/**
 * Turns a failure of the pinning service into a **retryable** answer.
 *
 * Nothing the caller sent is wrong when the object store is down, and the default
 * rendering — `500 internal`, which is `retryable: false` — would tell a client
 * its payload can never be filed and it should stop trying. `503
 * pinner_unavailable` is the truth: the same bytes, unchanged, will file
 * perfectly well once the dependency is back, and re-filing them is free of
 * consequence because the object key is their content hash. An `ApiError` passes
 * through untouched, so a refusal decided above is not relabelled.
 *
 * The `code` discriminates **whose** problem it is, which the status deliberately
 * does not: `store_rejected` means the store answered and refused — a `403` or a
 * `404` that a retry cannot fix, however patient — and `store_unavailable` means
 * nothing answered. The status stays `503` and stays retryable in both cases
 * because the sentence "your bytes are fine" is true in both; what changes is
 * that an operator reading `store_rejected` at `fatal`, with the store's own
 * error code, is told which of their four settings is wrong.
 */
export async function throughPinner<T>(
  request: FastifyRequest,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const rejected = error instanceof StoreRejected ? error : null;
    // Logged in full here because the envelope deliberately carries none of it:
    // an object store's message can name a bucket, an endpoint or a key id, and
    // the caller is owed the fact that it failed, not the reason.
    const log = { err: error, storeStatus: rejected?.status, storeCode: rejected?.storeCode };
    if (rejected !== null && OPERATOR_MUST_ACT.has(rejected.storeCode)) {
      // `fatal`, not `error`: nothing this node does next can clear it, and it
      // will be answered identically for every caller until a human changes a
      // `PIN_S3_*` value or the host's clock.
      request.log.fatal(log, "pinning service refused: the node is misconfigured");
    } else {
      request.log.error(log, "pinning service failure");
    }

    throw new ApiError(
      503,
      "pinner_unavailable",
      "The pinning service could not be reached.",
      null,
      rejected !== null ? "store_rejected" : "store_unavailable",
    );
  }
}
