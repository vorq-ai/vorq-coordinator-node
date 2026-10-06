/**
 * What the storage service actually costs, against a real bucket.
 *
 * `docs/pinning-spike.md` §5/§6 leaves two things open — **write latency** and
 * **per-request pricing** — and says both close the same way: point the S3 group
 * at a real bucket and exercise the node's write path. This is that run. It
 * measures rather than asserts, because there is no correct answer to assert: the
 * numbers are a property of somebody's bucket on some day, and what they decide is
 * `PIN_CONCURRENCY` and whether a 50 000-line batch is minutes or hours.
 *
 * ## Why it is a script and not a test
 *
 * It spends money and it takes wall-clock time proportional to the network, so it
 * must never run in a suite. It is also not pass/fail: a p95 of 400 ms is not
 * wrong, it is a number that sizes a constant. A test would have to invent a
 * threshold, and an invented threshold is a flake with a moral.
 *
 * ## Running it
 *
 *     set -a && source .env.pin && set +a
 *     npm run bench:pin              # the default shape
 *     npm run bench:pin -- --lines 50000 --line-bytes 3072
 *
 * It needs the same `PIN_S3_*` group the node boots on and nothing else. A
 * second run of the same shape files the same bytes again; the store mints the
 * same names, and the pinner deletes each duplicate object it just completed, so
 * the run leaves no more behind than the first.
 *
 * ## What it reports, and why each number is here
 *
 *   * **latency by size**, at the three sizes this node actually files: a sealed
 *     container (small), a manifest (medium), and a batch input file (large,
 *     which crosses `PART_BYTES` and therefore becomes a multipart upload).
 *   * **requests per object**, because that is the billing unit. A multipart
 *     upload is `2 + ceil(size / PART_BYTES)` requests, not one, and at
 *     per-request pricing that is the difference the spike could not cost.
 *   * **sustained throughput at `PIN_CONCURRENCY`**, which is the only number
 *     that sizes the worker: a batch pins one container per line, and the pass
 *     takes `lines / throughput` however fast one pin is.
 *   * **the extrapolation**, stated as requests and wall time for a batch of the
 *     shape the flags name, so the answer is in the units an operator plans in.
 */

import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/db.js";
import { PART_BYTES, put, S3Pinner } from "../src/pin/pinner.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** The batch shape the extrapolation is for. OpenAI's line cap, a plausible line. */
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  flags.set((process.argv[i] ?? "").replace(/^--/, ""), process.argv[i + 1] ?? "");
}
const LINES = Number(flags.get("lines") ?? 50_000);
const LINE_BYTES = Number(flags.get("line-bytes") ?? 3 * KIB);
/** How many objects each latency sample files. Small, because this costs money. */
const SAMPLES = Number(flags.get("samples") ?? 12);
/** The worker's own pinning concurrency, which this run exists to size. */
const CONCURRENCY = Number(flags.get("concurrency") ?? 8);

interface Shape {
  name: string;
  bytes: number;
  /** What this object is in the running system, so the number has a referent. */
  what: string;
}

const SHAPES: Shape[] = [
  { name: "container", bytes: 2 * KIB, what: "one sealed line — the batch worker files one per line" },
  { name: "manifest", bytes: 256 * KIB, what: "a 50k-line batch's manifest" },
  { name: "input-file", bytes: 24 * MIB, what: "a batch input file — crosses PART_BYTES, so multipart" },
];

/** Distinct bytes per sample, so no put is a no-op re-put of the last one. */
function body(shape: Shape, salt: number): Buffer {
  const buffer = Buffer.alloc(shape.bytes, 0x61);
  buffer.write(`vorq-bench-${shape.name}-${salt}-`, 0, "utf8");
  return buffer;
}

const ms = (from: bigint): number => Number(process.hrtime.bigint() - from) / 1e6;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[at] ?? 0;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** `2 + ceil(size / PART_BYTES)`: every object is a multipart upload. */
const requestsFor = (bytes: number): number => 2 + Math.max(1, Math.ceil(bytes / PART_BYTES));

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbUrl);
  const pinner = new S3Pinner(config.pinS3, db);

  console.log(`endpoint ${config.pinS3.endpoint}  bucket ${config.pinS3.bucket}` +
    `  region ${config.pinS3.region}  part ${PART_BYTES / MIB} MiB\n`);

  const perShape = new Map<string, { write: number[]; read: number[] }>();

  for (const shape of SHAPES) {
    const write: number[] = [];
    const read: number[] = [];
    // The large shape is sampled less: it is the one that costs bandwidth, and
    // its variance is dominated by the transfer rather than by the round trip.
    const samples = shape.bytes >= MIB ? Math.max(3, Math.floor(SAMPLES / 4)) : SAMPLES;

    for (let i = 0; i < samples; i += 1) {
      const bytes = body(shape, i);
      const started = process.hrtime.bigint();
      const cid = await put(pinner, bytes);
      write.push(ms(started));

      const readStarted = process.hrtime.bigint();
      const back = await pinner.fetch(cid, { maxBytes: shape.bytes });
      read.push(ms(readStarted));

      // The round trip is the one thing here that IS pass/fail: a benchmark of a
      // store that does not return what it was given measures nothing.
      if (back === null || createHash("sha256").update(back).digest("hex") !==
          createHash("sha256").update(bytes).digest("hex")) {
        throw new Error(`round trip failed for ${shape.name}: the store did not return the bytes`);
      }
    }
    write.sort((a, b) => a - b);
    read.sort((a, b) => a - b);
    perShape.set(shape.name, { write, read });

    const requests = requestsFor(shape.bytes);
    console.log(`${shape.name.padEnd(11)} ${String(shape.bytes / KIB).padStart(7)} KiB` +
      `  ${requests} req/put` +
      `   put p50 ${String(round(quantile(write, 0.5))).padStart(7)} ms` +
      `  p95 ${String(round(quantile(write, 0.95))).padStart(7)} ms` +
      `   get p50 ${String(round(quantile(read, 0.5))).padStart(7)} ms`);
    console.log(`${"".padEnd(11)} ${shape.what}`);
  }

  // --- sustained throughput, which is what sizes the worker -------------------
  //
  // One pin's latency does not size a pass: the worker files `PIN_CONCURRENCY` at
  // once, and what it gets is somewhere between `concurrency / latency` and the
  // service's own rate limit. Only measuring it says which.
  console.log(`\nsustained: ${CONCURRENCY} concurrent container-sized puts`);
  const container = SHAPES[0] as Shape;
  const rounds = 4;
  const startedAll = process.hrtime.bigint();
  let filed = 0;
  for (let round_ = 0; round_ < rounds; round_ += 1) {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, lane) =>
        put(pinner, body(container, 1000 + round_ * CONCURRENCY + lane)),
      ),
    );
    filed += CONCURRENCY;
  }
  const elapsed = ms(startedAll) / 1000;
  const perSecond = filed / elapsed;
  // Three decimals, because against a loopback store the whole run lands inside
  // one second and `0 s` reads as a broken measurement rather than a fast one.
  console.log(`  ${filed} objects in ${elapsed.toFixed(3)} s = ${round(perSecond)} pins/s`);
  if (perSecond > 200) {
    console.log(
      `  NOTE: ${round(perSecond)} pins/s is faster than any hosted store's published rate\n` +
      `  limit, so this is a loopback or same-region measurement. The extrapolation\n` +
      `  below is a floor on the wall time, not an estimate of it.`,
    );
  }

  // --- what that means for a batch -------------------------------------------
  const fileBytes = LINES * LINE_BYTES;
  const requests =
    requestsFor(fileBytes) + // the input file, as the client uploads it
    LINES + // one container per line
    1; // the manifest
  const pinSeconds = LINES / Math.max(perSecond, 0.0001);
  console.log(
    `\na ${LINES.toLocaleString()}-line batch at ${LINE_BYTES} B/line ` +
    `(${round(fileBytes / MIB)} MiB input file):\n` +
    `  ${requests.toLocaleString()} store requests\n` +
    `  ~${round(pinSeconds / 60)} min of pinning at the measured rate, ` +
    `before a single transaction is signed`,
  );
  console.log(
    `\nPIN_CONCURRENCY is ${CONCURRENCY} here. The number to carry back into ` +
    `src/batches/worker.ts is\nwhichever of "pins/s" and the service's published ` +
    `rate limit is smaller — and the\nminutes above are what a caller waits in ` +
    `\`validating\`.`,
  );

  await db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
