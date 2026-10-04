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
  memoryActionBodySchemas,
  memorySelectionSummarySchema,
  sessionMemorySelectionStatusSchema,
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
      expect(sandboxMemoryWriteSchema.parse({ ...fields, scopeType: type }).scopeType).toBe(type);
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
        scopeType: "repository",
        repoOwner: " Acme/Subgroup ",
        repoName: " API ",
      })
    ).toMatchObject({ scopeType: "repository", repoOwner: "acme/subgroup", repoName: "api" });
  });
  it.each([
    { scopeType: "repository", repoOwner: "acme" },
    { scopeType: "repository", repoName: "api" },
    { scopeType: "personal", repoOwner: "acme", repoName: "api" },
    { scopeType: "repository", repoId: 123 },
    { scopeType: "environment", environmentId: "other" },
    { scopeType: "personal", ownerUserId: "other" },
  ])("rejects partial selectors and caller-derived identities: $scopeType", (selector) => {
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
        scopeType: "repository",
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

describe("selection summary contracts", () => {
  const item = {
    memoryId: "mem_a",
    revisionNumber: 1,
    scope: { type: "personal" },
    memoryType: "fact",
    title: "Fact",
    inclusion: "summary",
    estimatedTokens: 1,
  };
  const summary = {
    includePersonalMemories: true,
    directiveChars: 0,
    catalogChars: 4,
    estimatedTokens: 1,
    omittedCount: 2,
    items: [item],
  };
  it("requires drift flags only on session status and bounds both", () => {
    expect(memorySelectionSummarySchema.safeParse(summary).success).toBe(true);
    expect(sessionMemorySelectionStatusSchema.safeParse(summary).success).toBe(false);
    expect(
      sessionMemorySelectionStatusSchema.safeParse({
        ...summary,
        items: [{ ...item, revisedSinceSelection: false, archivedSinceSelection: false }],
      }).success
    ).toBe(true);
    expect(
      memorySelectionSummarySchema.safeParse({
        ...summary,
        items: Array.from({ length: 301 }, () => item),
      }).success
    ).toBe(false);
  });
});

describe("memory action bodies", () => {
  it("accepts an archive note only on actions that archive", () => {
    expect(memoryActionBodySchemas.archive.parse({ archiveNote: " Outdated " })).toEqual({
      archiveNote: "Outdated",
    });
    expect(memoryActionBodySchemas.reject.safeParse({ archiveNote: "No" }).success).toBe(true);
    expect(memoryActionBodySchemas.approve.safeParse({ archiveNote: "x" }).success).toBe(false);
    expect(memoryActionBodySchemas.restore.safeParse({ archiveNote: "x" }).success).toBe(false);
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
    expect(MEMORY_TRANSITIONS.archive.to({ status: "active", approvedAt: 1 })).toEqual({
      status: "archived",
      archiveKind: "manual",
    });
  });
});
