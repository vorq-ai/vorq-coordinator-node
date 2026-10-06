import { badRequest } from "./errors.js";

/**
 * Parsing for values that arrive through no route schema: rows read back from
 * the store (`asks/push.ts`) and a peer escrow's answer (`escrow/handover.ts`).
 * Every request is shaped by its route's schema (`schemas/`), never here.
 */

const DIGITS = /^\d+$/;

/**
 * The largest value any id in this API can hold. `model_id`, `provider_id` and
 * `designated` are `uint32` on chain — the columns are `BIGINT` only because
 * Postgres' `INT` stops short of a uint32 (R48), not because a wider value is
 * reachable. Bounding here also keeps an absurd input from reaching Postgres as
 * an out-of-range `BIGINT` and surfacing as a 500.
 */
export const UINT32_MAX = 4_294_967_295n;

/** `uint64`, the width of every `issuedAt` and expiry on chain. */
export const UINT64_MAX = 18_446_744_073_709_551_615n;

/**
 * An integer inside `[min, max]`, from a string or a JSON number.
 *
 * A JSON body may carry a real number, and `12.5` or `1e3` must not become `12`
 * or `1000` silently — a rounded `issued_at` is a signature that will not verify
 * and a rounded `n` is a capacity nobody asked for.
 */
export function integer(value: unknown, param: string, min: bigint, max: bigint): bigint {
  let parsed: bigint;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw badRequest(`${param} must be an integer in [${min}, ${max}]`, param);
    }
    parsed = BigInt(value);
  } else if (typeof value === "string" && DIGITS.test(value)) {
    parsed = BigInt(value);
  } else {
    throw badRequest(`${param} must be an integer in [${min}, ${max}]`, param);
  }
  if (parsed < min || parsed > max) {
    throw badRequest(`${param} must be an integer in [${min}, ${max}]`, param);
  }
  return parsed;
}

/** A value as an object, or a 400. `null` and arrays are not objects. */
export function object(body: unknown, param: string): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest(`${param} must be a JSON object`, param);
  }
  return body as Record<string, unknown>;
}

/** Canonical base64, padded, no whitespace and no URL alphabet. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * How many bytes `length` base64 characters decode to, exactly.
 *
 * The **encoded** length is what a `bodyLimit` bounds, and it is not a bound on
 * what this process allocates: 4 characters become 3 bytes, so the decoded size
 * has to be computed and refused on its own terms. Computed from the length
 * rather than measured after decoding, because measuring after decoding means
 * the allocation the cap exists to prevent has already happened.
 */
const decodedLength = (value: string): number => {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

/**
 * A base64 field of a JSON body, decoded, optionally capped on the **decoded**
 * length.
 *
 * Two refusals always, both `400` naming the field:
 *
 *   * not base64 at all. `Buffer.from(s, "base64")` is famously forgiving — it
 *     skips characters it does not recognise and returns a short buffer rather
 *     than failing — so a body of `"hello world!"` would decode to *something*
 *     and be hashed as if it were a payload. The pattern is what makes a
 *     malformed field a refusal instead of a wrong answer.
 *   * a length that is not a multiple of 4, which no canonical encoder produces
 *     and which makes {@link decodedLength} a guess rather than an arithmetic
 *     identity.
 *
 * And a third when `maxBytes` is given: past it **decoded**, checked from the
 * character count before the `Buffer` is allocated. Omitting the cap is for a
 * field whose only bound is the route's own `bodyLimit` — a container or a
 * result, where the body limit is the whole bound and a second, decoded cap
 * would refuse a payload the door had already read.
 */
export function base64Bytes(
  value: string,
  param: string,
  maxBytes?: number,
): Buffer {
  if (!BASE64.test(value) || value.length % 4 !== 0) {
    throw badRequest(`${param} must be canonical padded base64`, param);
  }
  if (maxBytes !== undefined) {
    const size = decodedLength(value);
    if (size > maxBytes) {
      throw badRequest(`${param} must decode to at most ${maxBytes} bytes, and this is ${size}`, param);
    }
  }
  return Buffer.from(value, "base64");
}
