import { describe, expect, it } from "vitest";
import {
  createMemorySchema,
  reviseMemorySchema,
  MEMORY_LIMITS,
  sessionMemoryManifestSchema,
  sessionMemoryDiagnosticsSchema,
} from "./memories";

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

describe("pinned memory and diagnostic contracts", () => {
  it("requires drift flags only on diagnostics and bounds both response types", () => {
    const item = {
      memoryId: "mem_a",
      revisionId: "rev_a",
      revisionNumber: 1,
      scope: { type: "personal" },
      memoryType: "fact",
      title: "Fact",
      inclusion: "catalog",
      estimatedTokens: 1,
    };
    const manifest = {
      resolverVersion: 1,
      manifestSha256: "hash",
      resolvedAt: 1,
      includePersonalMemories: true,
      personalOwnerUserId: "owner",
      directiveChars: 0,
      catalogChars: 4,
      estimatedTokens: 1,
      truncatedCount: 2,
      items: [item],
    };
    expect(sessionMemoryManifestSchema.safeParse(manifest).success).toBe(true);
    expect(sessionMemoryDiagnosticsSchema.safeParse(manifest).success).toBe(false);
    expect(
      sessionMemoryDiagnosticsSchema.safeParse({
        ...manifest,
        items: [{ ...item, changed: false, archived: false }],
      }).success
    ).toBe(true);
    expect(
      sessionMemoryManifestSchema.safeParse({
        ...manifest,
        items: Array.from({ length: 301 }, () => item),
      }).success
    ).toBe(false);
  });
});
