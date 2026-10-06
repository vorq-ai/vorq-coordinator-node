/**
 * The one size anyone sets, and the inline rule derived from it.
 *
 * There used to be two numbers: a body cap on each byte-carrying door, and a
 * separate `INLINE_MAX_BYTES` that told a client when to stop inlining and
 * upload first. The second one was hand-written in four repos — both client
 * SDKs, the daemon, and the doc — with nothing tying them together, so editing
 * one left every suite green and the parties silently disagreed about where the
 * line was.
 *
 * They were never two decisions. Base64 is the whole reason they differ: a
 * caller cannot inline a body's worth of bytes into a body, because encoding
 * them costs a third again. That is arithmetic, so it is derived here and
 * derived the same way by every party that has to decide. {@link MAX_BODY_BYTES}
 * is the only number with a choice behind it.
 */

/**
 * The largest body either byte-carrying door reads, in bytes.
 *
 * This **is** the bound: no decoded cap stands behind it, because a cap applied
 * after `JSON.parse` has already spent the allocation it existed to prevent.
 * `bodyLimit` acts before the body is buffered, which is the property that
 * matters on doors that are unauthenticated (`POST /v1/jobs`) or provider-facing
 * (`POST /evm/ops`). Past it Fastify answers `413` without reading the rest of
 * the stream.
 *
 * A caller with more than this uploads to `POST /v1/files`, where the bytes are
 * streamed rather than held and `MAX_BLOB_BYTES` is the only bound.
 */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * What {@link INLINE_MAX_BYTES} leaves free for everything that is not content.
 *
 * The order, the payment and a 65-byte signature come to well under a KiB; a
 * settle's envelope is smaller still. 64 KiB is far more than either needs, and
 * deliberately so — the cost of reserving too much is a slightly lower inline
 * threshold, while the cost of reserving too little is refusing a payload the
 * client had already decided was inlineable, which is the one failure this
 * shared derivation exists to make impossible.
 */
export const ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * How many bytes base64 costs to encode, exactly as the encoder counts them.
 *
 * Four characters per three-byte group, the last group padded. This is the
 * function every party applies to reach the same threshold.
 */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * The largest sealed payload that still fits in a body, in decoded bytes.
 *
 * At or under this a client inlines; above it, it files the bytes through
 * `POST /v1/files` and names the upload by cid. Derived so that a payload at the
 * threshold encodes to precisely the room {@link ENVELOPE_RESERVE_BYTES} leaves
 * it — there is no slack to tune and nothing to re-check when the ceiling moves.
 *
 * Safe for any ceiling, not just this one: `4·ceil(floor(R/4)·3/3) = 4·floor(R/4)
 * ≤ R`, so the threshold can never exceed the room left for it whatever
 * `MAX_BODY_BYTES` is set to. The equality the tests pin is the tighter case
 * where `R` divides by 4, which every MiB-multiple ceiling less the reserve
 * does. The `Math.max` floors a ceiling set smaller than the reserve, which
 * would otherwise export a negative number to four other repos.
 *
 * The node itself never applies this: it bounds the body and does not care which
 * side of the line a caller was on. It is exported because the SDKs, the daemon
 * and the cross-language fixture all have to agree on the number, and this is
 * where it is defined.
 */
export const INLINE_MAX_BYTES = Math.max(
  0,
  Math.floor((MAX_BODY_BYTES - ENVELOPE_RESERVE_BYTES) / 4) * 3,
);
