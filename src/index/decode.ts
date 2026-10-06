import {
  decodeEventLog,
  hexToBytes,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type ContractEventName,
  type DecodeEventLogReturnType,
  type Hex,
  type Log,
} from "viem";
import { askRegistryAbi } from "../abi/askRegistry.js";
import { jobRegistryAbi } from "../abi/jobRegistry.js";
import { providerRegistryAbi } from "../abi/providerRegistry.js";

/** The parts of a log this module reads. Any viem `Log` satisfies it. */
export type RawLog = Pick<Log, "topics" | "data">;

/**
 * The decoded form of every event of `abi`, as a union discriminated on
 * `eventName`. `Hex` is passed for the `data` parameter so the non-indexed
 * members are present in `args` — with viem's default the type describes a
 * topics-only decode and silently loses them.
 */
type EventsOf<abi extends Abi> = DecodeEventLogReturnType<
  abi,
  ContractEventName<abi>,
  Hex[],
  Hex,
  true
>;

type Named<abi extends Abi, names extends ContractEventName<abi>> = Extract<
  EventsOf<abi>,
  { eventName: names }
>;

/**
 * The JobRegistry events the projection stores.
 *
 * `FeesChanged`, `SlaAllowedChanged` and `TreasuryChanged` are deliberately
 * absent. They exist on chain for audit; the node reads that configuration
 * through Task 2's cached `eth_call` reader, and a second copy in the index
 * could only ever disagree with the chain. What a job paid needs none of them:
 * `Posted` carries its gas fee and `Settled` its protocol fee.
 */
const JOB_EVENTS = ["Posted", "Claimed", "Settled", "Ended"] as const;

/** Every ProviderRegistry event is projected, `ModelEnabledChanged` included (R5). */
const REGISTRY_EVENTS = [
  "ProviderRegistered",
  "OperatorChanged",
  "ListedChanged",
  "CapacityChanged",
  "ReputationChanged",
  "ModelRegistered",
  "ModelEnabledChanged",
  "AllowedModelsChanged",
  "AllowlistEntrySet",
  "IdentityUpdated",
] as const;

const ASK_EVENTS = ["AsksPublished"] as const;

export type JobEvent = Named<typeof jobRegistryAbi, (typeof JOB_EVENTS)[number]>;
export type RegistryEvent = Named<typeof providerRegistryAbi, (typeof REGISTRY_EVENTS)[number]>;
export type AskEvent = Named<typeof askRegistryAbi, (typeof ASK_EVENTS)[number]>;

/** Everything the reducer knows how to apply. */
export type ChainEvent = JobEvent | RegistryEvent | AskEvent;

/**
 * `topic0` → the one-entry ABI that declares it.
 *
 * Built from the vendored ABIs rather than from hand-written signature strings.
 * That is not a style preference: `AsksPublished`'s topic derives from the
 * ABI-canonical, tuple-expanded form
 * `AsksPublished(uint32,uint64,(uint32,uint32,uint128,uint128)[])`, and hashing
 * the human-readable `AsksPublished(uint32,uint64,Ask[])` instead yields a topic
 * nothing emits — a reducer keyed on it sees zero asks forever, with no error
 * anywhere to say so (R35).
 */
const PROJECTED = new Map<Hex, readonly [AbiEvent]>();

function project(abi: Abi, names: readonly string[]): void {
  for (const name of names) {
    const entry = abi.find((item): item is AbiEvent => item.type === "event" && item.name === name);
    if (entry === undefined) {
      throw new Error(`the vendored ABI declares no event named ${name}`);
    }
    const topic0 = toEventSelector(entry);
    const clash = PROJECTED.get(topic0);
    if (clash !== undefined) {
      throw new Error(`topic0 collision between ${clash[0].name} and ${name}`);
    }
    PROJECTED.set(topic0, [entry]);
  }
}

project(jobRegistryAbi, JOB_EVENTS);
project(providerRegistryAbi, REGISTRY_EVENTS);
project(askRegistryAbi, ASK_EVENTS);

/**
 * Every event the projection stores, sorted, as the reducer actually resolved it
 * off the vendored ABIs. Exported so a test can pin the set: dropping one is a
 * silent hole in the index rather than a build error, and `ModelEnabledChanged`
 * is exactly the kind of event a later edit loses (R5).
 */
export const PROJECTED_EVENT_NAMES: readonly string[] = [...PROJECTED.values()]
  .map(([event]) => event.name)
  .sort();

/**
 * Decodes one log into the event the reducer applies, or `null` when the log is
 * not one the projection stores — an unrelated contract's event, an anonymous
 * log, or one of the config events above.
 *
 * A log whose topic matches but whose body does not decode throws: that is a
 * malformed log, not an unknown one, and swallowing it would put a gap in a
 * projection that is supposed to be a pure function of the chain.
 */
export function decodeLog(log: RawLog): ChainEvent | null {
  const topic0 = log.topics[0];
  if (topic0 === undefined) return null;

  const abi = PROJECTED.get(topic0);
  if (abi === undefined) return null;

  // `abi` comes out of a runtime lookup, so viem cannot infer which event this
  // is and widens the result. The table maps each topic to the single ABI entry
  // that produced it, so the value can only be the matching member of
  // `ChainEvent`; `decodeLog` in `test/reducer.test.ts` is what holds that
  // honest, by asserting the decoded shape of every projected event.
  return decodeEventLog({ abi, data: log.data, topics: log.topics }) as ChainEvent;
}

/** The one byte no `text` parameter can carry, whatever column it is bound for. */
const NUL = String.fromCharCode(0);

/** U+FFFD REPLACEMENT CHARACTER, Unicode's own marker for an unrepresentable character. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * The deepest container nesting a `bytes` member may carry into a `JSONB`
 * column. Anything deeper is stored as `{"raw":"0x…"}` like any other refusal.
 *
 * This is a **bound, not a denylist**: one number that provably admits
 * everything below it, so it does not need revisiting as new payloads turn up.
 * It exists because `pg_input_is_valid` converts only *soft* errors, and the
 * jsonb parser's recursion guard is a **hard** one — it raises straight through
 * the screen, wedging the cursor exactly as an unscreened payload would (R50a).
 *
 * Chosen against measured thresholds, not guessed. Container depth at which
 * `pg_input_is_valid` raises `stack depth limit exceeded`, by `max_stack_depth`
 * and by the cheapest-per-level shape (nested objects):
 *
 * | `max_stack_depth` | array | object | mixed | worst |
 * | --- | --- | --- | --- | --- |
 * | 100 kB (PostgreSQL's documented minimum) | 781 | **695** | 736 | 695 |
 * | 2 MB (the default) | 16365 | **14548** | 15404 | 14548 |
 *
 * 64 sits 10.9x below the worst *configurable* threshold and 227x below the
 * default, while still admitting more than ten times the nesting any real
 * attestation document uses (those run three to six deep). It also keeps the
 * read path safe: a route reading this column back parses it in V8, which
 * recurses where this scanner does not.
 */
export const MAX_JSONB_DEPTH = 64;

/**
 * Whether `text` ever has more than `limit` containers open at once.
 *
 * A scanner rather than a parse: iterative, single pass, and it never recurses,
 * so measuring the depth cannot blow the stack it is protecting. Brackets inside
 * string literals are not containers and are skipped, escapes included —
 * Postgres accepts `{"a":"[[[[…"}` at any length, and so must this.
 *
 * Unbalanced text drives the counter negative, which is harmless: that payload
 * is not valid JSON and `pg_input_is_valid` refuses it a moment later.
 */
function exceedsJsonbDepth(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c)
        escaped = true; // backslash
      else if (code === 0x22) inString = false; // closing quote
      continue;
    }

    if (code === 0x22)
      inString = true; // opening quote
    else if (code === 0x7b || code === 0x5b) {
      if (++depth > limit) return true; // { or [
    } else if (code === 0x7d || code === 0x5d) depth--; // } or ]
  }

  return false;
}

/** The two texts a `JSONB` write binds: what the log said, and what to fall back to. */
export interface JsonbBytes {
  /**
   * The log's own bytes as text, offered to Postgres **unaltered**. `jsonb`
   * stores numbers as `NUMERIC`, so an integer too large for a double survives
   * the original text exactly while a round trip through `JSON.parse` would
   * quietly round it. Screen the text; never rewrite it.
   */
  candidate: string;
  /** `{"raw":"0x…"}`. Stored when Postgres will not take the candidate. */
  raw: string;
}

/**
 * Reads an event's `bytes` member as the pair of texts a `JSONB` write binds.
 *
 * `providers.evidence` and `allowlist.entry` are fed from `bytes` members that
 * nothing on chain constrains — `setIdentity` is signature-only, so **any**
 * registered provider can put arbitrary bytes in one — and the reducer must
 * never throw on a well-formed log (R20, R50).
 *
 * **This function does not decide whether the payload is storable, because it
 * cannot.** `JSON.parse` accepting a value says nothing about whether `jsonb`
 * will take it: a lone surrogate (`{"a":"\ud800"}`) and a numeric literal past
 * what `NUMERIC` can represent (`{"n":1e1000000000}`) both parse in JS and are
 * both refused by Postgres, and either one is a permanent wedge — the insert
 * fails, the range rolls back, and the cursor never advances again. Screening
 * for a list of known-bad shapes would only ever cover the shapes someone
 * thought of. So the judgement is delegated to Postgres itself: the write binds
 * both texts and picks between them with `pg_input_is_valid(…, 'jsonb')`, which
 * is the very input function the cast would use.
 *
 * Two things are left here, and both are cases the screen cannot answer because
 * it never gets to:
 *
 *   * **A NUL.** A `text` parameter cannot carry one at all, so the payload
 *     never reaches the `jsonb` input function to be judged — `pg_input_is_valid`
 *     throws on it exactly as the cast does. Complete rather than a sample,
 *     because encoding a JS string to UTF-8 produces no other refused byte.
 *   * **Nesting past {@link MAX_JSONB_DEPTH}.** The parser's recursion guard is
 *     a hard error, which `pg_input_is_valid` re-raises instead of reporting
 *     (R50a). The bound is applied *before* the screen for that reason: the
 *     screen is the thing that would raise.
 *
 * **What is left, with the number measured rather than reasoned.** `jsonb_util.c`
 * has program-limit errors that are hard in the same way, so they would wedge
 * the cursor identically if a log could reach one. The smallest payload that
 * does was measured against `postgres:16` and the threshold pinned exactly:
 * `[1,1,…]` at depth 1 is accepted at 2^24 elements (33 554 432 bytes) and
 * raises `XX000 invalid memory alloc request size 1073741824` at 2^24 + 1. That
 * is a 1 GB allocation request at 64 bytes per element, reached at **32 MiB** of
 * `evidence` — 2 bytes per element being the cheapest shape, and therefore a
 * floor for the class.
 *
 * 32 MiB in an event log costs roughly 2.96e9 gas (calldata, memory expansion
 * and LOG together), which is 66–100x any block gas limit and 176x the
 * EIP-7825 per-transaction cap, in a 33.5 MB transaction against a ~128 KiB
 * gossip limit. So the class is out of reach — but note the figure is 32 MiB and
 * not the 256 MB an earlier estimate reasoned its way to: that estimate missed a
 * 6x size amplification and stopped probing one doubling short of the boundary.
 * If this ever needs revisiting, measure first. The fix would be the same shape
 * as the depth bound: applied before the screen, because the screen raises.
 */
export function jsonbFromBytes(bytes: Hex): JsonbBytes {
  const raw = JSON.stringify({ raw: bytes });
  try {
    // `fatal` so invalid UTF-8 is refused rather than silently replaced with
    // U+FFFD, which would store a corrupted transcription as though it were the
    // real thing.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(bytes));
    const storable = !text.includes(NUL) && !exceedsJsonbDepth(text, MAX_JSONB_DEPTH);
    return { candidate: storable ? text : raw, raw };
  } catch {
    return { candidate: raw, raw };
  }
}

/**
 * Reads an on-chain `string` as a value a `TEXT` column can take.
 *
 * `models.name` reaches Postgres the same way `evidence` does, and a NUL wedges
 * it identically — `invalid byte sequence for encoding "UTF8": 0x00`, before the
 * value is even a column's problem (R50). `registerModel` is curation-gated so
 * this is far harder to reach than the identity path, but the mechanism is the
 * same one and the fix belongs with it.
 *
 * There is no `{"raw":…}` to fall back to on a `TEXT NOT NULL` column, so the
 * offending characters are replaced with U+FFFD — the Unicode standard's own
 * marker for a character that could not be represented, which is what a reader
 * of this column would want to see. Nothing else is touched: a lone surrogate is
 * left alone because Postgres accepts the value Node encodes for it.
 */
export function textFromChainString(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value;
}
