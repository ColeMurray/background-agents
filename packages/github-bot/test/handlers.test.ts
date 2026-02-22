import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("test-installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
}));

vi.mock("../src/utils/internal", () => ({
  generateInternalToken: vi.fn().mockResolvedValue("test-internal-token"),
}));

vi.mock("../src/utils/integration-config", () => ({
  getGitHubConfig: vi.fn().mockResolvedValue({
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    autoReviewOnOpen: true,
    enabledRepos: null,
    allowedTriggerUsers: null,
  }),
}));

const defaultConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-haiku-4-5",
  reasoningEffort: null,
  autoReviewOnOpen: true,
  enabledRepos: null,
  allowedTriggerUsers: null,
};

import {
  handlePullRequestOpened,
  handleReviewRequested,
  handleIssueComment,
  handleReviewComment,
} from "../src/handlers";
import { generateInstallationToken, postReaction, checkSenderPermission } from "../src/github-auth";
import { getGitHubConfig } from "../src/utils/integration-config";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockEnv(): Env {
  const controlPlaneFetch = vi.fn().mockImplementation((url: string) => {
    if (url === "https://internal/sessions") {
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session-123" }), { status: 200 })
      );
    }
    if (/\/sessions\/.+\/prompt$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  });

  return {
    CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    INTERNAL_CALLBACK_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function getControlPlaneFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

const pullRequestOpenedPayload: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
    draft: false,
  },
  repository: { owner: { login: "acme" }, name: "widgets" },
  sender: { login: "alice" },
};

const reviewRequestedPayload: ReviewRequestedPayload = {
  action: "review_requested",
  pull_request: {
    number: 42,
    title: "Add caching",
    body: "Adds Redis caching",
    user: { login: "alice" },
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  requested_reviewer: { login: "test-bot[bot]" },
  repository: { owner: { login: "acme" }, name: "widgets" },
  sender: { login: "alice" },
};

const issueCommentPayload: IssueCommentPayload = {
  action: "created",
  issue: {
    number: 42,
    title: "Add caching",
    pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
  },
  comment: {
    id: 100,
    body: "@test-bot[bot] please fix the error handling",
    user: { login: "bob" },
  },
  repository: { owner: { login: "acme" }, name: "widgets" },
  sender: { login: "bob" },
};

const reviewCommentPayload: ReviewCommentPayload = {
  action: "created",
  pull_request: {
    number: 42,
    title: "Add caching",
    head: { ref: "feature/cache", sha: "abc123" },
    base: { ref: "main" },
  },
  comment: {
    id: 200,
    body: "@test-bot[bot] can you fix this?",
    path: "src/cache.ts",
    diff_hunk: "@@ -10,3 +10,5 @@\n+const cache = new Map();",
    position: 5,
    user: { login: "carol" },
  },
  repository: { owner: { login: "acme" }, name: "widgets" },
  sender: { login: "carol" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("test-installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
});

describe("handlePullRequestOpened", () => {
  it("creates session, posts reaction, and sends code review prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(generateInstallationToken).toHaveBeenCalled();
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.source).toBe("github");
    expect(promptBody.authorId).toBe("github:alice");
    expect(promptBody.content).toContain("Pull Request #42");

    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({ action: "auto_review" })
    );
  });

  it("returns early for draft PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: { ...pullRequestOpenedPayload.pull_request, draft: true },
    };

    await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.draft_pr_skipped", expect.anything());
  });

  it("returns early if PR is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: {
        ...pullRequestOpenedPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
    };

    await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.self_pr_ignored", expect.anything());
  });

  it("returns early when autoReviewOnOpen is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("fail-closed config skips auto-review (autoReviewOnOpen: false)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
      enabledRepos: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-failclosed");

    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.auto_review_disabled", expect.anything());
  });

  it("uses config.model instead of env.DEFAULT_MODEL", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
  });

  it("passes reasoningEffort from config to session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "high",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.reasoningEffort).toBe("high");
  });
});

describe("handleReviewRequested", () => {
  it("creates session, posts reaction, and sends prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(generateInstallationToken).toHaveBeenCalledWith({
      appId: "12345",
      privateKey: "test-key",
      installationId: "67890",
    });

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    // Verify session creation
    const sessionCall = cpFetch.mock.calls[0];
    expect(sessionCall[0]).toBe("https://internal/sessions");
    const sessionBody = JSON.parse(sessionCall[1].body);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");

    // Verify prompt sending
    const promptCall = cpFetch.mock.calls[1];
    expect(promptCall[0]).toBe("https://internal/sessions/session-123/prompt");
    const promptBody = JSON.parse(promptCall[1].body);
    expect(promptBody.source).toBe("github");
    expect(promptBody.authorId).toBe("github:alice");
    expect(promptBody.content).toContain("Pull Request #42");
    expect(promptBody.content).toContain("acme/widgets");
    expect(promptBody.content).toContain("gh pr diff 42");

    // Verify logging
    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({
        session_id: "session-123",
        action: "review",
      })
    );
    expect(log.info).toHaveBeenCalledWith(
      "prompt.sent",
      expect.objectContaining({
        session_id: "session-123",
        message_id: "msg-456",
      })
    );
  });

  it("returns early if reviewer is not the bot", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    await handleReviewRequested(env, log, payload, "trace-1");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.review_not_for_bot", expect.anything());
  });

  it("returns early if no reviewer specified", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: undefined };

    await handleReviewRequested(env, log, payload, "trace-1");

    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleIssueComment", () => {
  it("creates session and sends prompt for PR comment with @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "eyes"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);

    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@test-bot[bot]");
    expect(promptBody.authorId).toBe("github:bob");
  });

  it("returns early if not a PR", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      issue: { number: 42, title: "Bug report", pull_request: undefined },
    };

    await handleIssueComment(env, log, payload, "trace-2");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.not_a_pr", expect.anything());
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: { ...issueCommentPayload.comment, body: "just a regular comment" },
    };

    await handleIssueComment(env, log, payload, "trace-2");

    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      sender: { login: "test-bot[bot]" },
    };

    await handleIssueComment(env, log, payload, "trace-2");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.self_comment_ignored", expect.anything());
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleReviewComment", () => {
  it("creates session and sends prompt with file context", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/comments/200/reactions",
      "eyes"
    );

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = JSON.parse(cpFetch.mock.calls[1][1].body);
    expect(promptBody.content).toContain("src/cache.ts");
    expect(promptBody.content).toContain("const cache = new Map()");
    expect(promptBody.content).toContain("comments/200/replies");
    expect(promptBody.authorId).toBe("github:carol");
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "just a comment" },
    };

    await handleReviewComment(env, log, payload, "trace-3");

    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      sender: { login: "test-bot[bot]" },
    };

    await handleReviewComment(env, log, payload, "trace-3");

    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("error handling", () => {
  it("throws when session creation fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    getControlPlaneFetch(env).mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(
      handleReviewRequested(env, log, reviewRequestedPayload, "trace-err")
    ).rejects.toThrow("Session creation failed: 500");
  });

  it("proceeds with session even if reaction fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(postReaction).mockResolvedValue(false);

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-reaction");

    // Session should still be created despite reaction failure
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(2);
  });
});

describe("integration config", () => {
  it("fetches config with the correct repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-config");

    expect(getGitHubConfig).toHaveBeenCalledWith(env, "acme/widgets");
  });

  it("uses config.model in session creation", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      model: "anthropic/claude-opus-4-6",
      reasoningEffort: "low",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-model");

    const cpFetch = getControlPlaneFetch(env);
    const sessionBody = JSON.parse(cpFetch.mock.calls[0][1].body);
    expect(sessionBody.model).toBe("anthropic/claude-opus-4-6");
    expect(sessionBody.reasoningEffort).toBe("low");
  });

  it("fail-closed config skips webhook (empty enabledRepos)", async () => {
    // Fail-closed defaults (enabledRepos: [], autoReviewOnOpen: false) cause the
    // handler to return early — no session created, no webhook processed.
    vi.mocked(getGitHubConfig).mockResolvedValue({
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      autoReviewOnOpen: false,
      enabledRepos: [],
      allowedTriggerUsers: [],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-failclosed");

    // No session should have been created
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });

  it("null enabledRepos (no settings configured) allows all repos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: null,
      model: "anthropic/claude-haiku-4-5",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null");

    // Should proceed normally — null means all repos allowed
    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects sender not in allowedTriggerUsers (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-allowlist");

    // bob is the sender, not in ["alice"] → rejected before token generation
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "bob" })
    );
  });

  it("allows sender in allowedTriggerUsers (case-insensitive)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["BoB"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-allowed");

    // bob matches → proceeds to session creation
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(2);
  });

  it("empty allowedTriggerUsers rejects all senders (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: [],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-empty");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("rejects sender when permission check fails (no allowlist)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-noperm");

    // Token generated (needed for permission check), but no session created
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_insufficient_permission",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("logs permission_check_failed when permission API returns error", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: null,
    });
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false, error: true });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-apierr");

    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.permission_check_failed",
      expect.objectContaining({ sender: "bob", repo: "acme/widgets" })
    );
  });

  it("handlePullRequestOpened rejects sender not in allowedTriggerUsers", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["someone-else"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-pr-gating");

    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "handler.sender_not_allowed",
      expect.objectContaining({ sender: "alice" })
    );
  });

  it("config fetch called after cheap early exit (not-for-bot)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    await handleReviewRequested(env, log, payload, "trace-early");

    // Config fetch should NOT happen for cheap early exits
    expect(getGitHubConfig).not.toHaveBeenCalled();
  });
});
