import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatUsd, parseUsd, UsdError } from "../src/money.js";

interface Case {
  decimals: number;
  usd: string;
  atomic?: string;
  formats_as?: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/money-v1.json", import.meta.url), "utf8"),
) as { canonical: Case[]; parse_only: Case[]; refused: Case[] };

describe("money-v1 vectors", () => {
  it.each(vectors.canonical)("$usd at $decimals decimals round-trips", ({ usd, decimals, atomic }) => {
    expect(parseUsd(usd, decimals)).toBe(BigInt(atomic!));
    expect(formatUsd(BigInt(atomic!), decimals)).toBe(usd);
  });

  it.each(vectors.parse_only)("$usd parses, and formats as $formats_as", ({ usd, decimals, atomic, formats_as }) => {
    expect(parseUsd(usd, decimals)).toBe(BigInt(atomic!));
    expect(formatUsd(BigInt(atomic!), decimals)).toBe(formats_as);
  });

  it.each(vectors.refused)("refuses $usd at $decimals decimals", ({ usd, decimals }) => {
    expect(() => parseUsd(usd, decimals)).toThrow(UsdError);
  });
});
