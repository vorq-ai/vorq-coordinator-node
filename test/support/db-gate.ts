import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **R25's gate, made audible (B-1).**
 *
 * A third of this suite is gated on `TEST_DATABASE_URL` — ten files and ~160
 * assertions, including the frozen-body evidence and the whole `jsonb` boundary
 * R54a exists for. The count is read from the files rather than written here, so
 * it cannot go stale. That gating is deliberate: `npm test` must run with no
 * database, and it does. What was not deliberate is that it happened in
 * **silence**. `describe.skipIf` prints a skip count nobody reads as a warning,
 * so a run that proved a third less than it looked like proving was
 * indistinguishable from a run that proved everything, and the review found the
 * shape that hides best in that gap: dropping a load-bearing `::text` cast is
 * completely invisible without Postgres and red the moment it is there.
 *
 * So the run says so, in one line, naming the number and what to do about it.
 * It is not an error — the no-database path is a supported way to run — and
 * `npm run test:ci` is the configuration that refuses to start without one.
 */

const TEST_DIR = fileURLToPath(new URL("../", import.meta.url));

/** Unit test files whose assertions are gated on a database being present. */
function gatedFiles(dir = TEST_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // `test/devnet/**` is the other project and is never part of `npm test`.
    if (entry.isDirectory()) {
      if (entry.name !== "devnet") gatedFiles(path, found);
    } else if (entry.name.endsWith(".test.ts")) {
      const source = readFileSync(path, "utf8");
      if (source.includes("skipIf(!TEST_DATABASE_URL)")) found.push(entry.name);
    }
  }
  return found;
}

export function setup(): void {
  if (process.env.TEST_DATABASE_URL !== undefined && process.env.TEST_DATABASE_URL !== "") return;

  const gated = gatedFiles().sort();
  // `process.stderr` rather than a logger: this has to survive vitest's reporter
  // and be visible in a CI log that shows only the tail of a run.
  process.stderr.write(
    `\n  TEST_DATABASE_URL is not set. ${gated.length} test files skip their database-gated\n` +
      `  assertions, including the frozen response bodies and the whole jsonb boundary:\n` +
      `    ${gated.join(", ")}\n` +
      `  This run cannot see a defect in any of them. Close the gate with:\n` +
      `    npm run test:ci   (refuses to start without TEST_DATABASE_URL)\n\n`,
  );
}
