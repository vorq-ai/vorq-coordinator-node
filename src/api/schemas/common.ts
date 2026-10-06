import { Type, type TSchema } from "typebox";
import { MAX_CID_CHARS } from "../../pin/pinner.js";
import { USD_PATTERN } from "../../money.js";
import { VORQ_ERROR, type VorqError } from "./ajv.js";

/**
 * The shapes every route schema is built from.
 *
 * Request primitives carry their refusal text in `x-vorq-error`, so a malformed
 * field is answered `<param> <message>` whichever route it arrived on. Response
 * primitives describe the wire after the one JSON boundary (`serialize.ts`):
 * money is a USD decimal string (`money.ts`), every other integer a JSON
 * integer, and every byte string `0x` hex.
 */

export interface Options {
  description?: string;
  default?: unknown;
  minLength?: number;
  error?: VorqError;
}

const opts = (base: VorqError, { error, ...rest }: Options = {}) => ({
  ...rest,
  [VORQ_ERROR]: { ...base, ...error },
});

const HEX_MESSAGE = "must be a 0x-prefixed hex string of the right length";

export const Hex32 = (o?: Options) =>
  Type.String({ pattern: "^0x[0-9a-fA-F]{64}$", ...opts({ message: HEX_MESSAGE }, o) });

export const Address = (o?: Options) =>
  Type.String({ pattern: "^0x[0-9a-fA-F]{40}$", ...opts({ message: HEX_MESSAGE }, o) });

/** `0x` and whole bytes, at most `maxBytes` of them. */
export const Hex = (maxBytes: number, o?: Options) =>
  Type.String({
    pattern: "^0x([0-9a-fA-F]{2})*$",
    maxLength: 2 + 2 * maxBytes,
    ...opts({ message: `must be 0x-prefixed hex of at most ${maxBytes} bytes` }, o),
  });

/**
 * A 65-byte secp256k1 signature — the only length the contracts' `_recover`
 * accepts, and a bound rather than a formality: `authSig` is stored on the job
 * row, so an unbounded one is storage gas the relayer fronts for a post that
 * can never be claimed. A 64-byte EIP-2098 compact form is refused.
 */
export const Sig65 = (o?: Options) =>
  Type.String({
    pattern: "^0x[0-9a-fA-F]{130}$",
    ...opts({ message: "must be 65 bytes of 0x-prefixed hex" }, o),
  });

/** A 32-byte X25519 public key as 64 hex characters, no `0x`. */
export const HexBare32 = (o?: Options) =>
  Type.String({
    pattern: "^[0-9a-fA-F]{64}$",
    ...opts({ message: "must be 64 hex characters, no 0x prefix" }, o),
  });

/**
 * Canonical padded base64. `Buffer.from(s, "base64")` skips what it does not
 * recognise, so the format is what makes a malformed field a refusal rather
 * than a short buffer. `maxBytes` bounds the encoded length from the decoded one.
 */
export const Base64 = (maxBytes?: number, o?: Options) =>
  Type.String({
    format: "base64",
    ...(maxBytes === undefined ? {} : { maxLength: 4 * Math.ceil(maxBytes / 3) }),
    ...opts({ message: "must be canonical padded base64" }, o),
  });

/** A `uint32`: a JSON integer. */
export const Uint32 = (o?: Options & { minimum?: number; maximum?: number }) => {
  const { minimum = 0, maximum = 2 ** 32 - 1, ...rest } = o ?? {};
  return Type.Integer({
    minimum,
    maximum,
    ...opts({ message: `must be an integer in [${minimum}, ${maximum}]` }, rest),
  });
};

/**
 * An integer wider than `uint32` — a time or a total: a JSON integer, at most
 * 2^53 − 1, the largest a double holds exactly.
 */
export const SafeUint = (o?: Options) =>
  Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    ...opts({ message: `must be an integer in [0, ${Number.MAX_SAFE_INTEGER}]` }, o),
  });

/**
 * Money: a USD decimal string; a rate is USD per 1M units. Its precision is
 * checked against the payment token's decimals where it is converted.
 */
export const Usd = (o?: Options) =>
  Type.String({
    pattern: USD_PATTERN,
    maxLength: 80,
    ...opts({ message: 'must be a USD decimal string, e.g. "0.05"' }, o),
  });

/** The name of an upload this node minted. */
export const Cid = (o?: Options) =>
  Type.String({
    minLength: 1,
    maxLength: MAX_CID_CHARS,
    ...opts({ message: `must be between 1 and ${MAX_CID_CHARS} characters` }, o),
  });

// ---------------------------------------------------------------------------
// The wire, as responses carry it
// ---------------------------------------------------------------------------

/** An integer after the JSON boundary. */
export const Int = (description?: string) =>
  Type.Integer({ minimum: 0, ...(description === undefined ? {} : { description }) });

/** Money after the JSON boundary: a canonical USD decimal string. */
export const UsdOut = (description?: string) =>
  Type.String({ pattern: USD_PATTERN, ...(description === undefined ? {} : { description }) });

/** A byte string after the JSON boundary. */
export const HexOut = (description?: string) =>
  Type.String({ pattern: "^0x[0-9a-fA-F]*$", ...(description === undefined ? {} : { description }) });

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** The indexed block an answer was read at; `null` before the first block is indexed. */
export const AsOfBlock = Nullable(Int("The indexed block this answer was read at."));

export const ErrorEnvelope = Type.Object(
  {
    error: Type.Object({
      message: Type.String(),
      type: Type.String(),
      param: Nullable(Type.String()),
      code: Nullable(Type.String()),
    }),
  },
  {
    description:
      "Every refusal. Whether the same request may succeed later is the " +
      "`x-vorq-retryable` header, never the body.",
  },
);

/** One `ErrorEnvelope` per status, for a route's `response`. */
export const errors = (...statuses: number[]) =>
  Object.fromEntries(statuses.map((status) => [status, ErrorEnvelope]));

export const BEARER = [{ bearerAuth: [] }];
