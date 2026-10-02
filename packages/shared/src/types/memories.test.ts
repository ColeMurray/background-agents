import { describe, expect, it } from "vitest";
import { createMemorySchema, reviseMemorySchema, MEMORY_LIMITS } from "./memories";

const fact = {
  scope: { type: "personal" },
  memoryType: "fact",
  title: "Test setup",
  description: "How to run tests",
  content: "Start the local database",
};
describe("memory write contracts", () => {
  it("accepts nested repository owners and canonicalizes their identity", () => {
    expect(
      createMemorySchema.parse({
        ...fact,
        scope: { type: "repository", repoOwner: "Acme/Subgroup", repoName: "API" },
      }).scope
    ).toEqual({ type: "repository", repoOwner: "acme/subgroup", repoName: "api" });
  });
  it.each(["ownerUserId", "authorUserId", "authorSessionId", "status", "revisionNumber"])(
    "rejects caller-supplied %s provenance or policy",
    (key) => {
      expect(createMemorySchema.safeParse({ ...fact, [key]: "forged" }).success).toBe(false);
    }
  );
  it("enforces directive limits on both creation and revision", () => {
    const { scope: _scope, ...fields } = fact;
    const directive = {
      ...fields,
      memoryType: "directive",
      content: "a".repeat(MEMORY_LIMITS.directive + 1),
    };
    expect(createMemorySchema.safeParse({ ...directive, scope: fact.scope }).success).toBe(false);
    expect(reviseMemorySchema.safeParse({ ...directive, expectedRevisionId: "old" }).success).toBe(
      false
    );
    expect(
      createMemorySchema.safeParse({ ...fact, content: "a".repeat(MEMORY_LIMITS.fact) }).success
    ).toBe(true);
  });
  it("rejects unknown scopes and insufficient catalog descriptions", () => {
    expect(createMemorySchema.safeParse({ ...fact, scope: { type: "project" } }).success).toBe(
      false
    );
    expect(createMemorySchema.safeParse({ ...fact, description: "short" }).success).toBe(false);
    expect(
      createMemorySchema.safeParse({ ...fact, scope: { type: "personal", ownerUserId: "other" } })
        .success
    ).toBe(false);
  });
});
