import { readFileSync } from "node:fs";
// From `escrow/windows.js`, not `escrow/keys.js`: `keys.ts` opens with
// `import sodium from "sodium-native"`, and config parsing is the first thing
// every entry point does. The constant is still read rather than restated —
// the default and the constant must be the same number (P20).
import { ESCROW_SWEEP_INTERVAL_MS } from "./escrow/windows.js";

/** A process environment, or any plain map that looks like one. */
export type Env = Record<string, string | undefined>;

/** Object-storage pinner credentials. Present as a group or not at all. */
export interface S3PinConfig {
  endpoint: string;
  key: string;
  secret: string;
  bucket: string;
  region: string;
  /**
   * How much of an object rides in one request, in bytes. Defaults to
   * `PART_BYTES` (8 MiB).
   *
   * A store setting rather than a constant because it is the one number that
   * trades round trips against how much of an object this process holds at once,
   * and S3-compatible gateways differ on what they take in a single request. No
   * environment variable reads it today — the default is right for every store
   * this node has met — but it is here rather than hard-wired so that meeting one
   * that is not is a config change instead of a patch.
   */
  partBytes?: number;
}

/** A 20-byte hex address. Structurally compatible with viem's `Address`. */
export type Address = `0x${string}`;

/**
 * Whether this node hosts the escrow, and under what attestation.
 *
 * `off` is the default and the safe one: the escrow doors exist and refuse, and
 * no key material is ever minted or held. `mock` is **dev and CI only** — see
 * {@link EscrowConfig.mode}. `static` derives the escrow key from `OPERATOR_KEY`
 * instead of minting one, so every instance of a fleet holds the same key and a
 * restart is not a custody event; handover is refused there and nothing decays.
 * The real SNP mode is a later project and is deliberately not a value here yet,
 * so a node cannot be pointed at it by setting a variable before the verifier
 * exists.
 */
export type EscrowMode = "off" | "mock" | "static";

/** The hosted escrow's knobs. */
export interface EscrowConfig {
  /**
   * **`mock` must never be internet-exposed.**
   *
   * Mock evidence is a pure function of a public key — anyone can compute it for
   * any key. `POST /handover` releases this node's *entire held key set* to a
   * caller whose evidence verifies, so an internet-reachable node in mock mode
   * hands every DEK it holds to whoever asks. Mock exists to exercise the
   * machinery end to end on a devnet; the escrow's guarantee is scoped to
   * attested deployments. The node logs this at boot as well, because a comment
   * in a config file is not where an operator finds out.
   */
  mode: EscrowMode;
  /**
   * This image's release ordinal — the anti-rollback anchor (P19, default `1`).
   *
   * A handover refuses a peer whose evidence carries a *lower* ordinal, so keys
   * never migrate backwards onto an image that has been superseded. Under mock
   * evidence the comparison is advisory, because the evidence is forgeable.
   */
  releaseOrdinal: number;
  /**
   * How often retired generations past their deadline are erased (P20).
   *
   * The **deadline** is what bounds a key's life; this bounds only how *late* an
   * erasure happens. Five minutes against a 72 h retention is 0.1 % slack.
   */
  sweepIntervalMs: number;
  /**
   * The peer this node pulls key material from, or `null`.
   *
   * One URL covers both topologies, because `/handover` never changes the *other*
   * node: a successor taking over from a predecessor and a replica mirroring a
   * live sibling perform the identical exchange, and the only thing that differs
   * is what *this* node does locally (see {@link EscrowConfig.peerRequired}).
   *
   * The exchange is a pure pull, so a working replica pair carries **each other's**
   * URL — one-sided configuration cannot propagate a generation minted on the
   * unconfigured side (P6). A successor sets it too, and keeps pulling for as long
   * as the predecessor lives: without that standing pull, anything the predecessor
   * mints during the cutover overlap would never reach the successor.
   *
   * **The peer link must be authenticated at the transport.** Nothing in the
   * handover protocol authenticates the holder to the joiner, so whoever controls
   * this URL can stand in the middle of the exchange. See `README.md`.
   */
  peerUrl: string | null;
  /**
   * Whether the **first** pull must succeed before this node serves anything.
   *
   * `false` (the default) is the replica pair: both instances carry each other's
   * URL, so making the first pull fatal would deadlock the pair — neither can boot
   * until the other is up. Each mints its own generation at boot and adopts the
   * other's on the first sync tick.
   *
   * `true` is a successor inheriting from a live predecessor. It defers minting
   * until the pull lands, so no orphan generation is advertised mid-join, and a
   * failed pull is a **failed boot** — a successor that silently started fresh
   * would answer `unseal_failed` for every wrap sealed to its predecessor's keys,
   * and nothing anywhere would notice.
   *
   * Requires {@link EscrowConfig.peerUrl}; the loader refuses it alone.
   */
  peerRequired: boolean;
  /** How often the standing pull runs, in milliseconds. `PEER_SYNC_S`, default 300 s. */
  peerSyncMs: number;
  /**
   * How often a fresh generation is minted. `ESCROW_ROTATE_INTERVAL_MS`,
   * default 24 h.
   *
   * The previous generation is **retired, not erased**: it keeps its material
   * until the retention window expires, so every wrap already sealed to it still
   * opens. What rotation ends is its use for *new* work, which is what bounds
   * the blast radius of a generation that leaked.
   */
  rotateIntervalMs: number;
  /**
   * The operator credentials, from `OPERATOR_KEY`. **Secret: environment
   * only, never logged.** Empty only at `mode: "off"`.
   *
   * Attestation proves what *code* is asking; this proves whose *deployment* is
   * asking, and the two are independent — an instance's chain endpoint and
   * registry addresses come from its environment and no measurement covers them.
   * It is a shared secret rather than chain state: a joiner signs its pull with
   * one of these, and a holder authenticates a pull by recovering to one of these
   * addresses.
   *
   * **The first signs; all of them are accepted.** One key is the steady state.
   * A list exists so the fleet can change keys at all: a node reads this once at
   * boot and cannot be reconfigured without a restart. In minting mode a restart
   * also erases the escrow key set — so a successor signing a brand-new key at a
   * predecessor that only knows the old one could never join. Rotation is
   * therefore two ordinary cutovers, `K_old` → `K_old,K_new` → `K_new`, each
   * instance signing with a key its predecessor still accepts. The old key dies
   * with the last minting process holding it.
   *
   * **At `mode: "static"` this field is also the escrow key's seed** (HKDF, not
   * a mint): the first entry derives the announced key and every entry still
   * opens wraps sealed to it; a restart re-derives them rather than losing them.
   * Dropping `K_old` here destroys that key, so the second cutover step must
   * wait until every order sealed under it has settled or expired — not merely
   * until every node carries `K_new`.
   */
  operatorKeys: string[];
  /**
   * **A development-only offset on the escrow's key-lifecycle clock**, in
   * milliseconds. `0` in every real deployment, and the loader refuses anything
   * else outside `mode: "mock"`.
   *
   * Retention is 72 h, which is not a window a test can wait out and not a window
   * a test may fake by reaching into a running process: the acceptance gate boots
   * *separate node processes*, so monkey-patching `Date.now` across that boundary
   * is not available and would not be honest if it were (P22). This is the real
   * mechanism instead — read once at boot, handed to {@link KeyManager} as its
   * clock, and therefore visible to exactly two things: the deadline a retired or
   * adopted generation is stamped with, and the sweep that erases past it.
   *
   * It is deliberately **not** the clock `/release` bounds `issued_at` against
   * and **not** the clock `keyEpochStart` is taken from. Shifting those would make
   * every honest request stale and would move the orphan boundary, which is a
   * different property under test — an offset that moved everything would prove
   * nothing about decay.
   */
  clockOffsetMs: number;
}

/** The subset of the published addresses file this node consumes. */
export interface Addresses {
  chainId: number;
  /** The block the deployment was made in — the lower bound of any replay. */
  deployBlock: number;
  jobRegistry: Address;
  providerRegistry: Address;
  askRegistry: Address;
  /** The payment token. Every escrow pull is one authorization against it. */
  usdc: Address;
  /**
   * The payment token's decimals, from the address book and never assumed: it is
   * what every amount on this wire is denominated in, and a guess is wrong by
   * orders of magnitude with nothing anywhere saying so.
   */
  decimals: number;
  /**
   * The payment token's EIP-712 `name` and `version`.
   *
   * Deployment data, not a constant: a token's domain differs per network, and
   * the digest a client signs its payment under is built from these. `assertDomains`
   * proves them against the deployed token at boot.
   */
  tokenDomain: { name: string; version: string };
}

export interface Config {
  /** JSON-RPC endpoint. `eth_getLogs` here is range-capped; the indexer chunks. */
  rpcUrl: string;
  /** Largest block span a single `eth_getLogs` call may request. */
  getLogsCap: number;
  dbUrl: string;
  /** Pays gas for every relayed op. Secret: environment only, never logged. */
  relayerKey: string;
  blockTimeMs: number;
  port: number;
  /**
   * The browser origins this node answers cross-origin requests from, in the
   * order they were given. Empty — the default — means **no `Access-Control-*`
   * header is ever sent**, so a deployment becomes browser-reachable only
   * because somebody said so.
   *
   * Exact origins, never patterns and never a reflection of whatever arrived:
   * an allowlist that echoes its input is not an allowlist. See
   * `src/api/cors.ts` for what is done with them.
   */
  corsOrigins: string[];
  /** How far the indexer may trail the head and still report ready. */
  readyLagBlocks: number;
  /**
   * The pinning service. **Required**, and there is exactly one.
   *
   * Both write doors mint a name inside the call that carries the bytes, so a
   * node with no store cannot accept a post or a settle — and it has nothing to
   * fall back to, because object storage is the only backend. Booting one that
   * answered `503` to every submission would be a worse failure than refusing to
   * start.
   */
  pinS3: S3PinConfig;
  /**
   * The largest batch input `POST /v1/files` accepts, and the largest object the
   * three file paths read back, in bytes.
   *
   * OpenAI's 200 MB by default. It is a setting rather than a constant because
   * it is the one ceiling an operator has a real reason to move: the door streams
   * the body to the store, so what a large upload still costs is the store's
   * bandwidth and the batch worker's own read — and a node sharing a machine may
   * want less of both. Lowering it refuses larger uploads at the door; it does
   * not orphan files already filed, because a file's bytes are named by its row.
   */
  maxBlobBytes: number;
  /**
   * How long an **attached** file lives, in seconds. 30 days by default.
   *
   * An upload nobody attaches is deleted 300 s after it was made
   * (`FILE_ORPHAN_SECONDS`); this is the clock the sweep gives a file once a job
   * or a batch names it, and the age past which a pinned object is removed
   * whatever named it. It is a setting because it is a storage bill an operator
   * pays and a window their clients read results in.
   */
  fileRetentionSeconds: number;
  /**
   * How many relays may be waiting on the relayer account at once (R76).
   *
   * The relayer's nonce is one counter, so `Chain.relay` is serial by physics
   * and latency is `queue_position × send_RTT`. 32 caps the queue wait at
   * 32 × 50 ms = 1.6 s at the send RTT R71 measured, well inside the 60 s
   * receipt budget the same doors already declare. Past it the door answers
   * `503 relay_unavailable`, retryable — a full queue is the node's condition
   * and never the caller's fault, so it is never a `400`.
   */
  relayMaxDepth: number;
  /**
   * How long an entry may **wait** in that queue before it leaves with the same
   * answer (R76).
   *
   * `RECEIPT_TIMEOUT_MS` covers only the receipt, *outside* the queue, so
   * without this a request can burn its whole budget having never been sent.
   * The deadline is armed while the entry waits and disarmed the instant its
   * turn arrives: it bounds the wait, never the send, because abandoning a send
   * already in flight would answer "retryable" for a transaction that is on the
   * wire.
   */
  relayQueueTimeoutMs: number;
  /**
   * The relayer balance, in gwei, under which the daily balance watch reports to
   * the error log. Gwei so the value stays a safe integer.
   */
  relayerLowBalanceGwei: number;
  /** The hosted escrow. `mode: "off"` unless an operator asks for otherwise. */
  escrow: EscrowConfig;
  /** The provider poll's leases and the challenge candidates. */
  match: MatchConfig;
  /** Jobs one wallet may post for one model in 24 hours; `0` is no limit. */
  jobRateLimit: number;
  addresses: Addresses;
}

/**
 * The matcher's knobs. Leases are advisory and the chain settles, so every one
 * of these tunes latency and fairness, never correctness.
 */
export interface MatchConfig {
  /** How long a provider poll holds a job before the next poller may take it. */
  leaseMs: number;
  /** How recently a provider must have polled to be named on a challenge. */
  livenessMs: number;
  /** How many clearing candidates a `402` names. */
  candidates: number;
}

const DEFAULTS = {
  RPC_URL: "http://localhost:8545",
  PIN_S3_REGION: "us-east-1",
} as const;

/**
 * The knobs that exist for development and CI and are refused anywhere else.
 *
 * Their own table, because a reader of the production config surface should be
 * able to see which variables are part of it. `loadEscrow` refuses every member
 * of this table outside `ESCROW_MODE=mock`, and `test/config.test.ts`
 * asserts that over the table rather than over one variable — so a second
 * dev-only knob cannot arrive without the guard that makes it one.
 *
 * P22: how far *forward* the escrow's key-lifecycle clock runs. The default is
 * the whole of its production value. The ceiling is a year, far past the 72 h
 * retention it exists to step over and small enough that a whole millisecond
 * timestamp typed in by mistake is refused rather than silently accepted as an
 * offset.
 */
export const DEV_ONLY_NUMERIC = {
  ESCROW_CLOCK_OFFSET_MS: { fallback: 0, min: 0, max: 31_536_000_000 },
} as const satisfies Record<string, { fallback: number; min: number; max: number }>;

/**
 * Each numeric env with its default and its admissible range. Ranges are real
 * constraints, not decoration: a `0` port binds an arbitrary ephemeral port, a
 * `0` getLogs cap makes the indexer request empty spans forever, and anything
 * past `MAX_SAFE_INTEGER` stops round-tripping through `Number`.
 *
 * **R78 lives here, and it is discharged by declaration.** A bound whose edge
 * cannot be moved by one without a test going red is not defended, and the
 * residual R78 carried was that edge tests had to be *written*: a brand-new
 * bound with a one-value hole left the whole suite green. Nothing has to be
 * written for a row in this table. `test/edges.test.ts` generates four
 * assertions per entry — `min` and `max` accepted, `min - 1` and `max + 1`
 * refused with the message that names the range — so adding a row here adds its
 * own edge tests. What that costs is that a row's `min`/`max` must be the real
 * bound and not a placeholder, because the test will assert exactly what is
 * written; state the reason for each in a comment, as every row below does.
 *
 * Exported for that test and for nothing else. There is no second name: an alias
 * would be one object under two exports, and its widened type would lose the
 * literal-key union `integer()` reads through `keyof typeof`.
 */
export const NUMERIC = {
  GETLOGS_CAP: { fallback: 5000, min: 1, max: 1_000_000 },
  // One Base block. It is the indexer's poll interval and the readiness cache's
  // TTL, so the default is the chain's own cadence: polling faster buys nothing
  // but requests, and polling slower is latency added to every job.
  BLOCK_TIME_MS: { fallback: 2000, min: 1, max: 3_600_000 },
  PORT: { fallback: 8402, min: 1, max: 65535 },
  // ≈14 s at 2 s blocks: enough that a poll that took a moment longer than the
  // block does not flap this node out of a load balancer, and short enough that
  // a ready node is one a client's next poll can be answered from.
  READY_LAG_BLOCKS: { fallback: 7, min: 0, max: 1_000_000 },
  // A `0` depth would refuse every relay, which closes every write door rather
  // than bounding it. The ceiling is where the bound stops meaning anything: at
  // the measured 50 ms send RTT, 4096 queued relays is a 3.4-minute wait, far
  // past any caller's tolerance and past this node's own receipt budget.
  RELAY_MAX_DEPTH: { fallback: 32, min: 1, max: 4096 },
  // Below ~1 ms the deadline would fire before a healthy send completes and no
  // relay would ever land; above the doors' own 60 s receipt budget it would
  // stop bounding anything the caller can still be waiting for.
  RELAY_QUEUE_TIMEOUT_MS: { fallback: 10_000, min: 1, max: 600_000 },
  // 0.05 ETH, which is weeks of testnet traffic. A mainnet node sets its own:
  // the watch reads once a day, so the floor has to hold several days of gas.
  RELAYER_LOW_BALANCE_GWEI: { fallback: 50_000_000, min: 1, max: 1_000_000_000_000 },
  // The image's release ordinal (P19). `0` is admissible — an ordinal is a
  // counter and a first release may well be numbered from zero — and the ceiling
  // is `uint16`, far past any plausible release count, so a typo of a whole
  // timestamp into this variable is refused rather than silently accepted as an
  // anti-rollback floor nothing can ever satisfy.
  RELEASE_ORDINAL: { fallback: 1, min: 0, max: 65_535 },
  // P20. Below a second the timer fires thousands of times to iterate a handful
  // of keys; past an hour the lateness it permits is a window a reader could
  // fairly describe as "keys survive their deadline".
  ESCROW_SWEEP_INTERVAL_MS: {
    fallback: ESCROW_SWEEP_INTERVAL_MS,
    min: 1000,
    max: 3_600_000,
  },
  // How often a fresh generation is minted, in milliseconds. 24 h.
  //
  // Rotation is what bounds the damage of a key that leaks: without it a single
  // generation backs every open order for the life of the process, and anything
  // that ever obtained it keeps opening new payloads forever. With it, a stolen
  // generation stops being useful for *new* work within a day and is erased
  // entirely a retention window later.
  //
  // The floor is an hour because every rotation opens a window — up to one
  // `PEER_SYNC_S` — in which a peer has not yet adopted the new generation,
  // and a rotation interval near the sync interval would leave a pair converging
  // for most of its life. The ceiling is a week: past that the knob has stopped
  // bounding anything a reader would recognise as rotation.
  ESCROW_ROTATE_INTERVAL_MS: {
    fallback: 86_400_000,
    min: 3_600_000,
    max: 604_800_000,
  },
  // How often a replica pulls from its peer, in **seconds** (the plan's unit).
  // Five minutes is the default: it is the bound on how long a generation minted
  // on one instance is unknown to the other, and against a 72 h retention that
  // window is negligible. Below 5 s two instances spend more time exchanging the
  // same key set than serving; past a day the pair has stopped being a pair.
  PEER_SYNC_S: { fallback: 300, min: 5, max: 86_400 },
  // The batch input ceiling. The default is OpenAI's 200 MB, in MiB, so no file
  // their API takes is refused here. The floor is one line of JSONL and the
  // ceiling is where the **line** cap binds first for any plausible line, which
  // is what stops this from being set to a number that makes `MAX_BATCH_LINES`
  // decorative. See `MAX_BLOB_BYTES`.
  MAX_BLOB_BYTES: { fallback: 200 * 1024 * 1024, min: 1024, max: 1024 * 1024 * 1024 },
  // How long an attached file lives, in seconds. 30 days is long enough that a
  // client reads its results back on its own schedule.
  //
  // The floor is three days, because the sweep removes an object past retention
  // whatever names it, and the longest a container can still be owed to a live
  // job is not one expiry window but the sum of four: a job posted at `t` may
  // expire at `t + MAX_EXPIRY_SECONDS` (86 400), be claimed one second before
  // that and carry `slaSecs` up to `MAX_SLA_SECONDS` (86 400), so its provider
  // must be able to fetch the container until ≈ `t + 172 799`; and on the
  // upload-first path the pin's `created_at` is the upload, up to
  // `FILE_ORPHAN_SECONDS` (300) before the post. 173 099 s is the bound, and
  // 259 200 clears it with a day to spare. The ceiling is a year, past which
  // this bounds nothing.
  FILE_RETENTION_SECONDS: { fallback: 2_592_000, min: 259_200, max: 31_536_000 },
  // A lease must outlive a daemon poll interval plus the claim round trip; past
  // ten minutes an abandoned lease hides a job for longer than a short SLA.
  MATCH_LEASE_MS: { fallback: 20_000, min: 1000, max: 600_000 },
  // Presence must survive at least one poll interval; past ten minutes a dead
  // daemon keeps receiving leases nothing will claim.
  MATCH_LIVENESS_MS: { fallback: 15_000, min: 1000, max: 600_000 },
  // One candidate is the minimum answer; 100 is more than any client tries
  // before re-quoting.
  MATCH_CANDIDATES: { fallback: 3, min: 1, max: 100 },
  // Jobs one wallet may post for one model in 24 hours. `0`, the default, is no
  // limit. The ceiling is past anything a wallet posts one job at a time.
  JOB_RATE_LIMIT: { fallback: 0, min: 0, max: 1_000_000 },
  // Merged in rather than listed here, so `integer()` reaches every declared
  // variable through one table while the production surface above stays
  // readable as the production surface.
  ...DEV_ONLY_NUMERIC,
} as const satisfies Record<string, { fallback: number; min: number; max: number }>;

/** The escrow modes this build implements. Anything else is a refusal to start. */
const ESCROW_MODES: readonly EscrowMode[] = ["off", "mock", "static"];

/** Required, as a group. Declaration order is the order the failure message reports in. */
const S3_GROUP = [
  "PIN_S3_ENDPOINT",
  "PIN_S3_KEY",
  "PIN_S3_SECRET",
  "PIN_S3_BUCKET",
] as const;

function read(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

/**
 * A boolean knob: absent is `false`, and anything outside the accepted spellings
 * is refused by name.
 *
 * The refusal is the point. The usual `value === "true"` idiom reads `"1"`,
 * `"yes"` and a typo'd `"ture"` all as `false`, so an operator who meant to turn
 * something on gets the off behaviour and no signal — which for
 * `PEER_REQUIRED` is precisely the silent fresh-boot this build exists to
 * prevent.
 */
function flag(env: Env, name: string): boolean {
  const value = read(env, name);
  if (value === undefined) return false;
  const lowered = value.toLowerCase();
  if (lowered === "1" || lowered === "true") return true;
  if (lowered === "0" || lowered === "false") return false;
  throw new Error(`${name} must be one of 1, 0, true, false, got "${value}"`);
}

function integer(env: Env, name: keyof typeof NUMERIC): number {
  const { fallback, min, max } = NUMERIC[name];
  const value = read(env, name);
  if (value === undefined) return fallback;

  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got "${value}"`);
  }
  return parsed;
}

/**
 * The pinning service, or a refusal to start.
 *
 * The group used to be optional — absent selected a local pinner that filed
 * bytes in Postgres. That pinner is gone and pinning is on the request path of
 * both write doors, so an absent group is no longer a choice of backend; it is a
 * node that cannot accept work. The message names every missing variable at once
 * rather than the first, because an operator configuring this reads the failure
 * once and sets four things.
 */
function loadS3(env: Env): S3PinConfig {
  const missing = S3_GROUP.filter((name) => read(env, name) === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required: this node pins the ` +
        "container inside POST /v1/jobs and the result inside POST /evm/ops, so without an " +
        "object store it can accept neither",
    );
  }

  return {
    endpoint: required(env, "PIN_S3_ENDPOINT"),
    key: required(env, "PIN_S3_KEY"),
    secret: required(env, "PIN_S3_SECRET"),
    bucket: required(env, "PIN_S3_BUCKET"),
    region: read(env, "PIN_S3_REGION") ?? DEFAULTS.PIN_S3_REGION,
  };
}

/**
 * The escrow's configuration, defaulting to a node that hosts no escrow.
 *
 * **Off by default, and the default is the security property.** A node that
 * defaulted to `mock` would serve forgeable evidence — and, once Task 5 lands,
 * its whole key set to any caller — the first time somebody deployed one without
 * reading the documentation. Turning the escrow on is therefore an explicit act.
 *
 * An unrecognised mode is refused by name rather than falling back to `off`: an
 * operator who typed `snp` believing this build attested anything would
 * otherwise get a silently escrow-less node and no signal at all.
 */
function loadEscrow(env: Env): EscrowConfig {
  const raw = read(env, "ESCROW_MODE") ?? "off";
  if (!ESCROW_MODES.includes(raw as EscrowMode)) {
    throw new Error(
      `ESCROW_MODE must be one of ${ESCROW_MODES.join(", ")}, got "${raw}". ` +
        "mock is dev/CI only: mock evidence is computable by anyone, so a mock-mode node " +
        "must never be internet-exposed.",
    );
  }

  const peerUrl = peerOrigin(env, "PEER_URL");
  const peerRequired = flag(env, "PEER_REQUIRED");
  // "The first pull must succeed" says nothing without somewhere to pull from,
  // and the difference matters: an operator who set only this one is asking for a
  // boot-critical inheritance and would instead get a node that mints fresh keys
  // and inherits nothing — the exact silent failure the flag exists to prevent.
  if (peerRequired && peerUrl === null) {
    throw new Error(
      "PEER_REQUIRED needs PEER_URL: it makes the first pull from a peer a " +
        "boot-critical dependency, and there is no peer set to pull from.",
    );
  }

  // **One key, both directions.** The escrow fleet shares a single operator
  // credential: a joiner signs its pull with it, and a holder authenticates that
  // pull by recovering to the address of the very same key. So any node that
  // holds escrow keys needs one, not just the nodes that pull — a holder without
  // it could authenticate nothing and would have to refuse every handover, which
  // is a cutover that fails at the worst possible moment rather than at boot.
  //
  // At `off` the escrow doors refuse categorically and no key is ever minted, so
  // there is nothing to authenticate and nothing to require.
  //
  // Comma-separated: the first signs, every one is accepted. See the field's
  // docblock for why a list is the thing that makes rotation possible at all.
  const operatorKeys = (read(env, "OPERATOR_KEY") ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  if (raw !== "off" && operatorKeys.length === 0) {
    throw new Error(
      raw === "static"
        ? "OPERATOR_KEY is required at ESCROW_MODE=static: the escrow key is derived from it, " +
          "so a node without one has no key to announce and nothing to open a wrap with."
        : "OPERATOR_KEY is required whenever this node holds escrow keys. POST /handover " +
          "releases the whole held key set, and the operator signature is what says the caller " +
          "is a deployment this network stood up rather than a stranger running the same image. " +
          "A node without the key can neither pull from a peer nor authenticate one.",
    );
  }
  // Shape only, and **by position rather than by value**: a loader that quoted a
  // malformed key would put a private key one typo away from a log line, and a
  // redacted log is not a recalled one. Checked here rather than at first use so
  // a bad second entry fails the boot instead of the first rotation cutover.
  operatorKeys.forEach((key, index) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(
        `OPERATOR_KEY entry ${index + 1} is not a 32-byte secp256k1 private key: expected ` +
          "0x followed by 64 hex characters. Its value is deliberately not repeated here.",
      );
    }
  });

  // Two refusals at `static`, and both are about knobs that would silently do
  // nothing. **Presence is read off the raw environment, never off the resolved
  // value**: `integer()` returns a fallback for an unset variable and `flag()`
  // answers `false` for both "unset" and "explicitly false", so a check written
  // against either could not tell a configured knob from an absent one.
  //
  // `ESCROW_CLOCK_OFFSET_MS` is deliberately not here: the DEV_ONLY_NUMERIC
  // guard below is written against `raw !== "mock"` and already refuses it at
  // this mode. One variable, one refusal.
  if (raw === "static") {
    if (read(env, "PEER_URL") !== undefined || read(env, "PEER_REQUIRED") !== undefined) {
      throw new Error(
        "ESCROW_MODE=static refuses PEER_URL and PEER_REQUIRED: the escrow key is derived from " +
          "OPERATOR_KEY, so every instance already holds the same key set and POST /handover is " +
          "refused. A peer link that silently did nothing would be a cutover an operator " +
          "believes in and does not have.",
      );
    }
    const lifecycle = ["ESCROW_ROTATE_INTERVAL_MS", "ESCROW_SWEEP_INTERVAL_MS"].filter(
      (name) => read(env, name) !== undefined,
    );
    if (lifecycle.length > 0) {
      throw new Error(
        `ESCROW_MODE=static refuses ${lifecycle.join(" and ")}: a derived key set never rotates, ` +
          "never decays and is never swept, so a tuned interval would never fire and would read " +
          "as a configured lifecycle.",
      );
    }
  }

  // Dev-only, and gated on the dev-only mode so it cannot follow an operator into
  // an attested deployment. The guard reads as "not at mock" — `static` holds
  // keys too, so it is not merely "not at mode off".
  const clockOffsetMs = integer(env, "ESCROW_CLOCK_OFFSET_MS");
  if (clockOffsetMs !== 0 && raw !== "mock") {
    throw new Error(
      "ESCROW_CLOCK_OFFSET_MS is a development-only knob that runs this node's escrow " +
        "key-retention clock forward, and it requires ESCROW_MODE=mock. A non-zero offset " +
        "erases key material early by design.",
    );
  }

  return {
    mode: raw as EscrowMode,
    releaseOrdinal: integer(env, "RELEASE_ORDINAL"),
    sweepIntervalMs: integer(env, "ESCROW_SWEEP_INTERVAL_MS"),
    peerUrl,
    peerRequired,
    peerSyncMs: integer(env, "PEER_SYNC_S") * 1000,
    rotateIntervalMs: integer(env, "ESCROW_ROTATE_INTERVAL_MS"),
    operatorKeys,
    clockOffsetMs,
  };
}

/**
 * A peer's base URL, or `null`, refusing anything that is not an http(s) origin.
 *
 * Checked here rather than at the first request because the failure is otherwise
 * invisible until a sync tick five minutes into the process's life, by which time
 * the operator has moved on. `http:`/`https:` only — the transport is `fetch`,
 * and a `file:` or `ftp:` URL would fail in a way that looks like a dead peer.
 */
function peerOrigin(env: Env, name: string): string | null {
  const value = read(env, name);
  if (value === undefined) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  }
  // The peer link is not authenticated by the handover protocol itself; it must
  // be an authenticated transport or a private network. README.md says so where
  // an operator sets this.
  return value.replace(/\/+$/, "");
}

/**
 * The browser origins this node answers cross-origin requests from, or none.
 *
 * Comma-separated, first-to-last, exactly as `OPERATOR_KEY` is — one list idiom
 * in this file rather than two. Unset or blank yields an empty list, which
 * `registerCors` reads as "register nothing at all".
 *
 * Every entry is checked to be an exact, bare, http(s) origin **and nothing
 * more**, and each check below says what it is refusing and why. What they have
 * in common is the reason they are checks at all: an entry that is not exactly
 * the string a browser puts in its `Origin` header is not a loud error anywhere.
 * This node matches by equality, so such an entry simply never matches, no
 * `Access-Control-*` header is ever sent for it, and the node reads from the
 * outside exactly like one where CORS was never configured — the failure is
 * invisible in every log, invisible outside a browser, and indistinguishable
 * from having forgotten the variable entirely. A wildcard is the same failure
 * pointed the other way: a pattern matches nothing here, and the one shape that
 * could match everything is the posture this variable exists to avoid.
 *
 * So all of it is refused at boot rather than at the first cross-origin request,
 * which is the only moment the mistake is still in front of the person who made
 * it. A refusal to start is a bad minute; the alternative is a deployment that
 * looks configured, answers every browser call by omission, and gets debugged
 * from the wrong end.
 */
function loadCorsOrigins(env: Env): string[] {
  const origins = (read(env, "CORS_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  for (const origin of origins) {
    if (origin === "*") {
      throw new Error(
        'CORS_ORIGINS is an allowlist and does not accept "*": a wildcard answers every page ' +
          "on the internet, and this node's browser callers are known by name. List them.",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `CORS_ORIGINS entry "${origin}" is not an origin: expected scheme://host[:port], ` +
          'such as "https://app.vorq.co" or "http://localhost:3000".',
      );
    }

    // A browser's `Origin` on an HTTP request is always `http` or `https`, so
    // any other scheme names a caller that cannot arrive. `ws:`, `wss:` and
    // `ftp:` are the ones that get here: they are "special" schemes, so their
    // `URL.origin` is a real tuple and round-trips unchanged through the check
    // below — the entry would sit in the allowlist looking correct and match
    // nothing forever. `peerOrigin` above refuses the same set for the same
    // reason; this is that rule, applied to the door browsers knock on.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        `CORS_ORIGINS entry "${origin}" is not an http(s) origin: a browser's Origin header ` +
          `carries only http or https, never "${parsed.protocol}", so this entry could never ` +
          "match a request.",
      );
    }

    // The wildcard subdomain, refused explicitly because nothing else here can
    // see it. `*` is not a forbidden host code point in WHATWG URL, so
    // `new URL("https://*.vorq.co").origin` returns that string back unchanged
    // and the comparison below passes it as a well-formed origin. It is also the
    // likelier of the two wildcard mistakes — it is the idiom carried over from
    // nginx and from the `cors` middleware, both of which expand patterns — and
    // refusing bare `*` while accepting this one would refuse the rare error and
    // wave through the common one. This node matches origins by equality, so a
    // pattern matches nothing and reads, from a browser, exactly like CORS that
    // was never configured. Name each subdomain that needs in.
    if (parsed.hostname.includes("*")) {
      throw new Error(
        `CORS_ORIGINS entry "${origin}" has a wildcard host: this allowlist is compared by ` +
          "equality against the Origin header, so a pattern never matches and CORS would " +
          "appear never to have been configured. List each origin in full.",
      );
    }

    // Compared against `URL.origin` rather than pattern-matched: that property
    // is the browser's own definition of the string it will put in the `Origin`
    // header, so this asserts the entry can match at all.
    if (parsed.origin !== origin) {
      throw new Error(
        `CORS_ORIGINS entry "${origin}" is not an origin: expected "${parsed.origin}", with no ` +
          "path and no trailing slash. A browser's Origin header carries neither, so an entry " +
          "that has one could never match and CORS would appear never to have been configured.",
      );
    }
  }

  return origins;
}

/**
 * The address book's two spellings, and where each belongs.
 *
 * `ADDRESSES_FILE` is what a devnet boot publishes and what the harnesses point
 * at — a path on disk. `ADDRESSES_JSON` is the same object inline, for platforms
 * that serve configuration as environment and have nowhere to put a file
 * (Railway, Heroku, a bare `docker run`). One deployment uses one of them.
 *
 * **Both set is a refusal, not a precedence rule.** A silent winner is the kind
 * of thing that has an operator editing the file for an hour while the process
 * reads the variable.
 */
function addressSource(env: Env): { json: string; origin: string } {
  const inline = read(env, "ADDRESSES_JSON");
  const path = read(env, "ADDRESSES_FILE");

  if (inline !== undefined && path !== undefined) {
    throw new Error(
      "ADDRESSES_JSON and ADDRESSES_FILE are both set: pick one. The first is the " +
        "address book inline, the second a path to it — a node that honoured one " +
        "silently would leave the other looking like it was in effect.",
    );
  }
  if (inline !== undefined) return { json: inline, origin: "ADDRESSES_JSON" };
  if (path === undefined) {
    throw new Error(
      "ADDRESSES_JSON or ADDRESSES_FILE is required: this node needs the deployment's " +
        "chain id and its four contract addresses before it can read anything.",
    );
  }
  try {
    return { json: readFileSync(path, "utf8"), origin: `ADDRESSES_FILE (${path})` };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`ADDRESSES_FILE (${path}): cannot read — ${reason}`);
  }
}

/**
 * Reads the addresses a devnet boot publishes, or the same object handed over
 * inline. The book carries more keys than this node needs; only the consumed
 * ones are lifted out, so an unrelated key changing shape can never reach the
 * rest of the service.
 *
 * Every refusal names `origin`, so the message says which variable to go and fix
 * rather than describing a shape.
 */
function loadAddresses(env: Env): Addresses {
  const { json, origin } = addressSource(env);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${origin}: not valid JSON — ${reason}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${origin}: expected a JSON object`);
  }
  const file = parsed as Record<string, unknown>;

  const chainId = file.chainId;
  if (typeof chainId !== "number" || !Number.isInteger(chainId)) {
    throw new Error(
      chainId === undefined
        ? `${origin}: missing key "chainId"`
        : `${origin}: key "chainId" must be an integer`,
    );
  }

  // Every whole number the book carries, bounded: `paymentTokenDecimals` past 36
  // is not a token's decimals and `deployBlock` past `MAX_SAFE_INTEGER` stops
  // round-tripping through `Number`.
  const wholeNumber = (key: string, max: number): number => {
    const value = file[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(
        value === undefined ? `${origin}: missing key "${key}"` : `${origin}: key "${key}" must be an integer in 0..${max}`,
      );
    }
    return value;
  };

  // The payment token's domain, and it is **required**: a defaulted name or
  // version would build a digest the deployed token does not accept, and the
  // failure is invisible until a provider's claim reverts inside the token.
  const domain = file.tokenDomain;
  if (typeof domain !== "object" || domain === null || Array.isArray(domain)) {
    throw new Error(`${origin}: missing key "tokenDomain"`);
  }
  const domainText = (key: "name" | "version"): string => {
    const value = (domain as Record<string, unknown>)[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`${origin}: key "tokenDomain.${key}" must be a non-empty string`);
    }
    return value;
  };

  // Spelled out field by field rather than looped over a key list: the object
  // literal is checked against `Addresses`, so adding or renaming a field there
  // without teaching the reader about it is a compile error, not a silent gap.
  const address = (
    key: "jobRegistry" | "providerRegistry" | "askRegistry" | "usdc",
  ): Address => {
    const value = file[key];
    if (value === undefined) {
      throw new Error(`${origin}: missing key "${key}"`);
    }
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error(`${origin}: key "${key}" must be a 20-byte hex address`);
    }
    return value as Address;
  };

  return {
    chainId,
    deployBlock: wholeNumber("deployBlock", Number.MAX_SAFE_INTEGER),
    jobRegistry: address("jobRegistry"),
    providerRegistry: address("providerRegistry"),
    askRegistry: address("askRegistry"),
    usdc: address("usdc"),
    decimals: wholeNumber("paymentTokenDecimals", 36),
    tokenDomain: { name: domainText("name"), version: domainText("version") },
  };
}

/**
 * Builds the node's configuration from an environment, failing loudly and by
 * name on anything missing or malformed. Called once at boot.
 */
export function loadConfig(env: Env = process.env): Config {
  return {
    rpcUrl: read(env, "RPC_URL") ?? DEFAULTS.RPC_URL,
    getLogsCap: integer(env, "GETLOGS_CAP"),
    dbUrl: required(env, "DATABASE_URL"),
    relayerKey: required(env, "RELAYER_KEY"),
    blockTimeMs: integer(env, "BLOCK_TIME_MS"),
    port: integer(env, "PORT"),
    corsOrigins: loadCorsOrigins(env),
    readyLagBlocks: integer(env, "READY_LAG_BLOCKS"),
    pinS3: loadS3(env),
    maxBlobBytes: integer(env, "MAX_BLOB_BYTES"),
    fileRetentionSeconds: integer(env, "FILE_RETENTION_SECONDS"),
    relayMaxDepth: integer(env, "RELAY_MAX_DEPTH"),
    relayQueueTimeoutMs: integer(env, "RELAY_QUEUE_TIMEOUT_MS"),
    relayerLowBalanceGwei: integer(env, "RELAYER_LOW_BALANCE_GWEI"),
    escrow: loadEscrow(env),
    match: {
      leaseMs: integer(env, "MATCH_LEASE_MS"),
      livenessMs: integer(env, "MATCH_LIVENESS_MS"),
      candidates: integer(env, "MATCH_CANDIDATES"),
    },
    jobRateLimit: integer(env, "JOB_RATE_LIMIT"),
    addresses: loadAddresses(env),
  };
}
