import { describe, expect, it } from "vitest";
import {
  automationRepositoriesInputSchema,
  createSessionRequestSchema,
  MAX_AUTOMATION_REPOSITORIES,
  MAX_SESSION_REPOSITORIES,
  MAX_TARGET_REPOSITORIES,
  decodeRepositoryPathSegments,
  encodeRepositoryPathSegments,
  formatRepositoryFullName,
  parseRepositoryFullName,
  prArtifactBelongsToRepo,
  sandboxEventSchema,
  serverMessageSchema,
  sessionRepositoriesInputSchema,
  toRepositoryRef,
} from "./index";

describe("repository full names", () => {
  it("round-trips a repository with a nested owner namespace", () => {
    const repository = { repoOwner: "group/subgroup", repoName: "web" };

    expect(parseRepositoryFullName(formatRepositoryFullName(repository))).toEqual(repository);
  });

  it("encodes nested owners as one API path segment", () => {
    expect(encodeRepositoryPathSegments({ repoOwner: "group/subgroup", repoName: "web app" })).toBe(
      "group%2Fsubgroup/web%20app"
    );
  });

  it("decodes a canonical repository API path", () => {
    expect(decodeRepositoryPathSegments("group%2Fsubgroup", "web%20app")).toEqual({
      repoOwner: "group/subgroup",
      repoName: "web app",
    });
  });

  it.each([
    ["group", "web%2Fapi"],
    ["group%2F%2Fsubgroup", "web"],
    ["group%ZZsubgroup", "web"],
  ])("rejects a non-canonical repository API path (%s/%s)", (owner, name) => {
    expect(decodeRepositoryPathSegments(owner, name)).toBeNull();
  });
});

describe("MAX_TARGET_REPOSITORIES aliases", () => {
  it("keeps automation and session caps as the same constant", () => {
    expect(MAX_AUTOMATION_REPOSITORIES).toBe(MAX_TARGET_REPOSITORIES);
    expect(MAX_SESSION_REPOSITORIES).toBe(MAX_TARGET_REPOSITORIES);
  });
});

describe("sessionRepositoriesInputSchema", () => {
  it("normalizes identifiers and defaults baseBranch to null", () => {
    const parsed = sessionRepositoriesInputSchema.parse([
      { repoOwner: " Acme ", repoName: "Frontend" },
      { repoOwner: "acme", repoName: "backend", baseBranch: "develop" },
    ]);

    expect(parsed).toEqual([
      { repoOwner: "acme", repoName: "frontend", baseBranch: null },
      { repoOwner: "acme", repoName: "backend", baseBranch: "develop" },
    ]);
  });

  it("rejects lists above the cap", () => {
    const entries = Array.from({ length: MAX_TARGET_REPOSITORIES + 1 }, (_, i) => ({
      repoOwner: "acme",
      repoName: `repo-${i}`,
    }));

    expect(sessionRepositoriesInputSchema.safeParse(entries).success).toBe(false);
  });

  it("rejects duplicate owner/name pairs", () => {
    const result = sessionRepositoriesInputSchema.safeParse([
      { repoOwner: "acme", repoName: "app" },
      { repoOwner: "ACME", repoName: "App" },
    ]);

    expect(result.success).toBe(false);
  });

  it("rejects duplicate repoName across owners (checkout paths collide)", () => {
    const result = sessionRepositoriesInputSchema.safeParse([
      { repoOwner: "acme", repoName: "app" },
      { repoOwner: "globex", repoName: "app" },
    ]);

    expect(result.success).toBe(false);
  });

  it("rejects empty lists (the field is either absent or names a member)", () => {
    expect(sessionRepositoriesInputSchema.safeParse([]).success).toBe(false);
  });

  it("automation flavor keeps accepting duplicate repoName across owners", () => {
    const result = automationRepositoriesInputSchema.safeParse([
      { repoOwner: "acme", repoName: "app" },
      { repoOwner: "globex", repoName: "app" },
    ]);

    expect(result.success).toBe(true);
  });
});

describe("createSessionRequestSchema repositories", () => {
  it("accepts a repositories list without scalar fields", () => {
    const result = createSessionRequestSchema.safeParse({
      repositories: [
        { repoOwner: "acme", repoName: "frontend" },
        { repoOwner: "acme", repoName: "backend", baseBranch: "develop" },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("keeps accepting scalar-only requests", () => {
    const result = createSessionRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "app",
      branch: "main",
    });

    expect(result.success).toBe(true);
  });

  it("rejects repositories combined with scalar repo fields", () => {
    const result = createSessionRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "app",
      repositories: [{ repoOwner: "acme", repoName: "frontend" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects repositories combined with a scalar branch", () => {
    const result = createSessionRequestSchema.safeParse({
      branch: "main",
      repositories: [{ repoOwner: "acme", repoName: "frontend" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty repositories list even alongside scalar fields", () => {
    // [] must never act as a third mode that smuggles the scalar form
    // through the exclusivity check.
    const result = createSessionRequestSchema.safeParse({
      repoOwner: "acme",
      repoName: "app",
      repositories: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a bare empty repositories list", () => {
    const result = createSessionRequestSchema.safeParse({ repositories: [] });

    expect(result.success).toBe(false);
  });
});

describe("createSessionRequestSchema environmentId (three-way exclusivity)", () => {
  it("accepts an environmentId without any repository target", () => {
    const result = createSessionRequestSchema.safeParse({ environmentId: "env_abc123" });

    expect(result.success).toBe(true);
  });

  it("rejects environmentId combined with scalar repo fields", () => {
    const result = createSessionRequestSchema.safeParse({
      environmentId: "env_abc123",
      repoOwner: "acme",
      repoName: "app",
    });

    expect(result.success).toBe(false);
  });

  it("rejects environmentId combined with a scalar branch", () => {
    const result = createSessionRequestSchema.safeParse({
      environmentId: "env_abc123",
      branch: "main",
    });

    expect(result.success).toBe(false);
  });

  it("rejects environmentId combined with a repositories list", () => {
    const result = createSessionRequestSchema.safeParse({
      environmentId: "env_abc123",
      repositories: [{ repoOwner: "acme", repoName: "frontend" }],
    });

    expect(result.success).toBe(false);
  });
});

describe("push event schemas", () => {
  it("accepts legacy events without repo identity", () => {
    const result = sandboxEventSchema.safeParse({
      type: "push_complete",
      branchName: "open-inspect/s1",
      timestamp: 1,
    });

    expect(result.success).toBe(true);
  });

  it("accepts repo identity on push events", () => {
    const result = sandboxEventSchema.safeParse({
      type: "push_error",
      branchName: "open-inspect/s1",
      repoOwner: "acme",
      repoName: "backend",
      error: "push failed",
      timestamp: 1,
    });

    expect(result.success).toBe(true);
  });

  it("accepts the legacy key-less push_error (no branchName)", () => {
    // Legacy runtimes emit this on the "no repository found" path — requiring
    // branchName would drop the event at the parse layer and leak the
    // pending push resolver.
    const result = sandboxEventSchema.safeParse({
      type: "push_error",
      error: "No repository found",
      timestamp: 1,
    });

    expect(result.success).toBe(true);
  });
});

describe("warning event schema", () => {
  it("accepts runtime boot warnings", () => {
    const result = sandboxEventSchema.safeParse({
      type: "warning",
      scope: "assembly",
      message: ".opencode/command/x.md from acme/frontend is overridden by acme/backend",
      repoOwner: "acme",
      repoName: "backend",
      sandboxId: "sb-1",
      timestamp: 1,
    });

    expect(result.success).toBe(true);
  });

  it("rejects unknown scopes", () => {
    const result = sandboxEventSchema.safeParse({
      type: "warning",
      scope: "everything",
      message: "??",
      timestamp: 1,
    });

    expect(result.success).toBe(false);
  });
});

describe("session_branch server message", () => {
  it("accepts the legacy scalar shape", () => {
    const result = serverMessageSchema.safeParse({
      type: "session_branch",
      branchName: "open-inspect/s1",
    });

    expect(result.success).toBe(true);
  });

  it("accepts repo identity for multi-repo sessions", () => {
    const result = serverMessageSchema.safeParse({
      type: "session_branch",
      branchName: "open-inspect/s1",
      repoOwner: "acme",
      repoName: "backend",
    });

    expect(result.success).toBe(true);
  });
});

describe("toRepositoryRef", () => {
  it("converts a resolved automation repository", () => {
    expect(
      toRepositoryRef({ repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: "develop" })
    ).toEqual({ repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: "develop" });
  });

  it("falls back to main when baseBranch is null", () => {
    expect(
      toRepositoryRef({ repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: null })
    ).toEqual({ repoOwner: "acme", repoName: "app", repoId: 42, baseBranch: "main" });
  });

  it("throws for unresolved entries", () => {
    expect(() =>
      toRepositoryRef({ repoOwner: "acme", repoName: "app", repoId: null, baseBranch: null })
    ).toThrow(/not resolved/);
  });
});

describe("prArtifactBelongsToRepo", () => {
  const web = { repoOwner: "acme", repoName: "web" };
  const api = { repoOwner: "acme", repoName: "api" };

  it("attributes an identity-less artifact to the primary only", () => {
    expect(prArtifactBelongsToRepo(null, web, true)).toBe(true);
    expect(prArtifactBelongsToRepo(null, api, false)).toBe(false);
  });

  it("matches on identity regardless of primary flag", () => {
    expect(prArtifactBelongsToRepo(web, web, false)).toBe(true);
    expect(prArtifactBelongsToRepo(web, api, true)).toBe(false);
  });

  it("compares identity case-insensitively", () => {
    expect(prArtifactBelongsToRepo({ repoOwner: "Acme", repoName: "Web" }, web, false)).toBe(true);
  });
});
