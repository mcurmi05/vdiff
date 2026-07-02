import { describe, expect, it } from "vitest";
import { packageNameProblem } from "./npm.js";

describe("packageNameProblem", () => {
  it("accepts plain names", () => {
    expect(packageNameProblem("zod")).toBeNull();
    expect(packageNameProblem("lodash.merge")).toBeNull();
  });
  it("accepts scoped names", () => {
    expect(packageNameProblem("@babel/core")).toBeNull();
    expect(packageNameProblem("@types/babel__core")).toBeNull();
  });
  it("rejects uppercase, spaces, and path characters", () => {
    expect(packageNameProblem("Zod")).not.toBeNull();
    expect(packageNameProblem("a b")).not.toBeNull();
    expect(packageNameProblem("../etc/passwd")).not.toBeNull();
    expect(packageNameProblem("a/b/c")).not.toBeNull();
  });
  it("rejects leading dot/underscore and empty parts", () => {
    expect(packageNameProblem(".hidden")).not.toBeNull();
    expect(packageNameProblem("_private")).not.toBeNull();
    expect(packageNameProblem("@scope/")).not.toBeNull();
    expect(packageNameProblem("")).not.toBeNull();
  });
  it("rejects names over 214 characters", () => {
    expect(packageNameProblem("a".repeat(215))).not.toBeNull();
    expect(packageNameProblem("a".repeat(214))).toBeNull();
  });
});
