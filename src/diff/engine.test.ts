import { describe, expect, it } from "vitest";
import { matchTypesVersion, typesPackageName } from "./engine.js";

describe("typesPackageName", () => {
  it("maps plain names", () => {
    expect(typesPackageName("lodash")).toBe("@types/lodash");
  });
  it("maps scoped names to double-underscore form", () => {
    expect(typesPackageName("@babel/core")).toBe("@types/babel__core");
  });
});

describe("matchTypesVersion", () => {
  const pack = (...versions: string[]) => ({
    versions: Object.fromEntries(versions.map((v) => [v, {} as never])),
  });

  it("picks highest patch of matching major.minor", () => {
    expect(matchTypesVersion(pack("4.17.0", "4.17.5", "4.14.0"), "4.17.21")).toBe("4.17.5");
  });
  it("falls back to highest same-major version", () => {
    expect(matchTypesVersion(pack("4.14.0", "4.16.2"), "4.17.21")).toBe("4.16.2");
  });
  it("returns null when no major matches", () => {
    expect(matchTypesVersion(pack("3.0.0"), "4.17.21")).toBeNull();
  });
});
