import { rm } from "node:fs/promises";
import semver from "semver";
import {
  downloadTypes,
  fetchPackument,
  NotFoundError,
  type Packument,
} from "../registry/npm.js";
import { compare, type BreakingChange } from "./compare.js";
import { extractSymbols, NoTypesError, type SymbolTable } from "./symbols.js";

export interface DiffResult {
  breaking_changes: BreakingChange[];
  confidence_score: number;
  source_tier: "structural";
  types_source: { from: string; to: string };
}

/** Download both versions' declarations, extract exports, diff them. */
export async function computeDiff(
  packument: Packument,
  from: string,
  to: string,
): Promise<DiffResult> {
  const [a, b] = await Promise.all([
    tableFor(packument, from),
    tableFor(packument, to),
  ]);
  const bothBundled = a.source === "bundled" && b.source === "bundled";
  return {
    breaking_changes: compare(a.table, b.table),
    // structural .d.ts diff: high confidence, type-level only (spec §13).
    // @types/* declarations are community-maintained and can drift from the
    // package's real surface, so they score lower.
    confidence_score: bothBundled ? 0.9 : 0.8,
    source_tier: "structural",
    types_source: { from: a.source, to: b.source },
  };
}

/**
 * Symbol table for one version: bundled `.d.ts` first, DefinitelyTyped
 * (`@types/*`) fallback second. `source` is 'bundled' or '@types/x@1.2.3'.
 */
async function tableFor(
  packument: Packument,
  version: string,
): Promise<{ table: SymbolTable; source: string }> {
  const dir = await downloadTypes(packument, version);
  try {
    return { table: extractSymbols(dir), source: "bundled" };
  } catch (err) {
    if (!(err instanceof NoTypesError)) throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const typesName = typesPackageName(packument.name);
  let typesPack: Packument;
  try {
    typesPack = await fetchPackument(typesName);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new NoTypesError(
        `${packument.name}@${version} ships no bundled type declarations and ${typesName} does not exist`,
      );
    }
    throw err;
  }
  const typesVersion = matchTypesVersion(typesPack, version);
  if (!typesVersion) {
    throw new NoTypesError(
      `${packument.name}@${version} ships no bundled type declarations and no ${typesName} version matches ${semver.major(version)}.${semver.minor(version)}.x`,
    );
  }
  const typesDir = await downloadTypes(typesPack, typesVersion);
  try {
    return {
      table: extractSymbols(typesDir),
      source: `${typesName}@${typesVersion}`,
    };
  } finally {
    await rm(typesDir, { recursive: true, force: true });
  }
}

/** npm name → DefinitelyTyped name: lodash → @types/lodash, @babel/core → @types/babel__core */
export function typesPackageName(name: string): string {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    return `@types/${scope}__${pkg}`;
  }
  return `@types/${name}`;
}

/**
 * DefinitelyTyped convention: @types versions track the package's
 * major.minor. Pick the highest @types patch for the target's major.minor;
 * fall back to the highest @types version with the same major.
 */
export function matchTypesVersion(
  typesPack: Pick<Packument, "versions">,
  target: string,
): string | null {
  const major = semver.major(target);
  const minor = semver.minor(target);
  const all = Object.keys(typesPack.versions).filter((v) => semver.valid(v));
  const exact = all.filter((v) => semver.major(v) === major && semver.minor(v) === minor);
  if (exact.length) return semver.rsort(exact)[0];
  const sameMajor = all.filter((v) => semver.major(v) === major);
  if (sameMajor.length) return semver.rsort(sameMajor)[0];
  return null;
}
