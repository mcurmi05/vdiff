import { describe, expect, it } from "vitest";
import { compare } from "./compare.js";
import type { SymbolTable } from "./symbols.js";

const fn = (sig: string) => ({ kind: "function", signatures: [sig] });

describe("compare", () => {
  it("detects removed exports", () => {
    const from: SymbolTable = { pluck: fn("(collection: any, path: string) => any[]") };
    const changes = compare(from, {});
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: "export_removed", symbol: "pluck" });
  });

  it("detects signature changes with param count note", () => {
    const from: SymbolTable = { debounce: fn("(func: Function, wait: number) => Function") };
    const to: SymbolTable = {
      debounce: fn("(func: Function, wait: number, options: Options) => Function"),
    };
    const [change] = compare(from, to);
    expect(change.type).toBe("signature_changed");
    expect(change.note).toContain("2 → 3");
  });

  it("ignores identical tables", () => {
    const t: SymbolTable = { map: fn("(arr: any[], fn: Function) => any[]") };
    expect(compare(t, t)).toHaveLength(0);
  });

  it("does not count nested commas as params", () => {
    const from: SymbolTable = { f: fn("(opts: { a: number, b: string }) => void") };
    const to: SymbolTable = { f: fn("(opts: { a: number, b: string }, extra: boolean) => void") };
    const [change] = compare(from, to);
    expect(change.note).toContain("1 → 2");
  });

  it("reports kind changes", () => {
    const from: SymbolTable = { X: { kind: "class", signatures: [] } };
    const to: SymbolTable = { X: { kind: "function", signatures: [] } };
    expect(compare(from, to)[0].type).toBe("export_kind_changed");
  });

  it("detects removed class members", () => {
    const from: SymbolTable = {
      C: { kind: "class", signatures: [], members: { oldMethod: ["() => void"] } },
    };
    const to: SymbolTable = { C: { kind: "class", signatures: [], members: {} } };
    const [change] = compare(from, to);
    expect(change).toMatchObject({ type: "member_removed", symbol: "C.oldMethod" });
  });

  it("marks additions as informational", () => {
    const to: SymbolTable = { newFn: fn("() => void") };
    const [change] = compare({}, to);
    expect(change.type).toBe("export_added");
    expect(change.note).toContain("not breaking");
  });
});
