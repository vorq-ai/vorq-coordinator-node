import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES } from "../src/api/routes/files.js";
import { DEV_ONLY_NUMERIC, loadConfig } from "../src/config.js";

const ADDRESSES_FIXTURE = fileURLToPath(new URL("./fixtures/addresses.json", import.meta.url));

/** The three variables that were always required; everything else falls back. */
const core = {
  DATABASE_URL: "postgres://vorq:vorq@localhost:5433/vorq",
  RELAYER_KEY: `0x${"11".repeat(32)}`,
  ADDRESSES_FILE: ADDRESSES_FIXTURE,
};

/**
 * The pinning service, which is **no longer optional**.
 *
 * It used to be a choice of backend: absent selected a pinner that filed bytes in
 * Postgres. That pinner is gone and both write doors mint a name inside the call
 * that carries the bytes, so a node without a store cannot accept a post or a
 * settle at all — and one that booted anyway would answer `503` to every
 * submission, which is a worse failure than refusing to start.
 */
const s3 = {
  PIN_S3_ENDPOINT: "https://pin.example.invalid",
  PIN_S3_KEY: "key-id",
  PIN_S3_SECRET: "secret-value",
  PIN_S3_BUCKET: "vorq-pins",
};

/** Everything `loadConfig` will not start without. */
const required = { ...core, ...s3 };

describe("loadConfig defaults", () => {
  it("applies every documented default when only the required vars are set", () => {
    const cfg = loadConfig(required);

    expect(cfg.port).toBe(8402);
    expect(cfg.getLogsCap).toBe(5000);
    expect(cfg.rpcUrl).toBe("http://localhost:8545");
    expect(cfg.blockTimeMs).toBe(2000);
    expect(cfg.readyLagBlocks).toBe(7);
    // R76: the relayer account is one nonce sequence, so relays are serial by
    // physics. 32 caps the queue wait at 32 x 50 ms of send RTT, and 10 s caps
    // how long one entry may wait before it leaves without being sent.
    expect(cfg.relayMaxDepth).toBe(32);
    expect(cfg.relayQueueTimeoutMs).toBe(10_000);
    expect(cfg.relayerLowBalanceGwei).toBe(50_000_000);
    // OpenAI's 200 MB batch-input ceiling, which is what an unconfigured node
    // must offer: a deviation from it is a client-visible difference, so it has
    // to be something an operator chose rather than something they inherited.
    expect(cfg.maxBlobBytes).toBe(MAX_BLOB_BYTES);
    expect(cfg.maxBlobBytes).toBeGreaterThanOrEqual(200_000_000);
    // 30 days for an attached file. An unattached upload has its own constant
    // (`FILE_ORPHAN_SECONDS`) and is not a setting.
    expect(cfg.fileRetentionSeconds).toBe(2_592_000);
    // The matcher: a 20 s lease (four default daemon polls), presence live for
    // three polls, and three candidates on a challenge.
    expect(cfg.match).toEqual({ leaseMs: 20_000, livenessMs: 15_000, candidates: 3 });
  });

  it("refuses a relay depth or wait of zero, which would close every write door (R76)", () => {
    expect(() => loadConfig({ ...required, RELAY_MAX_DEPTH: "0" })).toThrow(
      /RELAY_MAX_DEPTH must be an integer in \[1, 4096\]/,
    );
    expect(() => loadConfig({ ...required, RELAY_QUEUE_TIMEOUT_MS: "0" })).toThrow(
      /RELAY_QUEUE_TIMEOUT_MS must be an integer in \[1, 600000\]/,
    );
    const cfg = loadConfig({
      ...required,
      RELAY_MAX_DEPTH: "8",
      RELAY_QUEUE_TIMEOUT_MS: "2500",
      RELAYER_LOW_BALANCE_GWEI: "2000000000",
    });
    expect(cfg.relayMaxDepth).toBe(8);
    expect(cfg.relayQueueTimeoutMs).toBe(2500);
    expect(cfg.relayerLowBalanceGwei).toBe(2_000_000_000);
  });

  it("carries the required vars through verbatim", () => {
    const cfg = loadConfig(required);

    expect(cfg.dbUrl).toBe(required.DATABASE_URL);
    expect(cfg.relayerKey).toBe(required.RELAYER_KEY);
    // The address book is consumed, not carried: `ADDRESSES_FILE` is read at boot
    // and only the four addresses survive into the config.
    expect(cfg.addresses.chainId).toBe(84532);
  });

  it("parses numeric overrides as numbers, not strings", () => {
    const cfg = loadConfig({
      ...required,
      PORT: "9000",
      GETLOGS_CAP: "1000",
      BLOCK_TIME_MS: "12000",
      READY_LAG_BLOCKS: "2",
      RPC_URL: "http://chain.internal:8545",
    });

    expect(cfg.port).toBe(9000);
    expect(cfg.getLogsCap).toBe(1000);
    expect(cfg.blockTimeMs).toBe(12000);
    expect(cfg.readyLagBlocks).toBe(2);
    expect(cfg.rpcUrl).toBe("http://chain.internal:8545");
  });

  it("rejects a non-numeric override, naming the variable and its range", () => {
    expect(() => loadConfig({ ...required, PORT: "8402x" })).toThrow(
      'PORT must be an integer in [1, 65535], got "8402x"',
    );
  });

  it("rejects an out-of-range port at both ends", () => {
    expect(() => loadConfig({ ...required, PORT: "0" })).toThrow(
      'PORT must be an integer in [1, 65535], got "0"',
    );
    expect(() => loadConfig({ ...required, PORT: "65536" })).toThrow(
      'PORT must be an integer in [1, 65535], got "65536"',
    );
  });

  it("rejects a getLogs cap of zero, which would stall the indexer", () => {
    expect(() => loadConfig({ ...required, GETLOGS_CAP: "0" })).toThrow(
      'GETLOGS_CAP must be an integer in [1, 1000000], got "0"',
    );
  });

  it("still accepts zero where zero is meaningful", () => {
    const cfg = loadConfig({ ...required, READY_LAG_BLOCKS: "0" });

    expect(cfg.readyLagBlocks).toBe(0);
  });

  it("rejects a missing required variable, naming it", () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = required;

    expect(() => loadConfig(withoutDb)).toThrow("DATABASE_URL is required");
  });
});

describe("loadConfig S3 pinner group", () => {
  it("is populated from the group, defaulting the region", () => {
    const cfg = loadConfig(required);

    expect(cfg.pinS3).toEqual({
      endpoint: s3.PIN_S3_ENDPOINT,
      key: s3.PIN_S3_KEY,
      secret: s3.PIN_S3_SECRET,
      bucket: s3.PIN_S3_BUCKET,
      region: "us-east-1",
    });
  });

  it("honours an explicit region", () => {
    const cfg = loadConfig({ ...required, PIN_S3_REGION: "eu-central-1" });

    expect(cfg.pinS3.region).toBe("eu-central-1");
  });

  /**
   * **The group is required, and this is the test that says so.**
   *
   * The fail-open mutation is making `loadS3` answer `null` for an absent group
   * again: the node then boots with no store and answers `503 pinner_unavailable`
   * to every post and every settle, which looks like an outage of somebody else's
   * dependency rather than a node that was never configured. This goes red.
   */
  it("refuses to start with no pinning service at all, naming every missing variable", () => {
    expect(() => loadConfig(core)).toThrow(
      "PIN_S3_ENDPOINT, PIN_S3_KEY, PIN_S3_SECRET, PIN_S3_BUCKET are " +
        "required: this node pins the container inside POST /v1/jobs and the result inside " +
        "POST /evm/ops, so without an object store it can accept neither",
    );
  });

  it("names the one variable that is missing, and says so in the singular", () => {
    const { PIN_S3_SECRET: _omitted, ...partial } = required;

    expect(() => loadConfig(partial)).toThrow(/^PIN_S3_SECRET is required: /);
  });

  it("does not accept the optional region in place of the group", () => {
    // The region has a default, so it is not membership: a node configured with
    // nothing but a region is a node with no store.
    expect(() => loadConfig({ ...core, PIN_S3_REGION: "eu-central-1" })).toThrow(
      /PIN_S3_ENDPOINT, PIN_S3_KEY, PIN_S3_SECRET, PIN_S3_BUCKET are required/,
    );
  });
});

describe("loadConfig addresses", () => {
  it("parses the eight consumed keys out of the addresses file", () => {
    const cfg = loadConfig(required);

    expect(cfg.addresses).toEqual({
      chainId: 84532,
      deployBlock: 47121001,
      jobRegistry: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      providerRegistry: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      askRegistry: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      tokenDomain: { name: "USDC", version: "2" },
    });
  });

  it("keeps chainId numeric and drops the keys it does not consume", () => {
    const cfg = loadConfig(required);

    expect(typeof cfg.addresses.chainId).toBe("number");
    expect(Object.keys(cfg.addresses)).not.toContain("deployer");
  });

  /**
   * The payment token's domain and its decimals are **required**, never
   * defaulted. Both are network data: `name`/`version` are what every payment
   * authorization is signed under, and a node that guessed them would quote a
   * digest the token refuses inside the claim. The decimals are what a client
   * renders an amount with, and a wrong one is off by orders of magnitude with
   * nothing anywhere saying so.
   */
  it.each([
    ["tokenDomain", (book: Record<string, unknown>) => delete book.tokenDomain, /missing key "tokenDomain"/],
    [
      "tokenDomain.name",
      (book: Record<string, unknown>) => {
        book.tokenDomain = { name: "", version: "2" };
      },
      /key "tokenDomain.name" must be a non-empty string/,
    ],
    [
      "paymentTokenDecimals",
      (book: Record<string, unknown>) => {
        book.paymentTokenDecimals = 6.5;
      },
      /key "paymentTokenDecimals" must be an integer in 0\.\.36/,
    ],
    ["deployBlock", (book: Record<string, unknown>) => delete book.deployBlock, /missing key "deployBlock"/],
    [
      // The replay's lower bound is the book's now, and a block past the safe
      // range stops round-tripping through `Number` rather than rounding.
      "deployBlock past the safe-integer range",
      (book: Record<string, unknown>) => {
        book.deployBlock = 9_007_199_254_740_993;
      },
      /key "deployBlock" must be an integer in 0\.\.9007199254740991/,
    ],
  ] as const)("refuses an address book whose %s is wrong", (_name, damage, message) => {
    const book = JSON.parse(readFileSync(ADDRESSES_FIXTURE, "utf8")) as Record<string, unknown>;
    damage(book);
    const { ADDRESSES_FILE: _path, ...inline } = required;

    expect(() => loadConfig({ ...inline, ADDRESSES_JSON: JSON.stringify(book) })).toThrow(message);
  });

  it("reports an unreadable addresses file by path", () => {
    const missing = fileURLToPath(new URL("./fixtures/does-not-exist.json", import.meta.url));

    expect(() => loadConfig({ ...required, ADDRESSES_FILE: missing })).toThrow(
      `ADDRESSES_FILE (${missing}): cannot read`,
    );
  });

  it("reports a missing key in the addresses file by name", () => {
    const truncated = fileURLToPath(
      new URL("./fixtures/addresses-missing-key.json", import.meta.url),
    );

    expect(() => loadConfig({ ...required, ADDRESSES_FILE: truncated })).toThrow(
      `ADDRESSES_FILE (${truncated}): missing key "askRegistry"`,
    );
  });
});

/**
 * `ADDRESSES_JSON` — the same address book inline, for a platform that serves
 * configuration as environment and has nowhere to put a file.
 */
describe("loadConfig addresses, inline", () => {
  const { ADDRESSES_FILE: _path, ...inline } = required;
  const book = readFileSync(ADDRESSES_FIXTURE, "utf8");

  it("reads the same book from ADDRESSES_JSON as from the file", () => {
    const fromEnv = loadConfig({ ...inline, ADDRESSES_JSON: book });

    expect(fromEnv.addresses).toEqual(loadConfig(required).addresses);
  });

  it("refuses both spellings rather than picking a winner silently", () => {
    expect(() => loadConfig({ ...required, ADDRESSES_JSON: book })).toThrow(
      /ADDRESSES_JSON and ADDRESSES_FILE are both set/,
    );
  });

  it("refuses neither spelling, naming both", () => {
    expect(() => loadConfig(inline)).toThrow(/ADDRESSES_JSON or ADDRESSES_FILE is required/);
  });

  it("reports malformed inline JSON against the variable, not a path", () => {
    expect(() => loadConfig({ ...inline, ADDRESSES_JSON: "{not json" })).toThrow(
      /ADDRESSES_JSON: not valid JSON/,
    );
  });

  it("reports a missing key against the variable", () => {
    const withoutAsks = JSON.parse(book) as Record<string, unknown>;
    delete withoutAsks.askRegistry;

    expect(() =>
      loadConfig({ ...inline, ADDRESSES_JSON: JSON.stringify(withoutAsks) }),
    ).toThrow('ADDRESSES_JSON: missing key "askRegistry"');
  });
});

/**
 * `ESCROW_CLOCK_OFFSET_MS` — the development-only seam Task 7's decay
 * scenario needs (P22), and the guard that keeps it out of anything else.
 */
describe("loadConfig escrow clock offset", () => {
  it("defaults to no offset at all", () => {
    expect(loadConfig(required).escrow.clockOffsetMs).toBe(0);
  });

  it("carries an offset through at mode mock", () => {
    const cfg = loadConfig({
      ...required,
      ESCROW_MODE: "mock",
      OPERATOR_KEY: `0x${"d4".repeat(32)}`,
      ESCROW_CLOCK_OFFSET_MS: "262800000",
    });
    expect(cfg.escrow.clockOffsetMs).toBe(262_800_000);
  });

  it("refuses a non-zero offset outside mode mock", () => {
    expect(() =>
      loadConfig({ ...required, ESCROW_CLOCK_OFFSET_MS: "1000" }),
    ).toThrow(/development-only knob/);
  });

  it("accepts an explicit zero at any mode, so the variable can be pinned off", () => {
    expect(
      loadConfig({ ...required, ESCROW_CLOCK_OFFSET_MS: "0" }).escrow.clockOffsetMs,
    ).toBe(0);
  });
});

/**
 * **Parsing a config must not load a native crypto addon.**
 *
 * `src/config.ts` imported `ESCROW_SWEEP_INTERVAL_MS` from `./escrow/keys.js`,
 * whose first line is `import sodium from "sodium-native"`. Nothing was broken
 * by that and there was no cycle — but config parsing is the first thing every
 * entry point does, so `--help`, this test file, and a boot that fails on a
 * missing env var all needed libsodium present and loadable before they could
 * report anything.
 *
 * Asserted against this file's own source text, and against the one edge that
 * actually carried the addon in. A general "nothing native is reachable from
 * here" claim would mean walking the import graph, which from inside vitest
 * means hand-parsing TypeScript — a regex that misses `export * from`, dynamic
 * `import()` and a specifier on its own line, and therefore a check that can go
 * green while the property is false. The regression worth catching is somebody
 * reaching back into `escrow/keys.js` for a constant, and that is one string.
 *
 * The two assertions below are the other half and the load-bearing half: the
 * constant is still *read* rather than restated, and the five windows are still
 * importable where they were.
 */
describe("src/config.ts's module graph", () => {
  it("does not import escrow/keys.js, whose first line loads the addon", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/config.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain('from "./escrow/keys.js"');
  });

  it("still reads the sweep interval from the one place it is written", async () => {
    // The import existed for a reason and the reason survives: the default and
    // the constant must be the same number, and duplicating it into config.ts is
    // exactly the drift P20 was ruled to prevent.
    const { ESCROW_SWEEP_INTERVAL_MS } = await import("../src/escrow/windows.js");
    expect(loadConfig(required).escrow.sweepIntervalMs).toBe(ESCROW_SWEEP_INTERVAL_MS);
  });

  it("keeps every window importable from escrow/keys.js, where they were", async () => {
    // Re-exported rather than moved out from under the four existing importers.
    const keys = await import("../src/escrow/keys.js");
    const windows = await import("../src/escrow/windows.js");
    for (const name of [
      "KEY_CACHE_TTL_MS",
      "MAX_EXPIRY_MS",
      "MAX_SLA_MS",
      "ESCROW_KEY_RETENTION_MS",
      "ESCROW_SWEEP_INTERVAL_MS",
    ] as const) {
      expect(keys[name]).toBe(windows[name]);
    }
  });
});

/**
 * **The development-only knobs are a table, not a convention.**
 *
 * `ESCROW_CLOCK_OFFSET_MS` is refused outside `ESCROW_MODE=mock`, and
 * it is warned about at boot, and both are tested. What was missing is that a
 * reader of `config.ts` could not tell it apart from the twelve production
 * knobs it sat among — it was one row in one table with everything else, and the
 * guard that makes it dev-only lives in a different function eighty lines below.
 *
 * Naming the set does two things a comment cannot: the refusal is asserted over
 * **every** member rather than over the one member that exists today, so a
 * second dev-only knob cannot be added without a guard; and the second test
 * makes adding one a deliberate act rather than a table row.
 */
describe("the development-only numeric knobs", () => {
  it.each(Object.entries(DEV_ONLY_NUMERIC))(
    "%s is refused outside ESCROW_MODE=mock",
    (name, bounds) => {
      expect(() =>
        loadConfig({ ...required, [name]: String(bounds.fallback + 1) }),
      ).toThrow(/development-only knob/);
    },
  );

  it.each(Object.entries(DEV_ONLY_NUMERIC))(
    "%s is carried through at mode mock",
    (name, bounds) => {
      const cfg = loadConfig({
        ...required,
        ESCROW_MODE: "mock",
        OPERATOR_KEY: `0x${"d4".repeat(32)}`,
        [name]: String(bounds.fallback + 1),
      });
      expect(cfg.escrow.clockOffsetMs).toBe(bounds.fallback + 1);
    },
  );

  it("is exactly one knob, and adding a second is a deliberate act", () => {
    expect(Object.keys(DEV_ONLY_NUMERIC)).toEqual(["ESCROW_CLOCK_OFFSET_MS"]);
  });
});

/**
 * `ESCROW_MODE=static` — the escrow key is derived from `OPERATOR_KEY`, so the
 * fleet shares it, a restart is not a custody event, and handover has nothing
 * left to do.
 *
 * The refusals are the interesting half. Both are knobs that would silently do
 * nothing at this mode, and a knob that reads as configured and never fires is
 * a cutover an operator believes in and does not have.
 */
describe("ESCROW_MODE=static", () => {
  const staticEnv = { ESCROW_MODE: "static", OPERATOR_KEY: `0x${"d4".repeat(32)}` };

  it("resolves, and carries the operator keys the escrow is derived from", () => {
    const cfg = loadConfig({ ...required, ...staticEnv });

    expect(cfg.escrow.mode).toBe("static");
    expect(cfg.escrow.operatorKeys).toEqual([`0x${"d4".repeat(32)}`]);
  });

  it("keeps every entry of a comma-separated list, in order", () => {
    const cfg = loadConfig({
      ...required,
      ...staticEnv,
      OPERATOR_KEY: `0x${"d4".repeat(32)},0x${"e5".repeat(32)}`,
    });

    expect(cfg.escrow.operatorKeys).toEqual([`0x${"d4".repeat(32)}`, `0x${"e5".repeat(32)}`]);
  });

  it.each(["PEER_URL", "PEER_REQUIRED"])("refuses %s: there is no handover at this mode", (name) => {
    const value = name === "PEER_URL" ? "https://peer.example.invalid" : "false";
    expect(() => loadConfig({ ...required, ...staticEnv, [name]: value })).toThrow(
      /ESCROW_MODE=static refuses PEER_URL and PEER_REQUIRED/,
    );
  });

  it.each(["ESCROW_ROTATE_INTERVAL_MS", "ESCROW_SWEEP_INTERVAL_MS"])(
    "refuses %s: nothing rotates and nothing is swept",
    (name) => {
      expect(() =>
        loadConfig({ ...required, ...staticEnv, [name]: "86400000" }),
      ).toThrow(new RegExp(`ESCROW_MODE=static refuses .*${name}`));
    },
  );

  it("refuses ESCROW_CLOCK_OFFSET_MS through the dev-only guard, not a second one", () => {
    // One variable, one refusal. The DEV_ONLY_NUMERIC guard is written against
    // `raw !== "mock"` and already covers this mode.
    expect(() =>
      loadConfig({ ...required, ...staticEnv, ESCROW_CLOCK_OFFSET_MS: "1" }),
    ).toThrow(/development-only knob/);
  });

  it("names the derivation when OPERATOR_KEY is missing, not a door this mode refuses", () => {
    // The old message sent an operator to POST /handover. At static that door is
    // refused, so it would be directions to the wrong place.
    expect(() => loadConfig({ ...required, ESCROW_MODE: "static" })).toThrow(
      /the escrow key is derived from it/,
    );
    // And the handover reason is still the reason at the mode where it is true.
    expect(() => loadConfig({ ...required, ESCROW_MODE: "mock" })).toThrow(/POST \/handover/);
  });

  it("still refuses an unrecognised mode by name", () => {
    expect(() => loadConfig({ ...required, ESCROW_MODE: "snp" })).toThrow(/ESCROW_MODE must be one of/);
  });
});

/**
 * `CORS_ORIGINS` — the browser origins this node answers cross-origin requests
 * from (spec 02).
 *
 * Every refusal here is about a value that would otherwise fail **only in a
 * browser**: a trailing slash or a path never equals the `Origin` header a
 * browser sends, so the allowlist would simply never match and CORS would look
 * as though it had never been configured. Refusing at boot is the only place
 * that failure is visible to the person who caused it.
 */
describe("CORS_ORIGINS", () => {
  it("defaults to no origins, so a deployment is browser-reachable only on purpose", () => {
    expect(loadConfig(required).corsOrigins).toEqual([]);
  });

  it("parses a comma-separated list, trimming and dropping the empties", () => {
    const cfg = loadConfig({
      ...required,
      CORS_ORIGINS: "https://app.vorq.co, http://localhost:3000, ",
    });
    expect(cfg.corsOrigins).toEqual(["https://app.vorq.co", "http://localhost:3000"]);
  });

  it("refuses a trailing slash, which would silently never match an Origin header", () => {
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "https://vorq.co/" })).toThrow(
      /CORS_ORIGINS entry "https:\/\/vorq\.co\/" is not an origin/,
    );
  });

  it("refuses a path, for the same reason", () => {
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "https://vorq.co/app" })).toThrow(
      /is not an origin/,
    );
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "app.vorq.co" })).toThrow(
      /is not an origin/,
    );
  });

  it("refuses a wildcard: this is an allowlist, not a reflection", () => {
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "*" })).toThrow(
      /CORS_ORIGINS is an allowlist and does not accept/,
    );
  });

  it("refuses a wildcard subdomain, which parses as a valid origin and matches nothing", () => {
    // The likelier mistake than a bare `*`: it is the nginx and `cors`-middleware
    // idiom. `*` is not a forbidden host code point, so `new URL` accepts it and
    // its `.origin` round-trips unchanged — the trailing-slash check cannot see it.
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "https://*.vorq.co" })).toThrow(
      /CORS_ORIGINS entry "https:\/\/\*\.vorq\.co" has a wildcard host/,
    );
  });

  it("refuses a non-http(s) scheme, which no Origin header can ever carry", () => {
    // `ws:` is a special scheme, so its `.origin` is a tuple and round-trips too.
    expect(() => loadConfig({ ...required, CORS_ORIGINS: "ws://vorq.co" })).toThrow(
      /CORS_ORIGINS entry "ws:\/\/vorq\.co" is not an http\(s\) origin/,
    );
  });
});
