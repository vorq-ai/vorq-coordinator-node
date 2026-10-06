import { randomBytes } from "node:crypto";

/**
 * The one place a projection row crosses into JSON, and the only place it may.
 *
 * `JSON.stringify` is not usable on a row from this database. Three separate
 * hazards make that true, and only the first of them is loud:
 *
 *   * **`BIGINT` throws** (R46). Fourteen columns and `allowed_models` come back
 *     as `bigint` after R48, and `completion_tok` is the trap nobody predicts —
 *     `uint32` on chain, `BIGINT` in the schema, so viem writes a `number` and
 *     Postgres reads back a `bigint`. `TypeError: Do not know how to serialize a
 *     BigInt` is at least immediate.
 *   * **`BYTEA` serialises to Buffer's own JSON shape.** `Buffer.prototype
 *     .toJSON` runs *before* a replacer ever sees the value, so a naive replacer
 *     is handed `{type:"Buffer",data:[…]}` and can no longer tell it was bytes.
 *     The replacer here reads the value out of its *holder* instead, which is
 *     the only way to see the Buffer itself.
 *   * **`jsonb` is already wrong by the time it gets here** (R51). The value is
 *     stored exactly — `jsonb` numbers are `NUMERIC` — but the driver parses it
 *     into JavaScript, where a number is a double: `{"n":12345678901234567890}`
 *     reads back as `12345678901234567000` and `{"n":1e100000}` reads back as
 *     `null`, with the database vindicating you either way. A route serving
 *     `providers.evidence` or `allowlist.entry` selects the column as **text**
 *     and wraps it in {@link rawJson}; the text is spliced into the output
 *     without ever becoming a JS value.
 *
 * Every integer — `BIGINT` and `NUMERIC` alike — arrives as a `bigint` and
 * leaves as an exact JSON integer. Money is the exception, and never reaches
 * here as a `bigint`: each route formats it as a USD string (`money.ts`).
 */

/** JSON text to splice in verbatim. Produced by {@link rawJson}. */
const RAW = Symbol("vorq.rawJson");

export interface RawJson {
  readonly [RAW]: string;
}

/**
 * Marks `text` as JSON that is already serialised and must reach the wire
 * unaltered — the `::text` projection of a `jsonb` column, never a JS value.
 *
 * `text` is **checked** for well-formedness and the parse result is thrown away.
 * That looks redundant — it comes from Postgres' own `jsonb` output, which is
 * well-formed by construction — and it is not: this splices text straight into a
 * response body, so a caller that ever hands it something else corrupts the
 * whole reply rather than one field, and the failure would surface as a client
 * JSON parse error a long way from its cause. Discarding the parse is what keeps
 * the check free of the rounding this module exists to prevent (R51): the
 * original text, not the re-serialisation, is what travels.
 */
export function rawJson(text: string): RawJson {
  try {
    JSON.parse(text);
  } catch (cause) {
    throw new TypeError("rawJson requires well-formed JSON text", { cause });
  }
  return { [RAW]: text };
}

/**
 * A `bigint` as the double that holds it exactly. Every integer column is
 * bounded far below 2^53 by what it holds; one that is not throws here rather
 * than arriving silently rounded at a client.
 */
function exactNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${value} is not exactly representable as a JSON number`);
  }
  return Number(value);
}

const isRawJson = (value: unknown): value is RawJson =>
  typeof value === "object" && value !== null && RAW in value;

/**
 * Serialises `value` to JSON text: `bigint` as a JSON integer, `Uint8Array`
 * (and therefore `Buffer`) as `0x…` hex, {@link rawJson} spliced in verbatim.
 *
 * The splice works by emitting a placeholder string and substituting it after
 * `JSON.stringify` returns. The placeholder carries a **per-call random token**,
 * so a chain-supplied string — a model name, a decoded CID — cannot impersonate
 * one and have arbitrary text injected into the response. A fixed marker would
 * be a serialisation-level injection vector reachable by anyone who can write to
 * the projection, which on this chain is anyone at all.
 *
 * The substitution is **one pass over the text, whatever the row count**. It was
 * a `reduce` of one `String.replace` per placeholder, which rescans the whole
 * body once per row: 8000 rows cost 2.4 s, synchronously, inside the reply
 * serializer — so it stalled the event loop for every other request too, at a
 * row count an unauthenticated caller chooses. The listings are paginated now
 * (see `PAGE_MAX_LIMIT` in `app.ts`) and this is linear anyway; the bound and the
 * algorithm are independent defences and both are wanted.
 */
export function toJsonText(value: unknown): string {
  const token = randomBytes(8).toString("hex");
  const spliced: string[] = [];

  const text = JSON.stringify(value, function (this: unknown, key: string, encoded: unknown) {
    // The holder, not `encoded`: `toJSON` has already run on `encoded`, which is
    // what hides a Buffer behind `{type:"Buffer",data:[…]}`.
    //
    // Known and deliberately not chased: an object whose own `toJSON` *returns* a
    // bigint still throws, because the holder is the object and the bigint is
    // never held anywhere this can see. No pg row produces one — the driver hands
    // back Buffers, strings, numbers and bigints, none of which carry a `toJSON`
    // that mints a bigint — so the hole is unreachable from every caller here.
    const held = (this as Record<string, unknown>)[key];

    if (typeof held === "bigint") return exactNumber(held);
    if (held instanceof Uint8Array) return `0x${Buffer.from(held).toString("hex")}`;
    if (isRawJson(held)) return `${token}:${spliced.push(held[RAW]) - 1}`;
    return encoded;
  });

  // `undefined` in, `undefined` out — the reply serializer must still produce a
  // body, and `null` is the JSON value that means the same thing.
  if (text === undefined) return "null";
  if (spliced.length === 0) return text;

  // The token is hex, so it needs no regex escaping. The **function** form of
  // `replace` is load-bearing and must stay: with a string replacement, `$&`,
  // "$`" and `$1` inside attacker-controlled `evidence` would be expanded as
  // substitution patterns. A function's return value is used verbatim.
  return text.replace(
    new RegExp(`"${token}:(\\d+)"`, "g"),
    (marker, index: string) => spliced[Number(index)] ?? marker,
  );
}
