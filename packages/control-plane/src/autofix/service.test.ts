import { describe, expect, it, vi } from "vitest";
import { GITHUB_AUTOFIX_DEFAULTS } from "@open-inspect/shared";
import { AutofixService } from "./service";
import type { GitHubPullRequestFeedback } from "../source-control/providers/github-provider";

function buildService() {
  const received: {
    feedbackKey: string;
    decision: "received" | "queued" | "skipped" | "failed";
    dispatchAttemptedAt: number | null;
    messageId: string | null;
    reason?: string | null;
  } = {
    feedbackKey: "github:pr_comment:1234",
    decision: "received",
    dispatchAttemptedAt: null,
    messageId: null,
  };
  const feedbackStore = {
    receive: vi.fn(
      async (): Promise<{
        feedbackKey: string;
        decision: "received" | "queued" | "skipped" | "failed";
        dispatchAttemptedAt: number | null;
        messageId: string | null;
      }> => received
    ),
    get: vi.fn(async () => received),
    attachContext: vi.fn(async () => undefined),
    markDispatchAttempted: vi.fn(async () => undefined),
    markQueued: vi.fn(async () => undefined),
    markSkipped: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    recordError: vi.fn(async () => undefined),
  };
  const pullRequests = {
    getByIdentity: vi.fn(async () => ({
      artifactId: "artifact-1",
      sessionId: "session-1",
      repoOwner: "acme",
      repoName: "widgets",
      prNumber: 42,
    })),
  };
  const settings = {
    resolve: vi.fn(async () => ({
      enabledRepos: null,
      autofix: { ...GITHUB_AUTOFIX_DEFAULTS, enabled: true },
    })),
  };
  const github = {
    getPullRequest: vi.fn(async () => ({
      lifecycleState: "open" as const,
      repoOwner: "acme",
      repoName: "widgets",
    })),
    getPullRequestFeedback: vi.fn(
      async (): Promise<GitHubPullRequestFeedback> => ({
        kind: "pr_comment",
        id: "1234",
        body: "Please handle the null case.",
        url: "https://github.com/acme/widgets/pull/42#issuecomment-1234",
        author: { id: "7", login: "alice", type: "User" },
      })
    ),
    hasPullRequestWritePermission: vi.fn(async () => true),
  };
  const sessions = {
    fetch: vi.fn(async () => Response.json({ kind: "enqueued", messageId: "message-1" })),
  };
  const service = new AutofixService({
    feedbackStore,
    pullRequests,
    settings,
    github,
    sessions,
    botUsername: "open-inspect[bot]",
    now: () => 2_000,
  });

  return { service, feedbackStore, pullRequests, settings, github, sessions };
}

describe("AutofixService", () => {
  it("dispatches eligible human PR feedback into the owning session", async () => {
    const h = buildService();

    const result = await h.service.process({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-1",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toEqual({
      kind: "completed",
      decision: "queued",
      reason: "enqueued",
      messageId: "message-1",
    });
    expect(h.github.hasPullRequestWritePermission).toHaveBeenCalledWith({
      owner: "acme",
      name: "widgets",
      authorLogin: "alice",
    });
    expect(h.feedbackStore.markDispatchAttempted).toHaveBeenCalledBefore(h.sessions.fetch);
    expect(h.sessions.fetch).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Please handle the null case."),
      })
    );
    expect(h.feedbackStore.markQueued).toHaveBeenCalledWith(
      "github:pr_comment:1234",
      "message-1",
      "enqueued",
      2_000
    );
  });

  it("returns the winning queued decision when a concurrent skip loses its transition", async () => {
    const h = buildService();
    h.settings.resolve.mockResolvedValue({
      enabledRepos: null,
      autofix: { ...GITHUB_AUTOFIX_DEFAULTS, enabled: false },
    });
    h.feedbackStore.markSkipped.mockResolvedValue(false);
    h.feedbackStore.get.mockResolvedValue({
      feedbackKey: "github:pr_comment:1234",
      decision: "queued",
      dispatchAttemptedAt: 2_000,
      messageId: "message-winner",
      reason: "enqueued",
    });

    const result = await h.service.process({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-1",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toEqual({
      kind: "completed",
      decision: "queued",
      reason: "enqueued",
      messageId: "message-winner",
    });
  });

  it("stops before provider reads when Autofix is disabled", async () => {
    const h = buildService();
    h.settings.resolve.mockResolvedValueOnce({
      enabledRepos: null,
      autofix: { ...GITHUB_AUTOFIX_DEFAULTS },
    });

    const result = await h.service.process({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-1",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toEqual({
      kind: "completed",
      decision: "skipped",
      reason: "disabled",
    });
    expect(h.github.getPullRequest).not.toHaveBeenCalled();
  });

  it("rejects human feedback from an author without live write permission", async () => {
    const h = buildService();
    h.github.hasPullRequestWritePermission.mockResolvedValueOnce(false);

    const result = await h.service.process({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-1",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toMatchObject({
      decision: "skipped",
      reason: "author_lacks_write_permission",
    });
    expect(h.sessions.fetch).not.toHaveBeenCalled();
  });

  it("allows an exact allowlisted third-party bot review without a user permission check", async () => {
    const h = buildService();
    h.settings.resolve.mockResolvedValueOnce({
      enabledRepos: null,
      autofix: {
        ...GITHUB_AUTOFIX_DEFAULTS,
        enabled: true,
        allowedReviewBots: ["coderabbitai[bot]"],
      },
    });
    h.github.getPullRequestFeedback.mockResolvedValueOnce({
      kind: "review",
      id: "5678",
      body: "Please address this.",
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
      state: "CHANGES_REQUESTED",
      author: { id: "8", login: "CodeRabbitAI[bot]", type: "Bot" },
      comments: [],
    });

    const result = await h.service.process({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      deliveryId: "delivery-2",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toMatchObject({ decision: "queued", messageId: "message-1" });
    expect(h.github.hasPullRequestWritePermission).not.toHaveBeenCalled();
    expect(h.sessions.fetch).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"authorType":"bot"'),
      })
    );
  });

  it("fails closed on unattributed reviews from the Open Inspect App", async () => {
    const h = buildService();
    h.github.getPullRequestFeedback.mockResolvedValueOnce({
      kind: "review",
      id: "5678",
      body: "Please address this.",
      url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
      state: "CHANGES_REQUESTED",
      author: { id: "9", login: "Open-Inspect[bot]", type: "Bot" },
      comments: [],
    });

    const result = await h.service.process({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      deliveryId: "delivery-2",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toMatchObject({
      decision: "skipped",
      reason: "own_app_unattributed",
    });
    expect(h.sessions.fetch).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous prior dispatch through the SessionDO lookup", async () => {
    const h = buildService();
    h.feedbackStore.receive.mockResolvedValueOnce({
      feedbackKey: "github:pr_comment:1234",
      decision: "received",
      dispatchAttemptedAt: 1_500,
      messageId: null,
    });
    h.sessions.fetch.mockResolvedValueOnce(
      Response.json({ kind: "found", messageId: "message-existing" })
    );

    const result = await h.service.process({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-1",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "acme", name: "widgets" },
      pullRequestNumber: 42,
      receivedAt: "2026-07-30T05:00:00.000Z",
    });

    expect(result).toEqual({
      kind: "completed",
      decision: "queued",
      reason: "recovered_after_ambiguous_dispatch",
      messageId: "message-existing",
    });
    expect(h.github.getPullRequest).not.toHaveBeenCalled();
  });
});
