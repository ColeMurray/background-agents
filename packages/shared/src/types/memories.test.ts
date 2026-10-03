import { describe, expect, it } from "vitest";
import {
  createMemorySchema,
  allowedMemoryActions,
  memoryScopeFromSearchParams,
  memoryScopeToSearchParams,
  memorySearchSchema,
  MEMORY_TRANSITIONS,
  sandboxMemoryWriteSchema,
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
  it.each(["personal", "repository", "environment"])(
    "accepts a session-relative %s scope only for sandbox writes",
    (type) => {
      const { scope: _scope, ...fields } = fact;
      expect(sandboxMemoryWriteSchema.parse({ ...fields, scope: type }).scope).toBe(type);
      expect(createMemorySchema.safeParse({ ...fact, scope: { type } }).success).toBe(
        type === "personal"
      );
    }
  );
  it("normalizes an explicit sandbox repository selector", () => {
    const { scope: _scope, ...fields } = fact;
    expect(
      sandboxMemoryWriteSchema.parse({
        ...fields,
        scope: "repository",
        repoOwner: " Acme/Subgroup ",
        repoName: " API ",
      })
    ).toMatchObject({ scope: "repository", repoOwner: "acme/subgroup", repoName: "api" });
  });
  it.each([
    { scope: "repository", repoOwner: "acme" },
    { scope: "repository", repoName: "api" },
    { scope: "personal", repoOwner: "acme", repoName: "api" },
    { scope: "repository", repoId: 123 },
    { scope: "environment", environmentId: "other" },
    { scope: "personal", ownerUserId: "other" },
  ])("rejects partial selectors and caller-derived identities: $scope", (selector) => {
    const { scope: _scope, ...fields } = fact;
    expect(sandboxMemoryWriteSchema.safeParse({ ...fields, ...selector }).success).toBe(false);
  });
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
    expect(reviseMemorySchema.safeParse(directive).success).toBe(false);
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

describe("memory search contract", () => {
  it("defaults the result limit and normalizes optional repository selectors", () => {
    expect(memorySearchSchema.parse({ query: " needle " })).toEqual({ query: "needle", limit: 10 });
    expect(
      memorySearchSchema.parse({
        query: "needle",
        scope: "repository",
        repoOwner: " Group/Subgroup ",
        repoName: " API ",
      })
    ).toMatchObject({ repoOwner: "group/subgroup", repoName: "api" });
  });
  it("counts distinct terms rather than repeated keywords", () => {
    expect(memorySearchSchema.safeParse({ query: "needle ".repeat(9) }).success).toBe(true);
    expect(
      memorySearchSchema.safeParse({ query: "one two three four five six seven eight nine" })
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
      inclusion: "summary",
      estimatedTokens: 1,
    };
    const manifest = {
      selectionVersion: 1,
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

describe("memory scope query encoding", () => {
  it.each([
    { type: "personal" },
    { type: "repository", repoOwner: "group/subgroup", repoName: "api" },
    { type: "environment", environmentId: "env_1" },
  ] as const)("round-trips $type scopes", (scope) => {
    expect(memoryScopeFromSearchParams(memoryScopeToSearchParams(scope))).toEqual(scope);
  });
  it("rejects incomplete or unknown scopes", () => {
    expect(memoryScopeFromSearchParams(new URLSearchParams("scope=repository&repoOwner=a"))).toBe(
      null
    );
    expect(memoryScopeFromSearchParams(new URLSearchParams("scope=team"))).toBe(null);
  });
});

describe("memory lifecycle table", () => {
  it("derives the available actions from the current status", () => {
    expect(allowedMemoryActions({ status: "proposed", approvedAt: null })).toEqual([
      "approve",
      "reject",
      "archive",
    ]);
    expect(allowedMemoryActions({ status: "active", approvedAt: 1 })).toEqual(["archive"]);
    expect(allowedMemoryActions({ status: "archived", approvedAt: null })).toEqual(["restore"]);
  });
  it("restores records to their last decided state", () => {
    expect(MEMORY_TRANSITIONS.restore.to({ status: "archived", approvedAt: null })).toEqual({
      status: "proposed",
      archiveKind: null,
    });
    expect(MEMORY_TRANSITIONS.restore.to({ status: "archived", approvedAt: 1 })).toEqual({
      status: "active",
      archiveKind: null,
    });
    expect(MEMORY_TRANSITIONS.reject.to({ status: "proposed", approvedAt: null })).toEqual({
      status: "archived",
      archiveKind: "rejected",
    });
  });
});
