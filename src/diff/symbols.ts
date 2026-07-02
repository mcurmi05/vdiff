import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface SymbolInfo {
  kind: string; // 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum' | 'namespace'
  /** Normalized call-signature strings, for callable exports. */
  signatures: string[];
  /** For classes/interfaces: member name → signature/type strings. */
  members?: Record<string, string[]>;
}

export type SymbolTable = Record<string, SymbolInfo>;

export class NoTypesError extends Error {}

/**
 * Build a table of a package's public exports from its bundled `.d.ts` files.
 * `pkgDir` is an extracted package root containing package.json + declarations.
 */
export function extractSymbols(pkgDir: string): SymbolTable {
  const entry = findTypesEntry(pkgDir);
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noResolve: false,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new NoTypesError(`could not load types entry: ${entry}`);

  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    throw new NoTypesError(
      "types entry has no module exports (ambient/global declarations are not supported yet)",
    );
  }

  const table: SymbolTable = {};
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const resolved =
      exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    table[exp.getName()] = describeSymbol(resolved, checker);
  }
  return table;
}

function describeSymbol(sym: ts.Symbol, checker: ts.TypeChecker): SymbolInfo {
  const decl = sym.declarations?.[0];
  const type = decl
    ? checker.getTypeOfSymbolAtLocation(sym, decl)
    : checker.getDeclaredTypeOfSymbol(sym);

  const info: SymbolInfo = { kind: symbolKind(sym), signatures: [] };

  for (const sig of type.getCallSignatures()) {
    info.signatures.push(normalizeSignature(sig, checker));
  }

  if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
    const declared = checker.getDeclaredTypeOfSymbol(sym);
    const members: Record<string, string[]> = {};
    for (const prop of checker.getPropertiesOfType(declared)) {
      if (prop.getName().startsWith("_")) continue; // conventionally private
      const propDecl = prop.declarations?.[0];
      if (propDecl && ts.canHaveModifiers(propDecl)) {
        const mods = ts.getModifiers(propDecl);
        if (
          mods?.some(
            (m) =>
              m.kind === ts.SyntaxKind.PrivateKeyword ||
              m.kind === ts.SyntaxKind.ProtectedKeyword,
          )
        )
          continue;
      }
      const propType = propDecl
        ? checker.getTypeOfSymbolAtLocation(prop, propDecl)
        : checker.getTypeOfSymbol(prop);
      const calls = propType.getCallSignatures();
      members[prop.getName()] = calls.length
        ? calls.map((s) => normalizeSignature(s, checker))
        : [checker.typeToString(propType)];
    }
    info.members = members;
  }

  return info;
}

function normalizeSignature(sig: ts.Signature, checker: ts.TypeChecker): string {
  const params = sig.parameters.map((p) => {
    const d = p.declarations?.[0];
    const optional =
      d && ts.isParameter(d) && (d.questionToken !== undefined || d.initializer !== undefined);
    const rest = d && ts.isParameter(d) && d.dotDotDotToken !== undefined;
    const t = d
      ? checker.typeToString(checker.getTypeOfSymbolAtLocation(p, d))
      : "unknown";
    return `${rest ? "..." : ""}${p.getName()}${optional ? "?" : ""}: ${t}`;
  });
  const ret = checker.typeToString(sig.getReturnType());
  return `(${params.join(", ")}) => ${ret}`;
}

function symbolKind(sym: ts.Symbol): string {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.Enum || f & ts.SymbolFlags.ConstEnum) return "enum";
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.TypeAlias) return "type";
  if (f & ts.SymbolFlags.Module) return "namespace";
  if (f & ts.SymbolFlags.Variable) return "variable";
  return "unknown";
}

function findTypesEntry(pkgDir: string): string {
  const pkgJsonPath = join(pkgDir, "package.json");
  let declared: string | undefined;
  if (existsSync(pkgJsonPath)) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    declared =
      pkg.types ??
      pkg.typings ??
      pkg.exports?.["."]?.types ??
      (typeof pkg.exports?.["."] === "object"
        ? pkg.exports["."].import?.types ?? pkg.exports["."].require?.types
        : undefined);
  }
  const candidates = [declared, "index.d.ts", "index.d.mts"].filter(
    (c): c is string => !!c,
  );
  for (const c of candidates) {
    const p = join(pkgDir, c.replace(/\.js$/, ".d.ts"));
    if (existsSync(p)) return p;
    if (existsSync(join(pkgDir, c))) return join(pkgDir, c);
  }
  // last resort: a single .d.ts anywhere at the top level
  const dts = readdirSync(pkgDir).filter((f) => f.endsWith(".d.ts"));
  if (dts.length === 1) return join(pkgDir, dts[0]);
  throw new NoTypesError(
    "package ships no usable bundled type declarations (@types fallback not yet supported)",
  );
}
