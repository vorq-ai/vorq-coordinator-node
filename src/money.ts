/**
 * The one conversion between the USD decimal strings this API speaks and the
 * atomic token integers the chain signs and settles: `atomic = usd × 10^decimals`.
 *
 * A rate is USD per 1M units of work; `RATE_SCALE` is 10^6 units, so the same
 * shift gives the on-chain rate (`"0.05"` at 6 decimals is 50000). The grammar
 * and every edge are pinned by `vectors/money-v1.json`, which both client SDKs
 * and the provider daemon test against too.
 */

/** Plain decimal: no sign, exponent, whitespace or leading zeros. */
export const USD_PATTERN = "^(0|[1-9][0-9]*)(\\.[0-9]+)?$";

const USD = new RegExp(USD_PATTERN);

/** Why a USD string was refused: a sentence that follows the field name. */
export class UsdError extends Error {}

/**
 * `text` in atomic units. More fraction digits than the token has is refused,
 * never rounded: rounding would change what the caller agreed to pay.
 */
export function parseUsd(text: string, decimals: number): bigint {
  if (!USD.test(text)) {
    throw new UsdError('must be a USD decimal string, e.g. "0.05"');
  }
  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new UsdError(`has more than ${decimals} fraction digits, the payment token's precision`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** `atomic` as a canonical USD string: no trailing zeros, no bare point. */
export function formatUsd(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const fraction = (atomic % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
