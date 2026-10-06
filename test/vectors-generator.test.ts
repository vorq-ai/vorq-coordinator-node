import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/gen-vectors.mjs` against the file it is supposed to have produced.
 *
 * **This is what makes the vectors file a generated artifact rather than a
 * document that was generated once.** `container-v1.json` is copied byte for
 * byte into both SDKs, so a hand edit here — a comment reworded, one hex digit
 * corrected — is a silent cross-language divergence: the copies still match each
 * other and no longer match any implementation. Regenerating is the only
 * supported way to change it, and this is the assertion that says so.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VECTORS_PATH = fileURLToPath(new URL("./vectors/container-v1.json", import.meta.url));

describe("scripts/gen-vectors.mjs", () => {
  it("reproduces the committed test/vectors/container-v1.json byte for byte", () => {
    const out = join(mkdtempSync(join(tmpdir(), "vorq-vectors-")), "container-v1.json");

    execFileSync(
      join(ROOT, "node_modules", ".bin", "tsx"),
      [join(ROOT, "scripts", "gen-vectors.mjs")],
      { cwd: ROOT, env: { ...process.env, VECTORS_OUT: out }, stdio: "pipe" },
    );

    // Buffers, not strings: this is a byte-identity claim, and a trailing
    // newline or a BOM is exactly the kind of difference a string compare of
    // parsed JSON would hide.
    expect(readFileSync(out)).toEqual(readFileSync(VECTORS_PATH));
  }, 60_000);
});
