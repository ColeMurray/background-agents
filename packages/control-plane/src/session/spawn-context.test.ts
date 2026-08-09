import { describe, expect, it } from "vitest";
import { spawnContextSchema } from "./spawn-context";

describe("spawnContextSchema", () => {
  it("parses a valid spawn context with nullable fields", () => {
    const result = spawnContextSchema.safeParse({
      repoOwner: "open-inspect",
      repoName: "background-agents",
      repoId: null,
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      sandboxTimeoutMs: 14_400_000,
      owner: {
        userId: "user-1",
        scmUserId: null,
        scmLogin: null,
        scmName: null,
        scmEmail: null,
        scmAccessTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        scmTokenExpiresAt: null,
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sandboxTimeoutMs).toBe(14_400_000);
    }
  });

  it("parses a repo-less spawn context", () => {
    const result = spawnContextSchema.safeParse({
      repoOwner: null,
      repoName: null,
      repoId: null,
      model: "anthropic/claude-sonnet-4-6",
      reasoningEffort: null,
      baseBranch: null,
      owner: {
        userId: "user-1",
        scmUserId: null,
        scmLogin: null,
        scmName: null,
        scmEmail: null,
        scmAccessTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        scmTokenExpiresAt: null,
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([-1_000, 1_500, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid snapshotted sandbox timeout %s",
    (sandboxTimeoutMs) => {
      const result = spawnContextSchema.safeParse({
        repoOwner: null,
        repoName: null,
        repoId: null,
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: null,
        sandboxTimeoutMs,
        owner: {
          userId: "user-1",
          scmUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmAccessTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
        },
      });

      expect(result.success).toBe(false);
    }
  );

  it("rejects a malformed partial spawn context", () => {
    const result = spawnContextSchema.safeParse({
      repoOwner: "open-inspect",
      repoName: "background-agents",
    });

    expect(result.success).toBe(false);
  });
});
