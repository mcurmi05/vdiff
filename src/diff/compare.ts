import type { SymbolTable } from "./symbols.js";

export interface BreakingChange {
  type:
    | "export_removed"
    | "export_kind_changed"
    | "signature_changed"
    | "member_removed"
    | "member_changed"
    | "export_added";
  symbol: string;
  before?: string | string[];
  after?: string | string[];
  note: string;
}

/** Diff two export tables. Breaking items first, then informational additions. */
export function compare(from: SymbolTable, to: SymbolTable): BreakingChange[] {
  const changes: BreakingChange[] = [];

  for (const [name, a] of Object.entries(from)) {
    const b = to[name];
    if (!b) {
      changes.push({
        type: "export_removed",
        symbol: name,
        before: a.signatures.length ? a.signatures : undefined,
        note: `Export '${name}' (${a.kind}) no longer exists in the target version.`,
      });
      continue;
    }
    if (a.kind !== b.kind) {
      changes.push({
        type: "export_kind_changed",
        symbol: name,
        before: a.kind,
        after: b.kind,
        note: `'${name}' changed from ${a.kind} to ${b.kind}.`,
      });
      continue;
    }
    if (!sameSignatures(a.signatures, b.signatures)) {
      changes.push({
        type: "signature_changed",
        symbol: name,
        before: a.signatures,
        after: b.signatures,
        note: signatureNote(name, a.signatures, b.signatures),
      });
    }
    if (a.members && b.members) {
      for (const [member, sigA] of Object.entries(a.members)) {
        const sigB = b.members[member];
        if (!sigB) {
          changes.push({
            type: "member_removed",
            symbol: `${name}.${member}`,
            before: sigA,
            note: `Member '${member}' was removed from ${a.kind} '${name}'.`,
          });
        } else if (!sameSignatures(sigA, sigB)) {
          changes.push({
            type: "member_changed",
            symbol: `${name}.${member}`,
            before: sigA,
            after: sigB,
            note: `Member '${member}' of '${name}' changed its type or signature.`,
          });
        }
      }
    }
  }

  for (const [name, b] of Object.entries(to)) {
    if (!from[name]) {
      changes.push({
        type: "export_added",
        symbol: name,
        after: b.signatures.length ? b.signatures : undefined,
        note: `New export '${name}' (${b.kind}) — informational, not breaking.`,
      });
    }
  }

  return changes;
}

function sameSignatures(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = [...b].sort();
  return [...a].sort().every((s, i) => s === sb[i]);
}

function signatureNote(name: string, before: string[], after: string[]): string {
  const pa = paramCount(before[0]);
  const pb = paramCount(after[0]);
  if (before.length && after.length && pa !== pb) {
    return `'${name}' parameter count changed (${pa} → ${pb}). Check call sites.`;
  }
  return `'${name}' signature changed. Compare before/after and update call sites.`;
}

function paramCount(sig: string | undefined): number {
  if (!sig) return 0;
  const inner = sig.slice(1, sig.lastIndexOf(") =>") >= 0 ? sig.lastIndexOf(") =>") : sig.length);
  if (!inner.trim()) return 0;
  // count top-level commas only (ignore commas inside nested (), <>, {}, [])
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if ("(<{[".includes(ch)) depth++;
    else if (")>}]".includes(ch)) depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}
