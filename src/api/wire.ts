import { rawJson } from "./serialize.js";

/**
 * Row → wire conversions small enough to be shared by more than one route
 * module. Everything wider lives with the route that owns the table.
 */

/**
 * A CID is stored as the bytes the chain carried, which are its ASCII text.
 * Empty means "not set" — `result_cid` defaults to `''` — and that is `null` on
 * the wire, not an empty string a client might mistake for a real CID.
 */
export const cid = (value: Buffer): string | null =>
  value.length === 0 ? null : value.toString("utf8");

/** `jsonb` text, spliced through untouched, or `null`. Never parsed here (R51). */
export const jsonb = (text: string | null) => (text === null ? null : rawJson(text));
