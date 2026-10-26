import { describe, expect, it } from "vitest";
import { branchesCacheKey, cachedBranchesListSchema } from "./branch-cache";

const entry = {
  branches: [{ name: "main" }],
  cachedAt: "2026-01-01T00:00:00.000Z",
  scmIdentity: "installation-identity",
  freshUntil: 1_767_225_660_000,
};

describe("branch cache", () => {
  it("uses a versioned, case-insensitive repository key and retains nested owners", () => {
    expect(branchesCacheKey("Acme", "Widgets")).toBe("repos:branches:v1:acme/widgets");
    expect(branchesCacheKey("Acme/Platform", "Widgets")).toBe(
      "repos:branches:v1:acme/platform/widgets"
    );
    expect(branchesCacheKey("acme", "other")).not.toBe(branchesCacheKey("acme", "widgets"));
  });

  it("validates populated and empty branch lists", () => {
    expect(cachedBranchesListSchema.parse(entry)).toEqual(entry);
    expect(cachedBranchesListSchema.parse({ ...entry, branches: [] }).branches).toEqual([]);
  });

  it.each([
    null,
    { ...entry, branches: [{ name: 42 }] },
    { ...entry, branches: [{}] },
    { ...entry, cachedAt: undefined },
    { ...entry, scmIdentity: undefined },
    { ...entry, freshUntil: undefined },
    { ...entry, freshUntil: "later" },
  ])("rejects malformed cache entries (%j)", (value) => {
    expect(cachedBranchesListSchema.safeParse(value).success).toBe(false);
  });
});
