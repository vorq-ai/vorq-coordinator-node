import { MAX_EXPIRY_SECONDS, MAX_SLA_SECONDS } from "../orders.js";

/**
 * The escrow's time windows — five numbers and the inequality that ties them.
 *
 * Split out of `keys.ts` for exactly one reason: `src/config.ts` needs
 * {@link ESCROW_SWEEP_INTERVAL_MS} as the documented default for
 * `ESCROW_SWEEP_INTERVAL_MS` (P20), `keys.ts` opens with
 * `import sodium from "sodium-native"`, and config parsing is the first thing
 * every entry point does — so loading a config loaded a native crypto addon
 * before it could report a missing environment variable.
 *
 * Duplicating the constant into `config.ts` was the alternative, and it is the
 * drift P20 exists to prevent: the default and the constant have to be the same
 * number, and the only way to say that is to have one number. So the numbers
 * live here and `keys.ts` re-exports all five, which leaves every existing
 * importer reading the name it already read.
 *
 * **Nothing that imports a native addon belongs in this file.**
 * `test/config.test.ts` fails if `src/config.ts` reaches back into
 * `escrow/keys.js`, which is the edge that carried the addon in.
 */

/** One hour, so the windows below read as the durations they are. */
const HOUR_MS = 3_600_000;

/**
 * How long a client may serve an escrow public key out of its own cache before
 * re-fetching — the "grace" term of the soundness inequality.
 *
 * Client-side, and stated here because the inequality is what makes the three
 * windows move together. A client that cached this key for up to
 * `KEY_CACHE_TTL_MS` can post an order naming it after this node stopped
 * advertising it, and that order is legitimate.
 */
export const KEY_CACHE_TTL_MS = 3 * HOUR_MS;

/** `JobRegistry.MAX_EXPIRY` in milliseconds — the longest an order stays postable. */
export const MAX_EXPIRY_MS = Number(MAX_EXPIRY_SECONDS) * 1000;

/**
 * The longest SLA this node will quote, in milliseconds — the term P3 restored.
 *
 * Read from `src/orders.ts` rather than written again, because the two must move
 * together: raising the SLA ceiling without raising retention is precisely the
 * change that makes the escrow unsound, and `soundness` is what catches it. Note
 * this is the node's ceiling; the **chain's** allowed maximum is what boot feeds
 * to `soundness`, and it can exceed this one.
 */
export const MAX_SLA_MS = Number(MAX_SLA_SECONDS) * 1000;

/** How long a retired generation is held before it is erased. See `keys.ts`. */
export const ESCROW_KEY_RETENTION_MS = 72 * HOUR_MS;

/**
 * The documented default sweep interval (P20).
 *
 * Five minutes. The deadline is what bounds a key's life, not this — the
 * interval only bounds how *late* an erasure happens, and against a 72 h
 * retention five minutes is 0.1 % slack. Shorter would be a timer firing
 * thousands of times to iterate a handful of keys; longer starts to be a window
 * a reader could describe as "keys survive their deadline".
 */
export const ESCROW_SWEEP_INTERVAL_MS = 5 * 60_000;
