import type { FastifyReply } from "fastify";

/**
 * The failure vocabulary, in one place because every route shares it.
 *
 * The emulator's envelope is preserved: `{error:{message,type,param,code}}`.
 * Retryability is a **header**, never a body field — a client decides whether to
 * retry from `x-vorq-retryable` (R57), and putting it in the body would make it
 * part of the payload schema every consumer has to parse.
 */
export type ErrorType =
  | "not_ready"
  | "chain_unreachable"
  | "relay_unavailable"
  | "pinner_unavailable"
  | "not_found"
  | "invalid_request"
  | "authentication"
  | "invalid_op_signature"
  | "receipt_timeout"
  | "busy"
  | "rate_limit_exceeded"
  | "internal";

/**
 * Whether the same request, unchanged, may succeed later. **Every route decides
 * this explicitly** (R57): it is the whole retry contract, and a value inherited
 * by accident is a retry storm or a stalled client.
 */
const RETRYABLE: Record<ErrorType, boolean> = {
  not_ready: true,
  chain_unreachable: true,
  // The node could not get **its own** transaction onto the chain: the relayer
  // is out of gas money, its nonce lost a race with an external submitter, or
  // the endpoint answered `-32603`/`-32005`. Nothing about the caller's request
  // is wrong, so the same bytes, unchanged, may well succeed later — which is
  // exactly what `invalid_request` promises they cannot (R57, R70). Separate
  // from `chain_unreachable` because that one means *nothing answered*, and an
  // operator reading "chain unreachable" for an empty wallet would go looking at
  // the wrong thing. `code` names which failure it was, down to
  // `endpoint_refused` when the endpoint refused for a reason the node has no
  // name for — on this door that is still the node's failure, not the caller's
  // (R72).
  relay_unavailable: true,
  // The object store this node pins through could not be
  // reached. Same reasoning as `relay_unavailable` and the same answer: the
  // caller's bytes are fine, the node's dependency is not, and `invalid_request`
  // would promise that the identical request can never succeed (R57, R70).
  pinner_unavailable: true,
  not_found: false,
  invalid_request: false,
  authentication: false,
  // The op signature does not recover to a registered provider. Re-sending the
  // identical bytes cannot change that; a new signature is a new request.
  invalid_op_signature: false,
  // The transaction was broadcast and its receipt did not arrive in time. `false`
  // on purpose and it is the important one: a retry would re-broadcast an op that
  // may be mining. The message names the read that answers instead — for a job,
  // `GET /v1/jobs/{id}`, which shows the job once its log is indexed — a post
  // whose receipt this node never saw is written by nothing earlier.
  receipt_timeout: false,
  // Too many callers are queued behind one job's claim. The queue drains in
  // seconds and the answer changes when it does, so this is the one refusal on
  // the op door that a client should simply try again.
  busy: true,
  // A wallet at its daily job limit (`JOB_RATE_LIMIT`). `false` although a slot
  // does open eventually: that is up to 24 hours away, and a client that reads
  // `true` retries on a backoff measured in seconds. The message names when.
  rate_limit_exceeded: false,
  // Unknown by definition: a 500 promises nothing about a second attempt.
  internal: false,
};

/**
 * `invalid_request` is spelled `invalid_request_error` on the wire, and
 * `authentication` `authentication_error`. The emulator used OpenAI's vocabulary
 * for the client-facing surface and the provider SDK's handshake is written
 * against it; the others are VORQ's own.
 */
const WIRE_TYPE: Record<ErrorType, string> = {
  not_ready: "not_ready",
  chain_unreachable: "chain_unreachable",
  relay_unavailable: "relay_unavailable",
  pinner_unavailable: "pinner_unavailable",
  not_found: "not_found",
  invalid_request: "invalid_request_error",
  authentication: "authentication_error",
  invalid_op_signature: "invalid_op_signature",
  receipt_timeout: "receipt_timeout",
  busy: "busy",
  rate_limit_exceeded: "rate_limit_exceeded",
  internal: "internal_error",
};

/** A failure with a wire shape. Thrown from a handler, rendered by the error handler. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    message: string,
    readonly param: string | null = null,
    /**
     * A machine-readable discriminator inside one `type`. The provider SDK
     * branches on `code === "not_registered"` to tell "this wallet is not a
     * provider yet" from every other 403, so it is part of the contract.
     */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, param: string): ApiError =>
  new ApiError(400, "invalid_request", message, param);

/**
 * The wire body of one failure, and its retryability — the two halves of the
 * envelope, exported so a caller that cannot reach `reply.send` can still produce
 * the identical answer.
 *
 * There is exactly one such caller: the `onSend` guard on `POST /v1/jobs`, which
 * rewrites a response that has already been formed (`api/routes/post.ts`). It
 * runs after the handler has returned, so it serialises the payload itself — and
 * without these two it would hand-build an envelope that looks like every other
 * failure until the day one of them changes shape.
 */
export const errorBody = (error: ApiError) => ({
  error: {
    message: error.message,
    type: WIRE_TYPE[error.type],
    param: error.param,
    code: error.code,
  },
});

/** Whether `type` promises that the identical request may succeed later (R57). */
export const isRetryable = (type: ErrorType): boolean => RETRYABLE[type];

export function fail(reply: FastifyReply, error: ApiError): FastifyReply {
  return reply
    .code(error.status)
    .header("x-vorq-retryable", String(isRetryable(error.type)))
    .send(errorBody(error));
}
