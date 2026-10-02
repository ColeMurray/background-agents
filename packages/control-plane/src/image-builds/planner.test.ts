import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../router.test-support";
import { GitHubSourceControlProvider } from "../source-control/providers/github-provider";
import { ImageBuildPlanner } from "./planner";

afterEach(() => vi.restoreAllMocks());

describe("ImageBuildPlanner", () => {
  it("does not retry a scoped credential failure with broader auth", async () => {
    const mint = vi
      .spyOn(GitHubSourceControlProvider.prototype, "generateCredentialHelperAuth")
      .mockResolvedValue({
        username: "x-access-token",
        password: "clone-token",
        expiresAtEpochMs: Date.now() + 60_000,
      })
      .mockRejectedValueOnce(new Error("Token scope denied"));
    const env = createTestEnv({ SCM_PROVIDER: "github" });

    const plan = await new ImageBuildPlanner(env, env.DB).planBuild({
      buildId: "build-1",
      scope: { kind: "repo", id: "acme/web" },
      target: {
        kind: "repo",
        repoId: 12,
        repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
        repositoriesFingerprint: "fp-repo",
      },
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
      callbackAuth: {
        token: "callback-token",
        tokenHash: "callback-hash",
        expiresAt: 1000,
      },
    });

    expect(plan.cloneAuth).toEqual({ type: "unavailable" });
    expect(mint).toHaveBeenCalledExactlyOnceWith({
      kind: "repositories",
      repositoryIds: [12],
    });
  });
});
