import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlProviderError, type CredentialScope } from "../source-control";
import { SessionPullRequestService } from "./pull-request-service";
import {
  artifactCreatedBroadcasts,
  createInput,
  createTestHarness,
} from "./pull-request-service.test-support";

describe("SessionPullRequestService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 500 when push to remote fails", async () => {
    const resolvePromptingAuth = vi.fn(async () => ({
      auth: { authType: "oauth" as const, token: "user-token" },
    }));
    harness.deps.pushBranchToRemote = vi.fn(async () => ({
      success: false as const,
      error: "Failed to push branch: timeout",
    }));
    harness.service = new SessionPullRequestService(harness.deps);

    const result = await harness.service.createPullRequest(
      createInput({
        resolvePromptingAuth,
      })
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      error: "Failed to push branch: timeout",
    });
    expect(harness.deps.messenger.broadcast).not.toHaveBeenCalled();
    expect(resolvePromptingAuth).not.toHaveBeenCalled();
  });

  it("creates PR with app auth when prompting auth is unavailable", async () => {
    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      headBranch: "open-inspect/session-name-1",
      baseBranch: "main",
      updated: false,
    });
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "app", token: "app-token" });
    expect(harness.deps.resolveCredentialScope).toHaveBeenCalledWith("session-name-1");
    expect(harness.provider.generatePushAuth).toHaveBeenCalledWith(harness.credentialScope);
    expect(artifactCreatedBroadcasts(harness.deps)).toHaveLength(1);
    expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
      "session-1",
      "open-inspect/session-name-1"
    );
    expect(harness.deps.messenger.broadcast).toHaveBeenCalledWith({
      type: "session_branch",
      branchName: "open-inspect/session-name-1",
      repoOwner: "acme",
      repoName: "web",
    });
  });

  it("maps credential scope failure through push auth handling and releases the claim", async () => {
    vi.mocked(harness.deps.resolveCredentialScope).mockRejectedValueOnce(
      new SourceControlProviderError(
        "Cannot resolve credential scope: session not found",
        "permanent"
      )
    );

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 500,
      error: "Cannot resolve credential scope: session not found",
    });
    expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
    expect(harness.provider.getRepository).not.toHaveBeenCalled();
    expect(harness.provider.getPullRequest).not.toHaveBeenCalled();
    expect(harness.deps.pushBranchToRemote).not.toHaveBeenCalled();
    expect(await harness.service.createPullRequest(createInput())).toMatchObject({
      kind: "created",
    });
  });

  it("resolves fresh credential scope on each PR request", async () => {
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [789] };
    vi.mocked(harness.deps.resolveCredentialScope)
      .mockResolvedValueOnce(harness.credentialScope)
      .mockResolvedValueOnce(nextScope);

    await harness.service.createPullRequest(createInput({ headBranch: "feature-one" }));
    await harness.service.createPullRequest(createInput({ headBranch: "feature-two" }));

    expect(harness.deps.resolveCredentialScope).toHaveBeenCalledTimes(2);
    expect(harness.provider.generatePushAuth).toHaveBeenNthCalledWith(1, harness.credentialScope);
    expect(harness.provider.generatePushAuth).toHaveBeenNthCalledWith(2, nextScope);
  });

  it("creates PR with OAuth token and stores PR artifact", async () => {
    const resolvePromptingAuth = vi.fn(async () => ({
      auth: { authType: "oauth" as const, token: "user-token" },
    }));
    const result = await harness.service.createPullRequest(createInput({ resolvePromptingAuth }));

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      headBranch: "open-inspect/session-name-1",
      baseBranch: "main",
      updated: false,
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "oauth", token: "user-token" });
    expect(vi.mocked(harness.deps.pushBranchToRemote).mock.invocationCallOrder[0]).toBeLessThan(
      resolvePromptingAuth.mock.invocationCallOrder[0]
    );
    expect(resolvePromptingAuth.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(harness.provider.createPullRequest).mock.invocationCallOrder[0]
    );
    expect(createPrCall[1].body).toContain(
      "*Created with [Open-Inspect](https://app.example.com/session/session-name-1)*"
    );
    expect(harness.deps.messenger.broadcast).toHaveBeenCalledWith({
      type: "artifact_created",
      artifact: {
        id: "id-1",
        type: "pr",
        url: "https://github.com/acme/web/pull/42",
        metadata: {
          number: 42,
          state: "open",
          lifecycleState: "open",
          isDraft: false,
          head: "open-inspect/session-name-1",
          base: "main",
          repoOwner: "acme",
          repoName: "web",
        },
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    });
  });
});
