import { rm } from "node:fs/promises";
import { downloadTypes, type Packument } from "../registry/npm.js";
import { compare, type BreakingChange } from "./compare.js";
import { extractSymbols } from "./symbols.js";

export interface DiffResult {
  breaking_changes: BreakingChange[];
  confidence_score: number;
  source_tier: "structural";
}

/** Download both versions' declarations, extract exports, diff them. */
export async function computeDiff(
  packument: Packument,
  from: string,
  to: string,
): Promise<DiffResult> {
  const [dirA, dirB] = await Promise.all([
    downloadTypes(packument, from),
    downloadTypes(packument, to),
  ]);
  try {
    const tableA = extractSymbols(dirA);
    const tableB = extractSymbols(dirB);
    return {
      breaking_changes: compare(tableA, tableB),
      // structural .d.ts diff: high confidence, but type-level only (spec §13)
      confidence_score: 0.9,
      source_tier: "structural",
    };
  } finally {
    await Promise.all([
      rm(dirA, { recursive: true, force: true }),
      rm(dirB, { recursive: true, force: true }),
    ]);
  }
}
