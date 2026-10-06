import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { slaFacts, type Chain } from "../src/chain/client.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/db.js";
import {
  MOCK_COORDINATOR_IMAGE,
  MOCK_EVIDENCE_TYPE,
  STATIC_EVIDENCE_TYPE,
  SERVICE_ID,
  allowlistKeyFor,
  mockEvidence,
  mockMeasurement,
  reportData,
  staticEvidence,
} from "../src/escrow/attest.js";
import { bootEscrow } from "../src/escrow/boot.js";
import {
  ESCROW_KEY_RETENTION_MS,
  ESCROW_SWEEP_INTERVAL_MS,
  KEY_CACHE_TTL_MS,
  KeyManager,
  SoundnessError,
  assertEscrowSoundness,
  slaProbes,
} from "../src/escrow/keys.js";
import { StaticKeyManager } from "../src/escrow/static-keys.js";
import type { Indexer, IndexerStatus } from "../src/index/indexer.js";
import { escrowDoors } from "./support/escrow-doors.js";
import { ADDRESSES, stubChain, testConfig } from "./support/stub-chain.js";

/**
 * `GET /key`, the escrow mode gate, the mock evidence, and the boot-time
 * soundness assertion.
 *
 * No database, no chain, no network: the chain reads run against the canned
 * transport in `test/support/stub-chain.ts`, and the database handed to every
 * app here **throws on any query** — which is the point. The escrow door reads
 * neither the index nor Postgres, and a stub that answered would let that
 * property pass untested.
 */

const ESCROW_ROUTE = "/key";

/** A store that must never be reached. Any query is the failure under test. */
const hostileDb = {
  query: async () => {
    throw new Error("the escrow door must not read the store");
  },
} as unknown as Db;

const indexerReporting = (status: IndexerStatus): Indexer => ({
  coldStart: async () => undefined,
  poll: async () => undefined,
  status: async () => status,
  start: async () => undefined,
  stop: async () => undefined,
});

const READY = indexerReporting({ cursor: 100n, head: 100n, ready: true, forked: null });
const CATCHING_UP = indexerReporting({ cursor: 5n, head: 900n, ready: false, forked: null });

const escrowConfig = (overrides: Partial<Config["escrow"]> = {}): Config =>
  testConfig({
    escrow: {
      mode: "mock",
      releaseOrdinal: 1,
      sweepIntervalMs: ESCROW_SWEEP_INTERVAL_MS,
      peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [],
      clockOffsetMs: 0,
      ...overrides,
    },
  });

/** The config of a node that hosts no escrow. */
const offConfig = (): Config => escrowConfig({ mode: "off" });

/** A booted manager plus the app that serves it. */
function mockNode(options: { config?: Config; indexer?: Indexer } = {}) {
  const keys = new KeyManager();
  keys.boot();
  const app = buildApp({
    db: hostileDb,
    indexer: options.indexer ?? READY,
    config: options.config ?? escrowConfig(),
    escrowKeys: keys,
  });
  return { keys, app };
}

// ---------------------------------------------------------------------------
// The mode gate (I2 / P14)
// ---------------------------------------------------------------------------

describe("escrow mode gating", () => {
  /**
   * **The route is registered unconditionally and the key material is gated
   * inside the handler** (I2/P14). Wiring the route only when the mode is on
   * gives `404` at mode `off`, and a `404` says "this node has no such door" —
   * which is a different, and false, statement. At `off` the door exists and
   * refuses.
   *
   * Only `/key` is asserted here. `/release` and `/handover` arrive in Tasks 4
   * and 5 and are asserted by the tasks that create them (P14) — asserting them
   * now would either 404 or pin a stub.
   */
  it("answers 403 escrow_unavailable at mode off, and does not 404", async () => {
    const app = buildApp({
      db: hostileDb,
      indexer: READY,
      config: testConfig({ escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 } }),
    });

    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: { code: string; type: string } };
    // P13: one envelope, and `escrow_unavailable` is the **code**, never the
    // type. Plan 4 keys on `error.code`.
    expect(body.error.code).toBe("escrow_unavailable");
    expect(body.error.type).toBe("invalid_request_error");
    // The escrow is compiled off on this node: the identical request cannot
    // succeed later, which is exactly what a non-retryable answer promises (R57).
    expect(response.headers["x-vorq-retryable"]).toBe("false");
  });

  it("refuses the same way when the mode is on but no key manager was wired", async () => {
    const app = buildApp({ db: hostileDb, indexer: READY, config: escrowConfig() });
    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("escrow_unavailable");
  });

  it("serves the key at mode mock", async () => {
    const { app } = mockNode();
    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(response.statusCode).toBe(200);
  });

  /**
   * **S7 — the mode gate is inherited, and this test enumerates the doors from
   * the router rather than from a literal.**
   *
   * The gate used to be three hand-written `requireEscrow(deps)` calls, one per
   * handler, and the mode-off test listed the three doors as a hardcoded array.
   * Both halves had the same defect: a fourth escrow route added tomorrow
   * inherits the readiness escape by Fastify scope whether its author thought
   * about it or not, but would have had to *remember* the mode gate — and would
   * have had to be added to the array before any test noticed it had not.
   *
   * So the doors come from {@link escrowDoors}, which reads them off Fastify's
   * own `onRoute` hook while `escrowRoutes` registers them. Every route that
   * function registers — inside its encapsulated scope or, by mistake, outside it
   * — is in the list, and every one of them must refuse at mode `off`.
   */
  it("gates every door the escrow plugin registers, enumerated from the router (S7)", async () => {
    const doors = await escrowDoors();
    // The three that exist today. Written as a floor, not as the list: the
    // assertion below is over whatever the router actually holds.
    expect(doors.length).toBeGreaterThanOrEqual(3);

    const app = buildApp({ db: hostileDb, indexer: READY, config: offConfig() });

    for (const door of doors) {
      const where = `${door.method} ${door.url}`;
      const response = await app.inject({
        method: door.method as InjectOptions["method"],
        url: door.url,
      });
      expect(response.statusCode, where).toBe(403);
      // HEAD is the shadow Fastify mints for every GET and carries no body, so
      // the envelope is asserted on the doors that have one.
      if (door.method === "HEAD") continue;
      const body = response.json() as { error: { code: string; type: string } };
      expect(body.error.code, where).toBe("escrow_unavailable");
      expect(body.error.type, where).toBe("invalid_request_error");
      expect(response.headers["x-vorq-retryable"], where).toBe("false");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /key
// ---------------------------------------------------------------------------

describe("GET /key", () => {
  it("advertises the current generation and evidence bound to it", async () => {
    const { keys, app } = mockNode({ config: escrowConfig({ releaseOrdinal: 7 }) });
    const current = keys.current();
    expect(current).not.toBeNull();

    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      escrow_public_key: string;
      evidence: Record<string, unknown>;
      issued_at: number;
    };

    // `hex64`: 32 bytes, lowercase, **no** `0x` — the shape the plan's `/key`
    // contract names and the shape `report_data` is computed over.
    expect(body.escrow_public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(body.escrow_public_key).toBe(current?.publicKey.toString("hex"));

    expect(body.evidence.type).toBe(MOCK_EVIDENCE_TYPE);
    expect(body.evidence.type).toBe("mock-coordinator-v1");
    expect(body.evidence.debug).toBe(false);
    expect(body.evidence.tcb).toEqual({ svn: 1 });
    expect(body.evidence.release).toBe(7);
    expect(typeof body.evidence.quote).toBe("string");

    // Recomputed here from the image name rather than pasted, so a changed
    // measurement is a failing test and not a silently different node identity.
    expect(body.evidence.measurement).toBe(
      createHash("sha256").update(Buffer.from(MOCK_COORDINATOR_IMAGE, "utf8")).digest("hex"),
    );

    // **The binding, recomputed independently** (P24): the report data is
    // `sha256(boundKey ‖ utf8(service_id))`, the service id UTF-8 and unpadded.
    const expected = createHash("sha256")
      .update(Buffer.from(body.escrow_public_key, "hex"))
      .update(Buffer.from("vorq-coordinator-escrow-v1", "utf8"))
      .digest("hex");
    expect(body.evidence.report_data).toBe(expected);

    const now = Math.floor(Date.now() / 1000);
    expect(body.issued_at).toBeGreaterThanOrEqual(now - 5);
    expect(body.issued_at).toBeLessThanOrEqual(now + 5);
  });

  it("answers a retryable 503 while the escrow is still joining", async () => {
    // `boot({mint: false})` is the handover join flow (Task 5): adopt the
    // predecessor's generations first, mint afterwards. In that window there is
    // no current key, and the honest answer is "not yet", retryable — not a 403,
    // which would tell a client this node will never hold one.
    const keys = new KeyManager();
    keys.boot({ mint: false });
    const app = buildApp({ db: hostileDb, indexer: READY, config: escrowConfig(), escrowKeys: keys });

    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "escrow_key_unminted",
    );
    expect(response.headers["x-vorq-retryable"]).toBe("true");
  });

  it("advertises the key this node minted last after a rotation", async () => {
    const { keys, app } = mockNode();
    const minted = keys.mint();

    const body = (await app.inject({ method: "GET", url: ESCROW_ROUTE })).json() as {
      escrow_public_key: string;
      evidence: { report_data: string };
    };

    expect(body.escrow_public_key).toBe(minted.publicKey.toString("hex"));
    expect(body.evidence.report_data).toBe(reportData(minted.publicKey));
  });
});

// ---------------------------------------------------------------------------
// P26 — outside the readiness gate
// ---------------------------------------------------------------------------

describe("the escrow routes are outside the readiness gate (P26)", () => {
  it("serves GET /key while the indexer reports not ready", async () => {
    const { app } = mockNode({ indexer: CATCHING_UP });

    // The premise first: this node really is not ready, so a pass below cannot
    // be a stub that quietly reports readiness.
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect((readyz.json() as { reason: string }).reason).toBe("trailing");

    // And the gate really does bite: a gated route refuses, before its handler
    // can reach the store that would throw.
    const gated = await app.inject({ method: "GET", url: "/evm/allowlist" });
    expect(gated.statusCode).toBe(503);
    expect((gated.json() as { error: { type: string } }).error.type).toBe("not_ready");

    // A node catching up on log replay still holds its keys. Gating this would
    // make a restart look like key loss.
    const key = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(key.statusCode).toBe(200);
    expect((key.json() as { escrow_public_key: string }).escrow_public_key).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("refuses at mode off while not ready, with 403 rather than the gate's 503", async () => {
    const app = buildApp({
      db: hostileDb,
      indexer: CATCHING_UP,
      config: testConfig({ escrow: { mode: "off", releaseOrdinal: 1, sweepIntervalMs: 300_000, peerUrl: null, peerRequired: false, peerSyncMs: 300_000, rotateIntervalMs: 86_400_000, operatorKeys: [], clockOffsetMs: 0 } }),
    });
    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    // The mode gate answers, not the readiness gate — proof the route never
    // entered the gated scope even on the refusal path.
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe("escrow_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Mock evidence
// ---------------------------------------------------------------------------

describe("mockEvidence", () => {
  const key = Buffer.alloc(32, 0xab);

  it("binds the key it is given, not the node's current key", () => {
    // The handover flow (Task 5) regenerates evidence over a **channel** public
    // key. A `mockEvidence` that reached for the current generation instead of
    // its argument would bind the wrong key and every binding check downstream
    // would compare the wrong thing.
    const other = Buffer.alloc(32, 0xcd);
    expect(mockEvidence(key, 1).report_data).not.toBe(mockEvidence(other, 1).report_data);
    expect(mockEvidence(key, 1).report_data).toBe(reportData(key));
  });

  it("computes report_data over the UTF-8, unpadded service id (P24)", () => {
    const expected = createHash("sha256")
      .update(key)
      .update(Buffer.from("vorq-coordinator-escrow-v1", "utf8"))
      .digest("hex");
    expect(reportData(key)).toBe(expected);
    expect(SERVICE_ID).toBe("vorq-coordinator-escrow-v1");
    // Unpadded: the digest of a 32-byte key and a 26-byte id is over 58 bytes.
    expect(Buffer.from(SERVICE_ID, "utf8")).toHaveLength(26);
  });

  it("refuses a bound key that is not 32 bytes", () => {
    // A short key would silently produce a well-formed-looking binding that no
    // verifier could reproduce.
    expect(() => mockEvidence(Buffer.alloc(31, 1), 1)).toThrow(/32/);
    expect(() => mockEvidence(Buffer.alloc(33, 1), 1)).toThrow(/32/);
  });

  it("carries the release ordinal it is given", () => {
    expect(mockEvidence(key, 0).release).toBe(0);
    expect(mockEvidence(key, 42).release).toBe(42);
  });

  it("is never marked debug and never claims a real quote", () => {
    const evidence = mockEvidence(key, 1);
    expect(evidence.debug).toBe(false);
    expect(evidence.tcb.svn).toBeGreaterThanOrEqual(1);
    // The placeholder says what it is, in the clear, so a quote that reached a
    // production verifier is self-identifying rather than opaque noise.
    expect(Buffer.from(evidence.quote, "base64").toString("utf8")).toContain("mock");
  });

  it("uses the measurement itself as the allowlist key (P9)", () => {
    // The key IS the raw sha256 image digest as bytes32 — no namespace prefix,
    // no second hash. Recomputed from the image name so the entry this node's
    // measurement lands on cannot drift from the one curation writes.
    const measurement = createHash("sha256")
      .update(Buffer.from(MOCK_COORDINATOR_IMAGE, "utf8"))
      .digest("hex");
    expect(mockMeasurement()).toBe(measurement);
    // the literal the contracts repo pins for the same name
    // (test/AllowlistKeyConvention.t.sol) — a rename on either side fails here
    expect(measurement).toBe("11ed7897eb27a6c940cf571f40a0c6d7203b3e05dfe448462042a62e2472cb89");
    expect(allowlistKeyFor(measurement)).toBe(`0x${measurement}`);
    // The provider image the contracts repo pins the same digest for
    // (test/AllowlistKeyConvention.t.sol) — a drift shows here, not on chain.
    expect(
      createHash("sha256").update(Buffer.from("vorq-mock-cvm-image-v1", "utf8")).digest("hex"),
    ).toBe("3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d");
    expect(allowlistKeyFor("3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d")).toBe(
      "0x3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d",
    );
    // announced measurements are normalized, never trusted to arrive lowercase
    expect(allowlistKeyFor("3456994B572F1DE0BA1B0AB60EF75683822414C5317B6DBBBEA50D203BD5D75D")).toBe(
      "0x3456994b572f1de0ba1b0ab60ef75683822414c5317b6dbbbea50d203bd5d75d",
    );
  });

});

// ---------------------------------------------------------------------------
// P3 — the boot soundness assertion, against live chain values
// ---------------------------------------------------------------------------

/**
 * `allowedSla` answers per argument, which is why the stub's `views` had to
 * learn to take a function: one canned answer per function name cannot express
 * a mapping, and this whole check is about which keys of that mapping are set.
 */
const chainAllowing = (allowed: readonly number[], maxExpiry = 86_400n) =>
  stubChain(testConfig(), {
    views: {
      MAX_EXPIRY: maxExpiry,
      allowedSla: (args: readonly unknown[]) => allowed.includes(Number(args[0])),
    },
  });

describe("the boot soundness assertion reads the chain (P3)", () => {
  it("passes on the devnet's own configuration", async () => {
    const stub = chainAllowing([3600, 86_400]);
    await expect(
      assertEscrowSoundness(slaFacts(stub.chain, ADDRESSES.jobRegistry)),
    ).resolves.toBeUndefined();
  });

  it("takes MAX_EXPIRY from the chain, and refuses when it grows past retention", async () => {
    // Nothing about this node changed — the chain did. A constant `MAX_EXPIRY`
    // would have booted happily into a configuration that erases keys a live
    // order can still name.
    const stub = chainAllowing([3600], 200_000n);
    await expect(
      assertEscrowSoundness(slaFacts(stub.chain, ADDRESSES.jobRegistry)),
    ).rejects.toThrow(SoundnessError);

    // And it really did ask the chain rather than reading its own constant.
    expect(stub.requests.some((request) => request.method === "eth_call")).toBe(true);
  });

  /**
   * **S6 — the ladder's reach, asserted rather than described.**
   *
   * The hourly half stopped 24 hours past the ceiling — one hour short of the
   * "day past it" its own comment promised, and, far worse, leaving a
   * 27-hour-wide band of whole hours (69 h–95 h, only 72 h covered by the day
   * ladder) in which curation could allow an SLA, boot this node cleanly, and
   * leave the true worst case at 100 h against a 72 h retention.
   *
   * 73 h is the specific value the reviewer named. It is a governance
   * transaction somebody could plausibly write, and it used to boot.
   */
  it("probes every whole hour from the ceiling to a week, including 73 h (S6)", () => {
    const probes = slaProbes(86_400);
    const ceiling = (ESCROW_KEY_RETENTION_MS - KEY_CACHE_TTL_MS) / 1000 - 86_400;

    for (let hour = Math.ceil(ceiling / 3600); hour <= 168; hour += 1) {
      expect(probes, `${hour} h`).toContain(hour * 3600);
    }
    // The two the old ladder missed, named so a regression is legible.
    expect(probes).toContain(73 * 3600);
    expect(probes).toContain(95 * 3600);
    // The ceiling itself, and the uint32 top.
    expect(probes).toContain(Math.ceil(ceiling));
    expect(probes).toContain(4_294_967_295);
    // And nothing *sound* is probed: a probe below the ceiling would refuse a
    // boot that is perfectly safe.
    expect(probes.filter((secs) => secs < ceiling)).toEqual([]);
  });

  it("refuses to start when curation allows an SLA of 73 h (S6)", async () => {
    // The behavioural half: the value that used to boot cleanly.
    const stub = chainAllowing([262_800]);
    await expect(
      assertEscrowSoundness(slaFacts(stub.chain, ADDRESSES.jobRegistry)),
    ).rejects.toThrow(SoundnessError);
  });

  it("refuses to start when curation allows an SLA retention cannot cover", async () => {
    // 72 h retention − 3 h grace − 24 h expiry leaves 45 h of tolerable SLA. A
    // 48 h SLA is past it: an order posted at the last instant of a cached key's
    // life could still be delivering when the key is erased.
    const stub = chainAllowing([3600, 86_400, 172_800]);
    await expect(
      assertEscrowSoundness(slaFacts(stub.chain, ADDRESSES.jobRegistry)),
    ).rejects.toThrow(/172800|48/);
  });

  it("names the retention window in the refusal an operator reads", async () => {
    const stub = chainAllowing([604_800]);
    await expect(
      assertEscrowSoundness(slaFacts(stub.chain, ADDRESSES.jobRegistry)),
    ).rejects.toThrow(SoundnessError);
  });

  it("tolerates every SLA strictly inside the bound", async () => {
    // One second under the ceiling is sound; the ceiling itself is not (the
    // comparison is strict — a key erased in the same instant an order may name
    // it is the failure, not the boundary of it).
    const ceiling = (ESCROW_KEY_RETENTION_MS - KEY_CACHE_TTL_MS) / 1000 - 86_400;
    await expect(
      assertEscrowSoundness(slaFacts(chainAllowing([ceiling - 1]).chain, ADDRESSES.jobRegistry)),
    ).resolves.toBeUndefined();
    await expect(
      assertEscrowSoundness(slaFacts(chainAllowing([ceiling]).chain, ADDRESSES.jobRegistry)),
    ).rejects.toThrow(SoundnessError);
  });

  /**
   * **S4 — the refusal is a refusal, and a test can tell.**
   *
   * The only thing that used to guard "a violation is a process that does not
   * start" was the source-text assertion below, and `.catch(() => {})` satisfies
   * it word for word: the reviewer downgraded the boot refusal to a swallowed
   * warning and 103/103 stayed green. So the boot sequence is now a function,
   * and this drives it against a chain whose curation allows an SLA the
   * retention window cannot cover.
   */
  it("refuses to boot the escrow when the chain's values are unsound (P3, S4)", async () => {
    const stub = chainAllowing([3600, 172_800]);
    const keys = new KeyManager();

    await expect(
      bootEscrow(stub.chain, escrowConfig(), keys),
    ).rejects.toThrow(SoundnessError);

    // And it refused *before* holding anything: a node that cannot prove its
    // retention window must not be sitting on key material while it fails.
    expect(keys.current()).toBeNull();
    expect(keys.heldKeys()).toEqual([]);
  });

  it("boots the escrow, and marks the epoch, when they are sound", async () => {
    // The other half, so the refusal above is a decision and not a function that
    // always throws.
    const stub = chainAllowing([3600, 86_400]);
    const keys = new KeyManager();

    const epoch = await bootEscrow(stub.chain, escrowConfig(), keys);

    expect(keys.current()).not.toBeNull();
    expect(epoch).not.toBeNull();
    expect(epoch?.time).toBeGreaterThan(0);
    expect(typeof epoch?.block).toBe("bigint");
  });

  it("is awaited before the node listens, so a violation is a boot failure", () => {
    // The behavioural test above cannot see the *call site*: `main()` runs on
    // import, so no in-process test can drive it. This is what is left — the
    // order of main's boot sequence, and that the call is not swallowed where it
    // is made. `bootEscrow` returning the epoch marker rather than assigning one
    // is the other half: `.catch(() => {})` on this call does not type-check.
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    const call = main.indexOf("await bootEscrow(");
    const listen = main.indexOf("app.listen(");
    expect(call).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(call).toBeLessThan(listen);

    // No `try {` opened in the twenty lines before it, and nothing caught on it.
    const statement = main.slice(call, main.indexOf(";", call));
    expect(statement).not.toContain("catch");
    expect(main.slice(Math.max(0, call - 800), call)).not.toContain("try {");
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ADDRESSES_FIXTURE = fileURLToPath(new URL("./fixtures/addresses.json", import.meta.url));

const required = {
  DATABASE_URL: "postgres://vorq:vorq@localhost:5433/vorq",
  RELAYER_KEY: `0x${"11".repeat(32)}`,
  ADDRESSES_FILE: ADDRESSES_FIXTURE,
  PIN_S3_ENDPOINT: "https://pin.example.invalid",
  PIN_S3_KEY: "key-id",
  PIN_S3_SECRET: "secret-value",
  PIN_S3_BUCKET: "vorq-pins",
};

describe("escrow configuration", () => {
  it("defaults to off, release ordinal 1, and the documented sweep interval", () => {
    const config = loadConfig(required);
    // **Off by default, and deliberately.** Mock evidence is computable by
    // anyone, so a node that defaulted to `mock` would serve a forgeable
    // attestation the first time somebody deployed one without reading the docs.
    expect(config.escrow.mode).toBe("off");
    // P19.
    expect(config.escrow.releaseOrdinal).toBe(1);
    // P20: five minutes, and the constant is the one `keys.ts` documents.
    expect(config.escrow.sweepIntervalMs).toBe(300_000);
    expect(config.escrow.sweepIntervalMs).toBe(ESCROW_SWEEP_INTERVAL_MS);
  });

  it("accepts mock and refuses any other mode by name", () => {
    expect(loadConfig({ ...required, ESCROW_MODE: "mock", OPERATOR_KEY: `0x${"d4".repeat(32)}`, }).escrow.mode).toBe("mock");
    expect(loadConfig({ ...required, ESCROW_MODE: "off" }).escrow.mode).toBe("off");
    // `snp` is the mode a later project adds. Accepting it now would boot a node
    // that serves mock evidence while an operator believes it is attested.
    expect(() => loadConfig({ ...required, ESCROW_MODE: "snp" })).toThrow(
      /ESCROW_MODE/,
    );
    expect(() => loadConfig({ ...required, ESCROW_MODE: "MOCK" })).toThrow(
      /ESCROW_MODE/,
    );
  });

  /**
   * `OPERATOR_KEY` is a **list**, and the shape of that list is load-bearing:
   * the first entry is what a node signs its own pulls with, and every entry is
   * one it will accept. Rotation depends on both halves — see the field's
   * docblock in `src/config.ts`.
   */
  describe("the operator credential", () => {
    const K1 = `0x${"d4".repeat(32)}`;
    const K2 = `0x${"f6".repeat(32)}`;
    const mock = { ...required, ESCROW_MODE: "mock" };

    it("reads one key, and a comma-separated list in order", () => {
      expect(loadConfig({ ...mock, OPERATOR_KEY: K1 }).escrow.operatorKeys).toEqual([K1]);
      // Order is the contract, not an accident: `[0]` signs.
      expect(loadConfig({ ...mock, OPERATOR_KEY: `${K1},${K2}` }).escrow.operatorKeys).toEqual(
        [K1, K2],
      );
    });

    it("tolerates the whitespace a human leaves in a comma-separated variable", () => {
      expect(
        loadConfig({ ...mock, OPERATOR_KEY: ` ${K1} , ${K2} , ` }).escrow.operatorKeys,
      ).toEqual([K1, K2]);
    });

    it("is required at any mode that holds keys, and unused at off", () => {
      expect(() => loadConfig(mock)).toThrow(/OPERATOR_KEY/);
      // Not merely absent-tolerated at `off` — there is nothing to authenticate,
      // because no key is ever minted and every escrow door refuses.
      expect(loadConfig({ ...required, ESCROW_MODE: "off" }).escrow.operatorKeys).toEqual([]);
    });

    /**
     * **The refusal names the position and never the value.** A loader that
     * echoed a malformed key would put a private key into a log line the first
     * time somebody pasted one with a typo, and a redacted log is not a recalled
     * one. Checked at boot rather than at first use so a bad *second* entry fails
     * the node that introduced it, not the cutover six hours later that needed it.
     */
    it("refuses a malformed entry by position, without quoting it", () => {
      const bad = "0xnope";
      let thrown: unknown;
      try {
        loadConfig({ ...mock, OPERATOR_KEY: `${K1},${bad}` });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/entry 2/);
      expect((thrown as Error).message).not.toContain(bad);
      expect((thrown as Error).message).not.toContain(K1);
    });
  });

  it("reads the release ordinal and the sweep interval from the environment", () => {
    const config = loadConfig({
      ...required,
      RELEASE_ORDINAL: "3",
      ESCROW_SWEEP_INTERVAL_MS: "60000",
    });
    expect(config.escrow.releaseOrdinal).toBe(3);
    expect(config.escrow.sweepIntervalMs).toBe(60_000);
  });

  it("refuses a sweep interval that would let keys outlive their deadline", () => {
    // The deadline bounds a key's life; the interval bounds only how *late* an
    // erasure happens. Past an hour that lateness is a window a reader could
    // fairly describe as "keys survive their deadline".
    expect(() =>
      loadConfig({ ...required, ESCROW_SWEEP_INTERVAL_MS: "7200000" }),
    ).toThrow(/ESCROW_SWEEP_INTERVAL_MS/);
    expect(() => loadConfig({ ...required, ESCROW_SWEEP_INTERVAL_MS: "0" })).toThrow(
      /ESCROW_SWEEP_INTERVAL_MS/,
    );
  });
});

describe("staticEvidence", () => {
  const key = Buffer.alloc(32, 0xa1);

  it("binds the key it is about, by the same construction under the same service id", () => {
    const evidence = staticEvidence(key, 3);

    expect(evidence.type).toBe("static-coordinator-v1");
    expect(evidence.report_data).toBe(reportData(key));
    expect(evidence.report_data).toBe(
      createHash("sha256").update(key).update(Buffer.from(SERVICE_ID, "utf8")).digest("hex"),
    );
  });

  it("carries the release ordinal and a false debug flag", () => {
    expect(staticEvidence(key, 3).release).toBe(3);
    expect(staticEvidence(key, 3).debug).toBe(false);
  });

  it("claims no measurement, no TCB and no quote", () => {
    // There is no image to measure, no platform to report a security version,
    // and no report to quote. Stating any of the three would be a false claim
    // about hardware this node does not have — and it is a genuine absence,
    // not an explicit `undefined`, so `Object.hasOwn` is the check and not
    // `toBeUndefined()`, which an `{ measurement: undefined }` would also pass.
    const evidence = staticEvidence(key, 1);
    expect(Object.hasOwn(evidence, "measurement")).toBe(false);
    expect(Object.hasOwn(evidence, "tcb")).toBe(false);
    expect(Object.hasOwn(evidence, "quote")).toBe(false);
  });

  it("is a different tag from the mock coordinator's, and from the mock evidence itself", () => {
    expect(STATIC_EVIDENCE_TYPE).not.toBe(MOCK_EVIDENCE_TYPE);
    expect(staticEvidence(key, 1)).not.toEqual(mockEvidence(key, 1));
  });

  it("refuses a key of the wrong width and a negative ordinal", () => {
    expect(() => staticEvidence(Buffer.alloc(31), 1)).toThrow(/32-byte key/);
    expect(() => staticEvidence(key, -1)).toThrow(/non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// The doors at mode static (Task 5)
// ---------------------------------------------------------------------------

/** A static node: keys derived from these operator entries, and the app that serves them. */
const STATIC_OPERATOR_KEYS = [`0x${"d4".repeat(32)}`, `0x${"e5".repeat(32)}`];

function staticNode(options: { config?: Config; indexer?: Indexer } = {}) {
  const keys = new StaticKeyManager(STATIC_OPERATOR_KEYS);
  const app = buildApp({
    db: hostileDb,
    indexer: options.indexer ?? READY,
    config: options.config ?? escrowConfig({ mode: "static", operatorKeys: STATIC_OPERATOR_KEYS }),
    escrowKeys: keys,
  });
  return { keys, app };
}

describe("GET /key at mode static", () => {
  it("announces the derived key with evidence that binds it", async () => {
    const { keys, app } = staticNode({
      config: escrowConfig({ mode: "static", operatorKeys: STATIC_OPERATOR_KEYS, releaseOrdinal: 4 }),
    });

    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      escrow_public_key: string;
      evidence: Record<string, unknown>;
      issued_at: number;
    };
    expect(body.escrow_public_key).toBe(keys.current()?.publicKey.toString("hex"));
    expect(body.evidence.type).toBe(STATIC_EVIDENCE_TYPE);
    expect(body.evidence.report_data).toBe(
      reportData(Buffer.from(body.escrow_public_key, "hex")),
    );
    expect(body.evidence.release).toBe(4);
    expect(body.evidence.measurement).toBeUndefined();
    expect(body.evidence.tcb).toBeUndefined();
  });

  it("keeps mock evidence at mode mock", async () => {
    const { app } = mockNode();
    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect((response.json() as { evidence: { type: string } }).evidence.type).toBe(
      MOCK_EVIDENCE_TYPE,
    );
  });

  it("never answers escrow_key_unminted: a derived key set has no join to wait for", async () => {
    const { app } = staticNode();
    const response = await app.inject({ method: "GET", url: ESCROW_ROUTE });
    expect(response.statusCode).toBe(200);
  });
});

describe("POST /handover at mode static", () => {
  it("refuses with escrow_handover_disabled, from the scope and not the handler", async () => {
    const { app } = staticNode();

    // HANDOVER_BODY_LIMIT_BYTES is 4096. Fastify enforces `bodyLimit` during body
    // reception, which runs after `onRequest` and before `preParsing`/
    // `preValidation`/the handler — so any check later than `onRequest` would
    // answer 413, not 403 (the RED run before this gate existed recorded exactly
    // that: "expected 413 to be 403"). A payload far above the 4 KB limit
    // answering 403 here, rather than 413, is therefore the proof that the
    // refusal comes from `onRequest` and nothing later.
    const response = await app.inject({
      method: "POST",
      url: "/handover",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(200_000) }),
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error: { code: string; type: string } };
    expect(body.error.code).toBe("escrow_handover_disabled");
    expect(body.error.type).toBe("invalid_request_error");
    expect(response.headers["x-vorq-retryable"]).toBe("false");
  });

  it("still refuses with escrow_unavailable at mode off, which is the outer gate", async () => {
    const app = buildApp({ db: hostileDb, indexer: READY, config: offConfig() });
    const response = await app.inject({ method: "POST", url: "/handover", payload: {} });
    expect((response.json() as { error: { code: string } }).error.code).toBe("escrow_unavailable");
  });

  it("leaves /key and /release inside the outer scope, not the handover one", async () => {
    // The nested register must hold exactly one door. If /key or /release drifted
    // into it, a static node would refuse the two doors it exists to serve.
    const { app } = staticNode();
    expect((await app.inject({ method: "GET", url: ESCROW_ROUTE })).statusCode).toBe(200);

    // staticNode() wires no chain, so a /release that is still in the outer
    // scope reaches its handler and is refused by requireChain (503
    // chain_unreachable), never by the handover scope's 403. Asserting
    // not.toBe(403) rather than pinning 503 keeps this about scope, not about
    // chain wiring.
    expect(
      (await app.inject({ method: "POST", url: "/release", payload: {} })).statusCode,
    ).not.toBe(403);
  });
});

describe("bootEscrow at mode static", () => {
  it("returns a null epoch: a restart is not a custody event", async () => {
    // The whole mode rests on this. A boot epoch would hide every job posted
    // before the last redeploy from the book, and make /release answer
    // escrow_key_lost for wraps this very process can open.
    const keys = new StaticKeyManager(STATIC_OPERATOR_KEYS);
    const config = escrowConfig({ mode: "static", operatorKeys: STATIC_OPERATOR_KEYS });

    const epoch = await bootEscrow(chainAllowing([3600, 86_400]).chain, config, keys);

    expect(epoch).toBeNull();
  });

  it("reads nothing from the chain: there is no retention window to prove", async () => {
    // assertEscrowSoundness probes ~140 allowedSla values and MAX_EXPIRY. A
    // static node erases nothing, so the inequality has no subject — and a boot
    // that depended on those reads would fail on an RPC hiccup for a conclusion
    // that cannot apply to it.
    const keys = new StaticKeyManager(STATIC_OPERATOR_KEYS);
    const config = escrowConfig({ mode: "static", operatorKeys: STATIC_OPERATOR_KEYS });
    const hostileChain = new Proxy({} as Chain, {
      get() {
        throw new Error("a static boot must not read the chain");
      },
    });

    await expect(bootEscrow(hostileChain, config, keys)).resolves.toBeNull();
  });

  it("still marks an epoch and proves soundness on a minting node", async () => {
    // The premise, so the two assertions above are about the mode and not about
    // a boot that stopped doing its job.
    const keys = new KeyManager();

    const epoch = await bootEscrow(chainAllowing([3600, 86_400]).chain, escrowConfig(), keys);

    expect(epoch).not.toBeNull();
    expect(keys.current()).not.toBeNull();
  });
});
