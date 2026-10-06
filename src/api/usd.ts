import { parseUsd, UsdError } from "../money.js";
import { UINT128_MAX } from "../orders.js";
import { badRequest } from "./errors.js";

/**
 * A request's USD field in atomic token units, or a `400` naming it. The schema
 * has already checked the grammar; this checks the precision against the
 * payment token's decimals, and a rate against the `uint128` the chain holds it in.
 */
export function usdParam(text: string, decimals: number, param: string, rate = false): bigint {
  let atomic: bigint;
  try {
    atomic = parseUsd(text, decimals);
  } catch (error) {
    if (error instanceof UsdError) throw badRequest(`${param} ${error.message}`, param);
    throw error;
  }
  if (rate && atomic > UINT128_MAX) {
    throw badRequest(`${param} is past the largest rate the chain holds`, param);
  }
  return atomic;
}
