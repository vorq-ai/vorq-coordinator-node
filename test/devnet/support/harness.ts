import { execFileSync, spawn } from "node:child_process";
import { formatUsd } from "../../../src/money.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Address as ViemAddress,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buildApp } from "../../../src/api/app.js";
import { makeChain, type Chain } from "../../../src/chain/client.js";
import { loadConfig, type Address, type Config, type Env } from "../../../src/config.js";
import { dropDerived, openDb, type Db } from "../../../src/db/db.js";
import { startIndexer, type Indexer } from "../../../src/index/indexer.js";
import { assertDomains, authorizationTypedData, capOf, feeOf, jobIdOf, orderTypedData, taskCidHex, type Terms } from "../../../src/orders.js";
import { commitmentOf, CONTAINER_TAG, SEED_WRAP_BYTES } from "../../../src/container.js";
import { startStubStore } from "../../support/stub-store.js";
import { EIP712_NAMES } from "../../../src/orders.js";
import { sessionDomain } from "../../../src/api/routes/auth.js";

/**
 * The devnet integration suite's shared machinery.
 *
 * **This suite is the plan's acceptance gate**, and everything here exists to
 * keep the six scenarios honest about what they prove:
 *
 *   * the node is built from `loadConfig` over a synthetic environment and the
 *     *published* `addresses.json`, so a scenario exercises the same
 *     configuration path a container boot does;
 *   * every app **listens on a real socket** and every request is a real
 *     `fetch`. `app.inject()` structurally cannot reach a socket-level ending
 *     (R79(b)) and has already cost this plan a Critical, so it appears nowhere
 *     in this directory;
 *   * **the chain's own head is measured, never assumed** (R2). Nothing here
 *     mines a fixed number of blocks and calls a transition visible:
 *     {@link waitForHead} polls the endpoint's own block number until it passes
 *     the transition's block, and {@link waitForCursor} polls the index.
 *
 * Requires the fork stack up
 * (`BASE_SEPOLIA_RPC_URL=… make -C ../vorq-evm-contracts/fork up`) and a local
 * Postgres 16 (`docker compose -f compose.dev.yml up -d`).
 */

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/** The contracts repo, which is where the fork stack lives (R1). */
export const CONTRACTS_ROOT = fileURLToPath(
  new URL("../../../../vorq-evm-contracts/", import.meta.url),
);

/** The published addresses file every consumer is told to read (R1). */
export const ADDRESSES_FILE = `${CONTRACTS_ROOT}fork/state/addresses.json`;

export const addressesFile = (): Record<string, unknown> =>
  JSON.parse(readFileSync(ADDRESSES_FILE, "utf8")) as Record<string, unknown>;

/**
 * The chain this stack published, read from the file rather than written down.
 *
 * A literal is how a suite ends up pointed at one chain and asserting about
 * another: the fork carries Base Sepolia's own `84532`, the stack it replaced
 * carried `97`, and the only authority on which one is live is the file the
 * bootstrap wrote.
 */
export const CHAIN_ID = Number(addressesFile().chainId);

/**
 * The canonical fork RPC: the **range-capped proxy** on 8545.
 *
 * 8546 is the same chain, uncapped, for debugging only. Production-shaped code
 * talks to 8545 (R36), and a suite that proved the chunker against an uncapped
 * endpoint would prove nothing about the one property it exists for.
 */
export const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";

/** The `eth_getLogs` span the proxy actually enforces. Must match `RANGE_CAP` in its compose file. */
export const PROXY_RANGE_CAP = 5000;

/**
 * The chain's block time, and therefore every node's poll interval.
 *
 * 2 s, because that is what `--block-time` is set to and what Base itself does.
 * Exported so a scenario's waiting budget is *derived* from it rather than
 * written down: the stack this suite replaced produced a block every 0.45 s, and
 * every budget tuned to that number was a budget that silently became too tight.
 */
export const BLOCK_TIME_MS = 2000;

/**
 * The **uncapped** anvil on 8546 — for establishing chain preconditions, and for
 * nothing else.
 *
 * Nothing under test ever talks to this. It is where {@link mineTo} sends
 * `anvil_mine`, because the proxy refuses the whole test-only namespace outright:
 *
 * ```
 * $ curl :8545 -d '{"method":"anvil_mine","params":["0x2"]}'
 * {"error":{"code":-32601,"message":"method not found: anvil_mine is a test-only
 *  namespace and is not exposed on this RPC"}}
 * ```
 *
 * That refusal is the distinction this constant exists to keep visible. Driving
 * the chain into a shape is **fixture setup**; R36 is about the endpoint the
 * *node* reads through, which is 8545 in every scenario, including the ones that
 * call this first.
 */
export const ANVIL_ADMIN_URL = process.env.DEVNET_ANVIL_URL ?? "http://localhost:8546";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://vorq:vorq@localhost:5433/vorq";

// ---------------------------------------------------------------------------
// Anvil's well-known accounts
// ---------------------------------------------------------------------------

/**
 * Anvil's deterministic keys, by index. The fork stack's `bootstrap.sh` assigns
 * them: #0 deployer/relayer, #1 treasury, #2 curation, **#3 provider operator**,
 * **#4 client**.
 *
 * Not credentials: this mnemonic is printed by `anvil` on every start. On a fork
 * of a real network they are not empty accounts either — which is why the
 * bootstrap resets all five before it deploys — but nothing here depends on that
 * beyond the reset having happened.
 */
export const ANVIL_KEYS = {
  relayer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  client: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const;

export const providerAccount = (): PrivateKeyAccount =>
  privateKeyToAccount(ANVIL_KEYS.provider);
export const clientAccount = (): PrivateKeyAccount => privateKeyToAccount(ANVIL_KEYS.client);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NodeOptions {
  /** The Postgres schema this node's projection lives in. One per test file. */
  schema: string;
  /** `GETLOGS_CAP`. Defaults to the proxy's own cap. */
  getLogsCap?: number;
  /** `READY_LAG_BLOCKS`. */
  readyLagBlocks?: number;
  /** `BLOCK_TIME_MS` — how often the indexer polls. */
  blockTimeMs?: number;
  /** A specific port. Left out, a free one is found. */
  port?: number;
  /** `RPC_URL`. Defaults to the capped proxy; scenario 4 points it at a gate. */
  rpcUrl?: string;
  /** Extra environment, for anything a scenario needs to vary by name. */
  env?: Env;
}

/**
 * A port for one node, derived from the process id and a per-node counter.
 *
 * `PORT: "0"` is not an option: `loadConfig` bounds the port at [1, 65535]
 * on purpose, because a node that silently bound an arbitrary port would be a
 * node nothing could find. Vitest runs each scenario file in its own worker
 * process, so the pid separates the files and the counter separates the nodes
 * inside one — and `app.listen` fails loudly on a collision rather than
 * silently sharing.
 */
let portCursor = 0;
function nodePort(): number {
  portCursor += 1;
  return 20_000 + ((process.pid * 7 + portCursor * 13) % 20_000);
}

/**
 * A port for a node this scenario has to name **before** it starts it.
 *
 * The replica pair is why this is exported: P6's topology is symmetric, so each
 * instance is configured with the other's URL and neither can be started first
 * to find out where the other landed. Drawing both ports up front is the only
 * way to write that configuration, and it draws from the same counter every
 * other node here uses, so a scenario mixing the two cannot collide with itself.
 */
export const allocatePort = (): number => nodePort();

/**
 * **Eight hex characters identifying this deployment** — the suffix every schema
 * name carries, and the thing that makes a projection belong to one chain.
 *
 * `make down` discards the chain and the next `make up` rebuilds it from the
 * pinned fork block. The schemas were created `IF NOT EXISTS` and outlived it, so
 * a run immediately after a rebuild began with cursors thousands of blocks
 * **ahead** of a chain that had restarted at the pin. An indexer that believes it
 * is ahead advances nothing, and five scenario files failed with mirror timeouts,
 * an empty rebuild, and `expected -92836 to be greater than 20` — symptoms that
 * look exactly like indexer defects and are not.
 *
 * This is the same defect as the one `mineTo` fixed, in the other resource: a
 * gate with a hidden precondition. Dropping per start would have been the wrong
 * repair, because `cursor-gap` restarts a node against a **preserved** schema and
 * that preservation is the property it tests. Putting the deployment's identity in
 * the *name* dissolves the tension: a new chain lands in a new schema
 * automatically, while every restart within one run resolves to the same name and
 * finds its schema exactly as it left it.
 *
 * **The published file's write time, and not a block hash.** On a fork nothing
 * about the chain itself is unique per stack: the pinned block is the same block
 * every time, anvil advances the forked timestamp by exactly `--block-time` per
 * block (measured: the fork block carries Base Sepolia's own timestamp and block
 * `n` carries it plus `2n`), and `CREATE` addresses are a function of deployer and
 * nonce — so a second `make up` that lands its deploy at the same height
 * reproduces that block's hash exactly. `state/addresses.json` is written once,
 * last, by the bootstrap that deployed; a live stack's `make up` prints
 * "nothing to do" and does not touch it. Its mtime is therefore *the* identifier
 * of a deployment, and it changes if and only if one happened.
 *
 * Old schemas accumulate, deliberately — no reaper, no drop-on-start, nothing
 * that could race a running scenario. They are a few hundred kB each and one
 * statement removes them all:
 *
 * ```sql
 * DO $$ DECLARE s text; BEGIN
 *   FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vorq\_devnet\_%'
 *   LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP;
 * END $$;
 * ```
 */
export function chainTag(): string {
  // Both members matter: the mtime separates two deployments, and `deployBlock`
  // keeps the name legible about which chain height it belongs to.
  const identity = `${String(addressesFile().deployBlock)}:${statSync(ADDRESSES_FILE).mtimeMs}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

/**
 * A scenario's schema name for **this** deployment.
 *
 * `vorq_devnet_cursor_gap` becomes `vorq_devnet_cursor_gap_ed6c807a`. The longest
 * base in this suite is 31 characters, so the result is 40 — comfortably inside
 * Postgres's 63-character identifier limit, which truncates silently and would
 * otherwise collide two scenarios into one schema.
 */
export async function schemaFor(base: string): Promise<string> {
  return `${base}_${chainTag()}`;
}

/**
 * Points a connection at a schema of the suite's own rather than `public`.
 *
 * Per-file isolation, for the same reason `db.test.ts` does it: `TEST_DATABASE_URL`
 * will sometimes be a database with data in it, and this suite drops tables. It
 * also lets the six scenario files run concurrently against one Postgres.
 */
export function scopedToSchema(url: string, schema: string): string {
  const options = encodeURIComponent(`-c search_path=${schema}`);
  return `${url}${url.includes("?") ? "&" : "?"}options=${options}`;
}

/**
 * The node's configuration, through `loadConfig` and a synthetic environment.
 *
 * Deliberately not a hand-built `Config` literal: `loadConfig` is where the
 * addresses file is read and checked, and where every bound is applied — a
 * literal would let this suite pass with a configuration no container could
 * produce.
 */
/**
 * **One object store, for every node this suite starts.**
 *
 * The devnet has no S3 and needs one: pinning is on the request path of both
 * write doors, so `loadConfig` refuses to start a node without the whole
 * `PIN_S3_*` group — and that refusal is deliberate (a node that booted
 * anyway would answer `503` to every post and every settle). This is the loopback
 * store that satisfies it, and it is the same one the unit suite uses, so what
 * the devnet exercises is the real `S3Pinner` against a real socket: a signed
 * PUT, a `x-amz-meta-cid` response header, and a name this node did not compute.
 *
 * Started at module load rather than in a `beforeAll` because {@link devnetEnv}
 * is synchronous and scenario 4 hands its result to a **separate `src/main.ts`
 * process** — which reaches this store over 127.0.0.1 exactly as an in-process
 * node does. `unref()` so it never holds the run open after the last file.
 */
const devnetStore = await startStubStore();
devnetStore.server.unref();

export function devnetEnv(options: NodeOptions): Env {
  return {
    ...devnetStore.env(),
    RPC_URL: options.rpcUrl ?? RPC_URL,
    DATABASE_URL: scopedToSchema(TEST_DATABASE_URL, options.schema),
    RELAYER_KEY: ANVIL_KEYS.relayer,
    ADDRESSES_FILE: ADDRESSES_FILE,
    GETLOGS_CAP: String(options.getLogsCap ?? PROXY_RANGE_CAP),
    READY_LAG_BLOCKS: String(options.readyLagBlocks ?? 7),
    BLOCK_TIME_MS: String(options.blockTimeMs ?? BLOCK_TIME_MS),
    PORT: String(options.port ?? nodePort()),
    ...options.env,
  };
}

/**
 * The environment and the `Config` it produces are separated because scenario 4
 * needs both: a real `src/main.ts` process is handed the environment, and the
 * test that drives it needs the `Config` to know which port to knock on. Read
 * `devnetEnv` once per node — it allocates the port.
 */
export function devnetConfig(options: NodeOptions): Config {
  return loadConfig(devnetEnv(options));
}

// ---------------------------------------------------------------------------
// A node
// ---------------------------------------------------------------------------

/** One JSON-RPC request the node made, and how the endpoint answered it. */
export interface RpcCall {
  method: string;
  params: unknown;
  /** The endpoint's error, when there was one — `-32005` is the one this suite reads. */
  error?: unknown;
}

/**
 * The real HTTP transport, with every request and every failure recorded.
 *
 * Wrapping `http()` rather than substituting `custom()` is deliberate: viem's
 * retry policy is part of what is under test here. `-32005` is in viem's
 * `shouldRetry` set (R42), so a window the proxy refuses costs four round trips,
 * not one — and a `custom()` transport built for this suite would have quietly
 * chosen its own policy and measured something else. Every attempt lands in the
 * log, so a scenario can see the refusals **and** knows better than to assert on
 * a count it has not accounted for.
 */
function recordingHttp(url: string, log: RpcCall[]): Transport {
  const base = http(url);
  return ((options) => {
    const created = base(options);
    return {
      ...created,
      async request(args: { method: string; params?: unknown }) {
        try {
          const result = await created.request(args as never);
          log.push({ method: args.method, params: args.params });
          return result;
        } catch (error) {
          log.push({ method: args.method, params: args.params, error });
          throw error;
        }
      },
    };
  }) as Transport;
}

/** `true` when this error, or anything in its cause chain, carries `-32005`. */
export function isLimitExceeded(error: unknown): boolean {
  for (let node: unknown = error, depth = 0; node != null && depth < 10; depth++) {
    const value = node as { code?: unknown; cause?: unknown };
    if (value.code === -32005) return true;
    node = value.cause;
  }
  return false;
}

export interface RunningNode {
  config: Config;
  /** Every JSON-RPC call this node made, in order. */
  rpc: RpcCall[];
  db: Db;
  chain: Chain;
  indexer: Indexer;
  /** `http://127.0.0.1:<ephemeral>` — a real socket, never `app.inject` (R79(b)). */
  baseUrl: string;
  /** Fetch against this node. Relative paths only. */
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  stop(): Promise<void>;
}

/**
 * Brings up one node in **this** process: store, chain, indexer and the HTTP
 * surface, in `src/main.ts`'s order — listen, then cold start (R82).
 *
 * In-process because most scenarios need to reach past the API: `cursor-gap`
 * stops and restarts an indexer, `range-cap` reads the RPC log, `cold-start`
 * compares tables. **Scenario 4 does not use this**: the boot order is the thing
 * it asserts, so it spawns the real `src/main.ts` through
 * {@link startNodeProcess} rather than trusting this to reproduce it.
 *
 * `coldStart` is left to the caller so a scenario can watch the window rather
 * than only its outcome.
 */
export async function startNode(
  options: NodeOptions,
  { coldStart = true }: { coldStart?: boolean } = {},
): Promise<RunningNode> {
  // The schema belongs to a chain, so its name says which (see `chainTag`). A
  // scenario passes its own base name and never has to know this happened; a
  // restart inside one run resolves to the same name and finds its rows intact.
  const scoped = { ...options, schema: await schemaFor(options.schema) };
  const config = devnetConfig(scoped);

  const admin = openDb(TEST_DATABASE_URL);
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${scoped.schema}`);
  } finally {
    await admin.close();
  }

  const db = openDb(config.dbUrl);
  await db.migrate();

  const rpc: RpcCall[] = [];
  const chain = makeChain(config, recordingHttp(config.rpcUrl, rpc));
  // The boot assertion, run here too (R6): it is the one check that proves this
  // suite is pointed at a chain whose payment token matches what every quote names.
  await assertDomains(chain.publicClient, config.addresses);

  const indexer = startIndexer(chain, db, config);
  const app = buildApp({ db, indexer, config, chain });

  await app.listen({ port: config.port, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the app did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  if (coldStart) await indexer.start();

  const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

  return {
    config,
    rpc,
    db,
    chain,
    indexer,
    baseUrl,
    request,
    async json<T>(path: string, init?: RequestInit) {
      const response = await request(path, init);
      const text = await response.text();
      return {
        status: response.status,
        body: (text === "" ? null : JSON.parse(text)) as T,
      };
    },
    async stop() {
      await Promise.allSettled([app.close(), indexer.stop()]);
      await db.close();
    },
  };
}

/** JSON body helper: the header every write door needs, and the encoding. */
export const jsonBody = (value: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

// ---------------------------------------------------------------------------
// A real `src/main.ts` process, and a valve on the RPC it cold starts through
// ---------------------------------------------------------------------------

/**
 * A JSON-RPC pass-through with a valve on `eth_getLogs`.
 *
 * Scenario 4 is about a **window** — the interval in which a process is
 * listening and its index is empty — and on this stack a full replay closes in
 * about a second, which is not a window a test can reliably stand inside.
 * Everything except `eth_getLogs` is forwarded untouched, so the boot assertion,
 * the head reads and every route this node serves are the real chain's answers;
 * only the replay is held, and only until the test says otherwise.
 *
 * `fail()` is the other half: a cold start that *fails* must close the server
 * rather than leave a process listening and permanently not-ready. `-32000` is
 * chosen deliberately over `-32603`: viem's `shouldRetry` includes the internal
 * error and not this one (R42), so the failure lands on the first attempt
 * instead of after a retry schedule.
 */
export interface RpcGate {
  url: string;
  /** Hold every `eth_getLogs` until {@link RpcGate.open} is called. */
  hold(): void;
  /** Refuse every `eth_getLogs` with a non-retryable JSON-RPC error. */
  fail(): void;
  /** Forward normally, releasing anything held. */
  open(): void;
  /** How many `eth_getLogs` the gate has seen. */
  seen(): number;
  close(): Promise<void>;
}

export async function startRpcGate(upstream = RPC_URL): Promise<RpcGate> {
  let mode: "open" | "hold" | "fail" = "open";
  let getLogs = 0;
  let released: () => void = () => {};
  let holding = new Promise<void>((resolve) => {
    released = resolve;
  });

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let id: unknown = null;
        let method = "";
        try {
          const parsed = JSON.parse(raw) as { id?: unknown; method?: string };
          id = parsed.id ?? null;
          method = parsed.method ?? "";
        } catch {
          // Not a single JSON-RPC object — forwarded as-is below.
        }

        if (method === "eth_getLogs") {
          getLogs += 1;
          if (mode === "hold") await holding;
          if (mode === "fail") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: "the gate is closed for this test" },
              }),
            );
            return;
          }
        }

        try {
          const upstreamResponse = await fetch(upstream, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw,
          });
          const body = await upstreamResponse.text();
          response.writeHead(upstreamResponse.status, { "content-type": "application/json" });
          response.end(body);
        } catch (error) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the gate did not bind");

  return {
    url: `http://127.0.0.1:${address.port}`,
    hold() {
      mode = "hold";
      holding = new Promise<void>((resolve) => {
        released = resolve;
      });
    },
    fail() {
      mode = "fail";
      released();
    },
    open() {
      mode = "open";
      released();
    },
    seen: () => getLogs,
    async close() {
      released();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** The repository root, which is `src/main.ts`'s working directory. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export interface NodeProcess {
  config: Config;
  baseUrl: string;
  /** A `Db` on the same schema, for arranging state the process will read. */
  db: Db;
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** Resolves with the process's exit code when it ends. */
  exited: Promise<number | null>;
  /** Everything the process wrote to stdout and stderr, for a failure message. */
  output(): string;
  /** SIGTERM, then the exit code. Safe to call after the process has already gone. */
  stop(): Promise<number | null>;
}

/**
 * Spawns the real `src/main.ts` as its own process.
 *
 * **This is the point of scenario 4.** The boot order is what is under test, so
 * a harness that reproduced it in-process would be asserting against its own
 * sequencing rather than the shipped binary's — the defect the previous round
 * reported was exactly that, one level up from R64/R65's stub problem. `node
 * --import tsx src/main.ts` is `npm start` without the npm wrapper, so signals
 * and exit codes reach this test directly instead of through a shell.
 *
 * The schema is created and migrated here, before the spawn, so a scenario can
 * arrange the state the process will boot into — an empty `cursor` above all,
 * which is what makes a cold start cold.
 */
export async function startNodeProcess(
  options: NodeOptions,
  { resetCursor = false }: { resetCursor?: boolean } = {},
): Promise<NodeProcess> {
  // Same resolution as `startNode`, and it has to be here too: this is the path
  // that spawns the real `src/main.ts`, and the environment it inherits is where
  // the schema name actually reaches the node.
  const scoped = { ...options, schema: await schemaFor(options.schema) };
  const env = devnetEnv(scoped);
  const config = loadConfig(env);

  const admin = openDb(TEST_DATABASE_URL);
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${scoped.schema}`);
  } finally {
    await admin.close();
  }

  const db = openDb(config.dbUrl);
  await db.migrate();
  if (resetCursor) await db.query("DELETE FROM cursor");

  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));

  // `close`, not `exit`: it fires once the process has gone **and** its stdio has
  // drained, so `output()` is complete when a failing assertion prints it.
  const exited = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  // A test that times out never reaches its `finally`, and this child holds a
  // port other runs will want. Observed during the mutation battery: an
  // unguarded cold start leaves a process listening forever, the test times out,
  // and without this the port stays taken until somebody notices.
  process.once("exit", () => child.kill("SIGKILL"));

  const baseUrl = `http://127.0.0.1:${config.port}`;
  const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

  return {
    config,
    baseUrl,
    db,
    request,
    async json<T>(path: string, init?: RequestInit) {
      const response = await request(path, init);
      const text = await response.text();
      return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
    },
    exited,
    output: () => output,
    async stop() {
      child.kill("SIGTERM");
      const code = await exited;
      await db.close();
      return code;
    },
  };
}

/** `true` when nothing is listening on this URL — the state before `app.listen`. */
export async function refusesConnections(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/readyz`);
    await response.text();
    return false;
  } catch {
    return true;
  }
}

/**
 * Waits until the process is answering at all, whatever it answers.
 *
 * Deliberately not {@link waitForReady}: the whole scenario is the interval
 * between *listening* and *ready*, and a helper that waited for `200` would step
 * straight over it.
 */
export async function waitForSocket(node: NodeProcess): Promise<number> {
  return waitFor(
    `${node.baseUrl} to accept connections`,
    async () => {
      const response = await node.request("/readyz");
      await response.text();
      return response.status;
    },
    { timeoutMs: 60_000, intervalMs: 100 },
  );
}

// ---------------------------------------------------------------------------
// The projection's lifecycle
// ---------------------------------------------------------------------------

/**
 * Wipes the derived projection, leaving the three non-derived tables (R47).
 *
 * The same `dropDerived` the README documents and `src/db/db.ts` owns — not a
 * `DROP SCHEMA`, and not a list retyped here. A scenario that wiped with its own
 * list would pass while the shipped rebuild path dropped something it must not.
 */
export async function wipeProjection(db: Db): Promise<void> {
  await dropDerived(db);
  await db.migrate();
}

/** Every row of a table, ordered, for the byte-identical comparison scenario 1 makes. */
export async function snapshotTable(
  db: Db,
  table: string,
  order: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query(`SELECT * FROM ${table} ORDER BY ${order}`);
  // `bigint` and `Buffer` do not compare structurally through vitest's default
  // equality in every position, and `JSON.stringify` throws on a `bigint` (R46).
  // Rendered to strings here, once, so a diff is readable and total.
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        Buffer.isBuffer(value) ? `0x${value.toString("hex")}` : String(value),
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Waiting, the only way a chain-facing test may wait (R2)
// ---------------------------------------------------------------------------

export class WaitTimeout extends Error {}

/** Polls `predicate` until it returns a value, or throws after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  predicate: () => Promise<T | null>,
  { timeoutMs = 90_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new WaitTimeout(
        `timed out after ${timeoutMs} ms waiting for ${what}` +
          (last === undefined ? "" : `; last error: ${String(last)}`),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Waits until the endpoint's own head has reached `block`.
 *
 * **The chain's answer, never an assumed one** (R2). The index follows `latest`,
 * so a transition is readable once the head has carried it and the cursor has
 * caught up — this is the first half and {@link waitForCursor} is the second. A
 * scenario that mined a fixed number of blocks and called the transition visible
 * would be a defect even while it passed.
 *
 * `cacheTime: 0` because viem caches `eth_blockNumber` for the chain's block
 * time by default, and a poll that re-reads its own cached answer is a poll that
 * cannot observe the head moving.
 */
export async function waitForHead(client: PublicClient, block: bigint): Promise<bigint> {
  return waitFor(`the head to reach block ${block}`, async () => {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    return head >= block ? head : null;
  });
}

/** Waits until the node's cursor has passed `block` — the index, not the chain. */
export async function waitForCursor(db: Db, block: bigint): Promise<bigint> {
  return waitFor(`the index cursor to reach block ${block}`, async () => {
    const { rows } = await db.query<{ block_number: bigint }>(
      "SELECT block_number FROM cursor WHERE id = 1",
    );
    const cursor = rows[0]?.block_number;
    return cursor !== undefined && cursor >= block ? cursor : null;
  });
}

/**
 * Waits until `GET /readyz` answers 200.
 *
 * Typed on the one member it uses, so it serves an in-process {@link RunningNode}
 * and a spawned {@link NodeProcess} alike — both answer over a real socket, and
 * "ready" means the same thing to either.
 */
export async function waitForReady(node: { request(path: string): Promise<Response> }): Promise<void> {
  await waitFor("the node to report ready", async () => {
    const response = await node.request("/readyz");
    await response.text();
    return response.status === 200 ? true : null;
  });
}

// ---------------------------------------------------------------------------
// Driving the chain directly
// ---------------------------------------------------------------------------

export const devnetChain = (chainId: number) =>
  defineChain({
    id: chainId,
    name: "vorq-fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

export function publicClientOf(chainId: number): PublicClient {
  return createPublicClient({ chain: devnetChain(chainId), transport: http(RPC_URL) }) as PublicClient;
}

/**
 * One call to the **uncapped** anvil's test-only namespace, and its result.
 *
 * The single place this suite is allowed to reach for a cheatcode. Everything
 * the node reads goes through the capped proxy on 8545, which answers `-32601`
 * to this whole namespace on purpose; arranging a chain *precondition* is a
 * different act from reading the chain, and keeping it to one function is what
 * keeps the difference visible.
 */
export async function anvilAdmin<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(ANVIL_ADMIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const answer = (await response.json()) as { result?: T; error?: { message?: string } };
  if (answer.error !== undefined) {
    throw new Error(
      `${method} refused at ${ANVIL_ADMIN_URL}: ${answer.error.message ?? "unknown"}. ` +
        "This scenario needs the uncapped anvil to establish its chain precondition.",
    );
  }
  return answer.result as T;
}

/**
 * `JobRegistry`'s tolerance on a signed op's `issuedAt`, either side of
 * `block.timestamp`. Ten minutes, and the contract is the authority:
 *
 * ```solidity
 * if (at + 600 < block.timestamp || at > block.timestamp + 600) revert StaleOp();
 * ```
 */
export const STALE_OP_WINDOW_SECONDS = 600n;

/**
 * Refuses to run against a chain whose clock is behind this machine's.
 *
 * **A check, not a repair.** `fork/bootstrap.sh` sets the chain's clock before it
 * deploys, and that is the only place it is set — a suite that quietly corrected
 * it here as well would be papering over a stack that had stopped doing its job,
 * and would leave the *other* consumers of that stack broken while this one went
 * green.
 *
 * Worth checking loudly, because the failure it catches is unreadable. A fork of
 * a live network does not start at "now": anvil takes the **pinned block's**
 * timestamp as its clock, so an unaligned chain boots however old the pin is —
 * measured at 14.7 hours, and growing by a day for every day the pin ages.
 * `JobRegistry` compares a signed op's `issuedAt` against `block.timestamp`
 * within {@link STALE_OP_WINDOW_SECONDS}, so every `claim`, `settle` and `fail`
 * then reverts `StaleOp()` — which reaches a test as a bare
 * `custom error 0x5276902d` and says nothing about clocks. Further out, `expiresAt`
 * goes the same way through `ExpiryTooFar()` and the posts stop too.
 */
async function assertChainClockAligned(): Promise<void> {
  const latest = await publicClientOf(CHAIN_ID).getBlock({ blockTag: "latest" });
  const hostNow = BigInt(Math.floor(Date.now() / 1000));
  // A tenth of the window: far enough inside it that this fires while ops still
  // work, rather than at the moment they start reverting.
  const behind = hostNow - latest.timestamp;
  if (behind <= STALE_OP_WINDOW_SECONDS / 10n) return;

  throw new Error(
    `the chain's clock is ${behind} s behind this machine's, which is past a tenth of the ` +
      `${STALE_OP_WINDOW_SECONDS} s window JobRegistry allows on a signed op's issuedAt — every ` +
      "claim, settle and fail would revert StaleOp() (0x5276902d). fork/bootstrap.sh aligns the " +
      "clock with anvil_setTime before it deploys, so this means the stack was not brought up by " +
      "it, or was brought up long enough ago for the drift to matter. Recreate it: " +
      "BASE_SEPOLIA_RPC_URL=… make -C ../vorq-evm-contracts/fork down && … make up",
  );
}

// At module load, like the object store above: every scenario file imports this
// module, and not one of them can sign an op against a chain whose clock is off.
await assertChainClockAligned();

/**
 * Mines empty blocks until the chain is at least `depth` blocks deep, and
 * answers the head it reached.
 *
 * **Why this exists.** `make down` discards the chain and the next `make up`
 * rebuilds it from the pinned fork block, so a **fresh, shallow chain is the
 * normal state**, not an accident. A scenario that needs a deep chain and does
 * not make one passes only when a long-lived stack happens to have accumulated
 * the depth and fails on a clean one. That is not an acceptance gate; it is a
 * coin toss on how long the machine has been up. So the precondition is
 * established here, explicitly, by the scenario that needs it.
 *
 * `depth` is an **absolute block number**, and on a fork that distinction is the
 * whole point: the chain begins at the pinned block, so "50 000 blocks deep" and
 * "50 000 blocks past `deployBlock`" are nowhere near each other, and only the
 * second is the depth a replay has to cross.
 *
 * **Measured cost on this fork: ~36 ms per block**, an order of magnitude worse
 * than the stack this replaced, because every block anvil mines writes EIP-2935's
 * block-hash history and each fresh slot is a round trip to the upstream Base
 * Sepolia endpoint. Only the shortfall is mined, so a chain already deep enough
 * costs one `eth_blockNumber` and nothing else.
 *
 * `interval = 0` on purpose: each block takes the **current wall-clock time**
 * rather than stepping a second per block. Stepping would put the chain's clock
 * ~14 hours into the future after 50 000 blocks, and every later scenario posts
 * orders whose `expiresAt` is relative to *this* machine's clock — `JobRegistry`
 * would then reject them as `AlreadyExpired`. Verified: after mining 10 000
 * blocks the head's timestamp equalled `date +%s`.
 *
 * The chunking is so a several-minute mine is a sequence of answered requests
 * rather than one HTTP call nothing can observe.
 */
export async function mineTo(chainId: number, depth: bigint): Promise<bigint> {
  const client = publicClientOf(chainId);
  // Read through 8545, the endpoint everything else reads through: the depth this
  // reports is the depth the node under test will see. `cacheTime: 0` because
  // viem caches `eth_blockNumber`, and a loop that re-read its own cached answer
  // would either spin or — after an `evm_revert` — believe in a head the chain
  // no longer has.
  let head = await client.getBlockNumber({ cacheTime: 0 });
  if (head >= depth) return head;

  const CHUNK = 5_000n;
  while (head < depth) {
    const batch = depth - head > CHUNK ? CHUNK : depth - head;
    // [count, interval] — see the note on `interval = 0` above.
    await anvilAdmin("anvil_mine", [`0x${batch.toString(16)}`, "0x0"]);
    head = await client.getBlockNumber({ cacheTime: 0 });
  }
  return head;
}

/**
 * Mines `count` blocks by sending that many self-transfers from the relayer.
 *
 * Distinct from {@link mineTo}: this produces blocks **with transactions in them**
 * through the endpoint under test, which is what a scenario wants when the blocks
 * have to look like real activity. `mineTo` produces empty depth as fast as the
 * chain will make it, which is what a scenario wants when it needs a *long* chain
 * and does not care what is in it.
 *
 * Each transfer carries a **nonce-unique payload**, so no two of these blocks can
 * ever hash the same. Empty blocks are a function of their parent and their
 * timestamp alone, and the reorg scenario turns on a replacement block being
 * distinguishable from the one it replaced — a self-transfer with no calldata is
 * reproducible enough to lose that distinction.
 */
export async function driveBlocks(chainId: number, count: number): Promise<bigint> {
  const account = privateKeyToAccount(ANVIL_KEYS.relayer);
  const chain = devnetChain(chainId);
  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const client = publicClientOf(chainId);

  let hash: Hex = "0x";
  for (let i = 0; i < count; i++) {
    hash = await wallet.sendTransaction({
      account,
      chain,
      to: account.address,
      value: 0n,
      data: keccak256(Buffer.from(`drive-${Date.now()}-${i}-${Math.random()}`, "utf8")),
    });
    await client.waitForTransactionReceipt({ hash });
  }
  const receipt = await client.getTransactionReceipt({ hash });
  return receipt.blockNumber;
}

/**
 * Runs `SmokeFlow` against the fork stack — a real post → claim → settle.
 *
 * The three keys are passed explicitly because the script requires them with no
 * defaults: the client signs the order and the USDC authorization, the provider
 * operator signs claim and settle, and the deployer relays every transaction.
 * They are the same literals `fork/docker-compose.yml` gives the bootstrap and
 * `fork/Makefile` gives `make smoke`, so what runs here is the stack's own gate.
 */
export function runSmokeFlow(): string {
  return execFileSync(
    "forge",
    [
      "script",
      "script/SmokeFlow.s.sol",
      "--rpc-url",
      RPC_URL,
      "--broadcast",
      // 84532 is Base Sepolia, a chain foundry keeps an on-disk fork cache for,
      // and this stack restarts at the same block height every time — so without
      // this a run can be served a slot a previous fork recorded at that height.
      "--no-storage-caching",
    ],
    {
      cwd: CONTRACTS_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DEPLOYER_PK: ANVIL_KEYS.relayer,
        PROVIDER_PK: ANVIL_KEYS.provider,
        CLIENT_PK: ANVIL_KEYS.client,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// The client's side: build a container, quote, sign, post
// ---------------------------------------------------------------------------

/** A container v1 and the commitment it produces. See `src/container.ts`. */
export interface TaskContainer {
  /** `version ‖ seed_wrap ‖ ciphertext`, ready to go on the wire as base64. */
  bytes: Buffer;
  /** `keccak256(version ‖ seed_wrap ‖ keccak256(ciphertext))` — what the order signs. */
  c: Hex;
}

/**
 * A fresh container, and the `c` it commits to.
 *
 * **The client no longer chooses `c` and no longer pins anything.** It assembles
 * the container, derives the commitment from it, signs that, and hands the bytes
 * to the node with the payment — the node pins them and mints the name. So a
 * scenario cannot invent a `c` any more: an invented one would not reproduce from
 * the bytes and `POST /v1/jobs` would refuse it, which is exactly the check this
 * suite exists to exercise end to end.
 *
 * The wrap is random, which is what keeps `c` — and therefore
 * `jobId = keccak256(owner ‖ c)` — unique per call, the same duplicate-avoidance
 * this helper always provided (R37).
 */
export function freshContainer(label: string): TaskContainer {
  const bytes = Buffer.concat([
    CONTAINER_TAG,
    randomBytes(SEED_WRAP_BYTES),
    Buffer.from(`${label}-${Date.now()}-${Math.random()}`, "utf8"),
  ]);
  return { bytes, c: commitmentOf(bytes) };
}

/** Terms over a container's commitment. */
export function freshTerms(c: Hex, overrides: Partial<Terms> = {}): Terms {
  return {
    c,
    modelId: 1n,
    slaSecs: 3600n,
    rateIn: 30_000n,
    rateOut: 90_000n,
    unitsIn: 1000n,
    unitsOut: 2000n,
    designated: 0n,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  };
}

/**
 * The order members of a `POST /v1/jobs` body. No `task_cid`: the node mints it.
 *
 * **Flat**, because the door is: `parseOrder` reads `c`, `owner`, `job_id`, the
 * nine chain members and `signature` straight off the body, with no envelope,
 * and `auth_sig` / `amount` / `container` sit beside them. A `{ vorq: … }`
 * wrapper is answered `400 "c must be a string"`.
 */
export const wireOrder = (terms: Terms, owner: ViemAddress, signature: Hex) => ({
  job_id: jobIdOf(owner as Address, terms.c),
  c: terms.c,
  model_id: Number(terms.modelId),
  sla_secs: Number(terms.slaSecs),
  rate_in: formatUsd(terms.rateIn, 6),
  rate_out: formatUsd(terms.rateOut, 6),
  units_in: Number(terms.unitsIn),
  units_out: Number(terms.unitsOut),
  designated: Number(terms.designated),
  expires_at: Number(terms.expiresAt),
  owner,
  signature,
});

export interface PostedJob {
  jobId: Hex;
  txHash: Hex;
  blockNumber: bigint;
  terms: Terms;
  /** The name the node's own pin minted, off the `201`. Nothing else knows it. */
  taskCid: string;
}

/**
 * The whole client flow through the node: 402 challenge, authorization, resubmit.
 *
 * Signs with viem, exactly as a client SDK would (Anvil key #4), and **sends
 * nothing itself** — the node relays and pays.
 */
/**
 * The half of a node a post needs: its configuration, and a way to reach it.
 *
 * Both {@link RunningNode} and {@link NodeProcess} satisfy this structurally, and
 * that is the point — Plan 3's escrow scenarios drive **spawned** instances, and a
 * `postJob` typed on the in-process node would have forced either a second copy
 * of the 402/authorization/resubmit dance or an in-process node this suite has no other
 * reason to build.
 */
export interface JobPoster {
  config: Config;
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
}

export async function postJob(
  node: JobPoster,
  task: TaskContainer,
  terms: Terms,
  client = clientAccount(),
): Promise<PostedJob> {
  const { addresses } = node.config;
  const orderSig = await client.signTypedData(
    orderTypedData(addresses.chainId, addresses.jobRegistry, terms) as never,
  );
  const body = wireOrder(terms, client.address, orderSig);

  // **The challenge carries no container**, and that is the protocol rather than
  // an economy: a body carrying the bytes is a complete submission and the node
  // refuses to answer one with a quote, precisely so this second round trip does
  // not cost the upload twice. The 402 comes first and carries the amount to
  // sign; it is read from the challenge rather than recomputed, because R7 makes
  // the echoed amount the thing the node verifies against.
  const challenge = await node.json<{ quote: { amount: string } }>("/v1/jobs", jsonBody(body));
  if (challenge.status !== 402) {
    throw new Error(`expected 402, got ${challenge.status}: ${JSON.stringify(challenge.body)}`);
  }
  const amount = BigInt(challenge.body.quote.amount);

  const jobId = jobIdOf(client.address as Address, terms.c);
  const authSig = await client.signTypedData(
    authorizationTypedData(addresses, {
      from: client.address as Address,
      to: addresses.jobRegistry,
      value: amount,
      validBefore: terms.expiresAt + 1n,
      jobId,
    }) as never,
  );

  // The bytes ride with the payment, and only here.
  const posted = await node.json<{ job_id: Hex; tx_hash: Hex; task_cid: string }>(
    "/v1/jobs",
    jsonBody({
      ...body,
      container: task.bytes.toString("base64"),
      auth_sig: authSig,
      amount: formatUsd(amount, 6),
    }),
  );
  if (posted.status !== 201) {
    throw new Error(`POST /v1/jobs answered ${posted.status}: ${JSON.stringify(posted.body)}`);
  }
  if (typeof posted.body.task_cid !== "string" || posted.body.task_cid === "") {
    // The caller cannot compute this name and has nothing to read it from until
    // the post is indexed, so a `201` without it is a job whose payload the
    // client can never locate.
    throw new Error(`POST /v1/jobs answered 201 without a task_cid: ${JSON.stringify(posted.body)}`);
  }

  const receipt = await publicClientOf(addresses.chainId).getTransactionReceipt({
    hash: posted.body.tx_hash,
  });
  return {
    jobId,
    txHash: posted.body.tx_hash,
    blockNumber: receipt.blockNumber,
    terms,
    taskCid: posted.body.task_cid,
  };
}

/** `cap + feeCap + gasFee`, as the 402 computes it. Exported so a scenario can check the quote. */
export const amountOf = (terms: Terms, gasFee: bigint, feeBps: number): bigint =>
  capOf(terms) + feeOf(capOf(terms), feeBps) + gasFee;

/** `Order.taskCid` as the contract stores it. */
export { taskCidHex };

// ---------------------------------------------------------------------------
// The provider's side: a session, and signed ops the node relays
// ---------------------------------------------------------------------------

const SESSION_TYPES = {
  VorqSession: [
    { name: "address", type: "address" },
    { name: "nonce", type: "string" },
  ],
} as const;

/** The handshake, exactly as the emulator spells it. Returns the bearer token. */
export async function openSession(
  node: RunningNode,
  account: PrivateKeyAccount,
  role: "client" | "provider",
): Promise<string> {
  const challenge = await node.json<{ nonce: string; chain_id: number }>(
    `/auth/nonce?address=${account.address}`,
  );
  if (challenge.status !== 200) {
    throw new Error(`GET /auth/nonce answered ${challenge.status}`);
  }
  const signature = await account.signTypedData({
    domain: sessionDomain(challenge.body.chain_id),
    types: SESSION_TYPES,
    primaryType: "VorqSession",
    message: { address: account.address, nonce: challenge.body.nonce },
  });
  const session = await node.json<{ token: string }>(
    "/auth/session",
    jsonBody({
      address: account.address,
      nonce: challenge.body.nonce,
      signature,
      role,
    }),
  );
  if (session.status !== 200) {
    throw new Error(`POST /auth/session answered ${session.status}: ${JSON.stringify(session.body)}`);
  }
  return session.body.token;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The JOB registry's EIP-712 domain — every caller here signs a job op.
 *
 * The three registries now declare distinct names, so this one is not reusable
 * for a provider- or ask-registry op: it would recover a stranger.
 */
export const opDomain = (chainId: number, verifyingContract: Address) =>
  ({ name: EIP712_NAMES.job, version: "2", chainId, verifyingContract }) as const;

export const CLAIM_TYPES = {
  Claim: [
    { name: "jobId", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/**
 * `Settle(bytes32 jobId,uint32 completionTok,uint64 issuedAt)`.
 *
 * `resultCid` is not a member. The provider hands the result bytes to the node,
 * which pins them and learns the name from the store — a name that does not exist
 * when the op is signed. `submitAndSettle` still takes the CID and its selector
 * is unchanged, so the ABI carries none of this and the type string is the whole
 * difference.
 */
export const SETTLE_TYPES = {
  Settle: [
    { name: "jobId", type: "bytes32" },
    { name: "completionTok", type: "uint32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));
