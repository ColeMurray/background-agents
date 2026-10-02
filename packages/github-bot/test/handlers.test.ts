import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";
import type * as GitHubAuth from "../src/github-auth";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn().mockResolvedValue("test-installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
}));

vi.mock("../src/utils/integration-config", () => ({
  getGitHubConfig: vi.fn().mockResolvedValue({
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    autoReviewOnOpen: true,
    enabledRepos: null,
    allowedTriggerUsers: null,
    codeReviewInstructions: null,
    commentActionInstructions: null,
  }),
}));

const defaultConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-haiku-4-5",
  reasoningEffort: null,
  autoReviewOnOpen: true,
  enabledRepos: null,
  allowedTriggerUsers: null,
  codeReviewInstructions: null,
  commentActionInstructions: null,
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
    if (url.startsWith("https://internal/github/route?")) {
      return Promise.resolve(Response.json({ teamId: null, via: "workspace" }));
    }
    if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ repo: "acme/widgets", metadata: null }), { status: 200 })
      );
    }
    if (url === "https://internal/sessions") {
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
          status: 200,
        })
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
    GITHUB_KV: { get: vi.fn(), put: vi.fn() },
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function getControlPlaneFetch(env: Env) {
  return (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

function mockControlPlaneResponse(
  env: Env,
  urlPattern: RegExp,
  respond: () => Response | Promise<Response>
) {
  const cpFetch = getControlPlaneFetch(env);
  const original = cpFetch.getMockImplementation()!;
  cpFetch.mockImplementation((url: string, init: RequestInit) =>
    urlPattern.test(url) ? respond() : original(url, init)
  );
}

/**
 * Locate control-plane calls by URL rather than index — handlers make a
 * session-target metadata lookup before creating the session.
 */
function findCallBody(cpFetch: ReturnType<typeof vi.fn>, urlPattern: RegExp) {
  const call = cpFetch.mock.calls.find(([url]) => urlPattern.test(String(url)));
  expect(call).toBeDefined();
  return JSON.parse((call as [string, { body: string }])[1].body);
}

function sessionCreateBody(cpFetch: ReturnType<typeof vi.fn>) {
  return findCallBody(cpFetch, /^https:\/\/internal\/sessions$/);
}

function promptSendBody(cpFetch: ReturnType<typeof vi.fn>) {
  return findCallBody(cpFetch, /\/sessions\/.+\/prompt$/);
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
  repository: { id: 99, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
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
  repository: { id: 99, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "alice", id: 1001, avatar_url: "https://avatars.githubusercontent.com/u/1001" },
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
  repository: { id: 99, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "bob", id: 1002, avatar_url: "https://avatars.githubusercontent.com/u/1002" },
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
  repository: { id: 99, owner: { login: "acme" }, name: "widgets", private: false },
  sender: { login: "carol", id: 1003, avatar_url: "https://avatars.githubusercontent.com/u/1003" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateInstallationToken).mockResolvedValue("test-installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const routedHandlers = [
  {
    name: "review requested",
    senderId: 1001,
    run: (env: Env, log: Logger) =>
      handleReviewRequested(env, log, reviewRequestedPayload, "trace-route"),
  },
  {
    name: "issue comment mention",
    senderId: 1002,
    run: (env: Env, log: Logger) =>
      handleIssueComment(env, log, issueCommentPayload, "trace-route"),
  },
  {
    name: "review comment mention",
    senderId: 1003,
    run: (env: Env, log: Logger) =>
      handleReviewComment(env, log, reviewCommentPayload, "trace-route"),
  },
];

describe.each(routedHandlers)("GitHub routing: $name", ({ run, senderId }) => {
  it.each([
    { teamId: "team_pr", via: "pull_request_session" },
    { teamId: null, via: "pull_request_session" },
    { teamId: "team_sender", via: "sender_membership" },
    { teamId: null, via: "workspace" },
  ])("creates in the resolved scope $via", async (route) => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /\/github\/route\?/, () => Response.json(route));

    expect(await run(env, createMockLogger())).toMatchObject({ outcome: "processed" });

    const cpFetch = getControlPlaneFetch(env);
    const [url, init] = cpFetch.mock.calls[0];
    const routeUrl = new URL(url);
    expect(routeUrl.origin + routeUrl.pathname).toBe("https://internal/github/route");
    expect(Object.fromEntries(routeUrl.searchParams)).toEqual({
      repositoryId: "99",
      pullNumber: "42",
      sender: `github:${senderId}`,
    });
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("X-OpenInspect-Service")).toBe("github-bot");
    expect(new Headers(init.headers).has("X-OpenInspect-Service-Signature")).toBe(true);
    expect(new Headers(init.headers).has("X-OpenInspect-Actor")).toBe(false);
    expect(sessionCreateBody(cpFetch).teamId).toBe(route.teamId);
    const create = cpFetch.mock.calls.find(([url]) => url === "https://internal/sessions")!;
    expect(new Headers(create[1].headers).get("X-OpenInspect-Actor")).toBe(`github:${senderId}`);
  });

  it.each([
    { name: "network failure", respond: () => Promise.reject(new Error("unavailable")) },
    { name: "HTTP failure", respond: () => new Response("unavailable", { status: 503 }) },
    { name: "invalid JSON", respond: () => new Response("not JSON") },
    { name: "missing team", respond: () => Response.json({ via: "workspace" }) },
    {
      name: "invalid team",
      respond: () => Response.json({ teamId: 123, via: "sender_membership" }),
    },
    {
      name: "empty team",
      respond: () => Response.json({ teamId: "", via: "pull_request_session" }),
    },
    {
      name: "null sender membership team",
      respond: () => Response.json({ teamId: null, via: "sender_membership" }),
    },
    {
      name: "empty sender membership team",
      respond: () => Response.json({ teamId: "", via: "sender_membership" }),
    },
    {
      name: "non-null workspace team",
      respond: () => Response.json({ teamId: "team_pr", via: "workspace" }),
    },
    { name: "invalid via", respond: () => Response.json({ teamId: null, via: "unknown" }) },
  ])("fails closed on $name before resolving a target", async ({ respond }) => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /\/github\/route\?/, respond);

    expect(await run(env, createMockLogger())).toEqual({
      outcome: "skipped",
      skip_reason: "route_lookup_failed",
    });
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(1);
  });

  it("runs the allowlist before routing, target resolution, and reactions", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig, allowedTriggerUsers: [] });
    const env = createMockEnv();

    expect(await run(env, createMockLogger())).toEqual({
      outcome: "skipped",
      skip_reason: "sender_not_allowed",
    });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(postReaction).not.toHaveBeenCalled();
  });
});

describe("GitHub routing", () => {
  it("routes a renamed repository by its stable numeric id", async () => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /\/github\/route\?/, () =>
      Response.json({ teamId: "team_pr", via: "pull_request_session" })
    );
    const payload = {
      ...reviewRequestedPayload,
      repository: { ...reviewRequestedPayload.repository, name: "renamed-widgets" },
    };

    await handleReviewRequested(env, createMockLogger(), payload, "trace-renamed");

    const cpFetch = getControlPlaneFetch(env);
    expect(new URL(cpFetch.mock.calls[0][0]).searchParams.get("repositoryId")).toBe("99");
    expect(sessionCreateBody(cpFetch)).toMatchObject({
      repoName: "renamed-widgets",
      teamId: "team_pr",
    });
    expect(getGitHubConfig).toHaveBeenCalledWith(env, "acme/renamed-widgets", expect.any(Object));
  });

  it("keeps auto-review workspace-level and omits sender and PR routing context", async () => {
    const env = createMockEnv();
    await handlePullRequestOpened(env, createMockLogger(), pullRequestOpenedPayload, "trace-auto");

    const cpFetch = getControlPlaneFetch(env);
    expect(Object.fromEntries(new URL(cpFetch.mock.calls[0][0]).searchParams)).toEqual({
      repositoryId: "99",
    });
    expect(sessionCreateBody(cpFetch).teamId).toBeNull();
  });

  it("does not let a route response put auto-review in a team", async () => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /\/github\/route\?/, () =>
      Response.json({ teamId: "team_sender", via: "sender_membership" })
    );
    await handlePullRequestOpened(env, createMockLogger(), pullRequestOpenedPayload, "trace-auto");
    expect(sessionCreateBody(getControlPlaneFetch(env)).teamId).toBeNull();
  });

  it("fails closed when the auto-review route cannot be fetched", async () => {
    const env = createMockEnv();
    mockControlPlaneResponse(
      env,
      /\/github\/route\?/,
      () => new Response("unavailable", { status: 503 })
    );
    expect(
      await handlePullRequestOpened(env, createMockLogger(), pullRequestOpenedPayload, "trace-auto")
    ).toEqual({ outcome: "skipped", skip_reason: "route_lookup_failed" });
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ...routedHandlers,
  {
    name: "auto-review",
    run: (env: Env, log: Logger) =>
      handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-denial"),
  },
])("session creation refusals: $name", ({ run }) => {
  it.each([
    { status: 403, code: "not_member", message: /not a member/i },
    { status: 409, code: "target_team_missing_grant", message: /acme\/widgets/ },
  ])(
    "comments on the PR and skips $code without delivering a prompt",
    async ({ status, code, message }) => {
      const env = createMockEnv();
      mockControlPlaneResponse(env, /^https:\/\/internal\/sessions$/, () =>
        Response.json({ code }, { status })
      );
      const githubFetch = vi.fn().mockResolvedValue(new Response("", { status: 201 }));
      vi.stubGlobal("fetch", githubFetch);

      expect(await run(env, createMockLogger())).toEqual({ outcome: "skipped", skip_reason: code });

      const cpFetch = getControlPlaneFetch(env);
      expect(
        cpFetch.mock.calls.filter(([url]) => url === "https://internal/sessions")
      ).toHaveLength(1);
      expect(cpFetch.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
      expect(postReaction).toHaveBeenCalledTimes(1);
      expect(githubFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/issues/42/comments",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer test-installation-token" }),
          signal: expect.any(AbortSignal),
        })
      );
      expect(JSON.parse(githubFetch.mock.calls[0][1].body).body).toMatch(message);
    }
  );

  it.each([
    { status: 403, code: "missing_permission" },
    { status: 403, code: "target_team_missing_grant" },
    { status: 409, code: "not_member" },
    { status: 500, code: "internal_error" },
  ])("still throws for unhandled create errors $status $code", async ({ status, code }) => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /^https:\/\/internal\/sessions$/, () =>
      Response.json({ code }, { status })
    );
    const githubFetch = vi.fn();
    vi.stubGlobal("fetch", githubFetch);
    await expect(run(env, createMockLogger())).rejects.toThrow(
      `Session creation failed: ${status}`
    );
    expect(githubFetch).not.toHaveBeenCalled();
    expect(
      getControlPlaneFetch(env).mock.calls.some(([url]) => String(url).endsWith("/prompt"))
    ).toBe(false);
  });
});

describe.each([
  { status: 403, code: "not_member" },
  { status: 409, code: "target_team_missing_grant" },
])("refusal notifications: $code", ({ status, code }) => {
  it.each([
    {
      name: "GitHub denial",
      respond: () => Promise.resolve(new Response("Forbidden", { status: 403 })),
    },
    { name: "network error", respond: () => Promise.reject(new Error("unavailable")) },
  ])("throws without another create or prompt after a comment $name", async ({ respond }) => {
    const env = createMockEnv();
    mockControlPlaneResponse(env, /^https:\/\/internal\/sessions$/, () =>
      Response.json({ code }, { status })
    );
    const githubFetch = vi.fn().mockImplementation(respond);
    vi.stubGlobal("fetch", githubFetch);
    const log = createMockLogger();

    await expect(
      handleReviewRequested(env, log, reviewRequestedPayload, "trace-comment-failure")
    ).rejects.toThrow(`Session refusal comment failed: ${code}`);

    expect(log.warn).toHaveBeenCalledWith(
      "session.refusal_comment_failed",
      expect.objectContaining({ code })
    );
    expect(
      getControlPlaneFetch(env).mock.calls.filter(([url]) => url === "https://internal/sessions")
    ).toHaveLength(1);
    expect(
      getControlPlaneFetch(env).mock.calls.some(([url]) => String(url).endsWith("/prompt"))
    ).toBe(false);
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});

describe("grant refusal repository validation", () => {
  it.each([null, 123, ""])(
    "rejects a malformed repository %s without posting a fallback comment",
    async (repository) => {
      const env = createMockEnv();
      mockControlPlaneResponse(env, /^https:\/\/internal\/sessions$/, () =>
        Response.json({ code: "target_team_missing_grant", repository }, { status: 409 })
      );
      const githubFetch = vi.fn();
      vi.stubGlobal("fetch", githubFetch);

      await expect(
        handleReviewRequested(
          env,
          createMockLogger(),
          reviewRequestedPayload,
          "trace-invalid-repository"
        )
      ).rejects.toThrow("Session creation failed: 409");

      expect(githubFetch).not.toHaveBeenCalled();
      expect(
        getControlPlaneFetch(env).mock.calls.filter(([url]) => url === "https://internal/sessions")
      ).toHaveLength(1);
      expect(
        getControlPlaneFetch(env).mock.calls.some(([url]) => String(url).endsWith("/prompt"))
      ).toBe(false);
    }
  );
});

describe("handlePullRequestOpened", () => {
  it("creates session, posts reaction, and sends code review prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(generateInstallationToken).toHaveBeenCalled();
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(4);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.source).toBe("github");
    expect(promptBody).not.toHaveProperty("authorId");
    expect(promptBody.content).toContain("Pull Request #42");

    expect(log.info).toHaveBeenCalledWith(
      "session.created",
      expect.objectContaining({ action: "auto_review" })
    );
  });

  it("rejects a malformed session creation response before sending a prompt", async () => {
    const env = createMockEnv();
    const cpFetch = getControlPlaneFetch(env);
    cpFetch.mockImplementation((url: string) => {
      if (url.startsWith("https://internal/github/route?")) {
        return Promise.resolve(Response.json({ teamId: null, via: "workspace" }));
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
    const log = createMockLogger();

    await expect(
      handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0")
    ).rejects.toThrow("Session creation failed: invalid response");

    expect(cpFetch).toHaveBeenCalledTimes(3);
  });

  it("returns early for draft PRs", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: { ...pullRequestOpenedPayload.pull_request, draft: true },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "draft_pr" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.draft_pr_skipped", expect.anything());
  });

  it("reviews a bot-authored PR when the bot is an allowed trigger user", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["test-bot[bot]"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: {
        ...pullRequestOpenedPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "auto_review",
    });
    expect(sessionCreateBody(getControlPlaneFetch(env)).scmLogin).toBe("test-bot[bot]");
    expect(promptSendBody(getControlPlaneFetch(env)).content).toContain('"event": "COMMENT"');
  });

  it("rejects a bot-authored PR when the bot is not an allowed trigger user", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: PullRequestOpenedPayload = {
      ...pullRequestOpenedPayload,
      pull_request: {
        ...pullRequestOpenedPayload.pull_request,
        user: { login: "test-bot[bot]" },
      },
      sender: {
        login: "test-bot[bot]",
        id: 1004,
        avatar_url: "https://avatars.githubusercontent.com/u/1004",
      },
    };

    const result = await handlePullRequestOpened(env, log, payload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
  });

  it("returns early when autoReviewOnOpen is false", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      autoReviewOnOpen: false,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
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

    const result = await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-0");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
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

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
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
    const sessionBody = sessionCreateBody(cpFetch);
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
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.reasoningEffort).toBe("high");
  });
});

describe("handleReviewRequested", () => {
  it("creates session, posts reaction, and sends prompt", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review",
    });
    expect(generateInstallationToken).toHaveBeenCalledWith({
      appId: "12345",
      privateKey: "test-key",
      installationId: "67890",
      userAgent: "Open-Inspect",
    });

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(4);

    // Verify session creation
    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.title).toContain("Review PR #42");
    expect(sessionBody.scmLogin).toBe("alice");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1001");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    // Verify prompt sending
    const promptBody = findCallBody(cpFetch, /^https:\/\/internal\/sessions\/session-123\/prompt$/);
    expect(promptBody.source).toBe("github");
    expect(promptBody).not.toHaveProperty("authorId");
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

  it("encodes nested repository owners in the reaction URL", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = {
      ...reviewRequestedPayload,
      repository: {
        ...reviewRequestedPayload.repository,
        owner: { login: "group/platform" },
      },
    };

    await handleReviewRequested(env, log, payload, "trace-nested-owner");

    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/group%2Fplatform/widgets/issues/42/reactions",
      "eyes",
      "Open-Inspect"
    );
  });

  it("returns early if reviewer is not the bot", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: { login: "someone-else" } };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.review_not_for_bot", expect.anything());
  });

  it("returns early if no reviewer specified", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload = { ...reviewRequestedPayload, requested_reviewer: undefined };

    const result = await handleReviewRequested(env, log, payload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-1");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleIssueComment", () => {
  it("creates session and sends prompt for PR comment with @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);
    expect(cpFetch).toHaveBeenCalledTimes(4);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.scmLogin).toBe("bob");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1002");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("please fix the error handling");
    expect(promptBody.content).not.toContain("@test-bot[bot]");
    expect(promptBody).not.toHaveProperty("authorId");
  });

  it("returns early if not a PR", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      issue: { number: 42, title: "Bug report", pull_request: undefined },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "not_a_pr" });
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

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("does not treat a longer username prefix as an @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      comment: {
        ...issueCommentPayload.comment,
        body: "Please ask @test-bot[bot]-clone to handle this.",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: IssueCommentPayload = {
      ...issueCommentPayload,
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleIssueComment(env, log, payload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_comment" });
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

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-2");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("handleReviewComment", () => {
  it("creates session and sends prompt with file context", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({
      outcome: "processed",
      session_id: "session-123",
      message_id: "msg-456",
      handler_action: "review_comment",
    });
    expect(postReaction).toHaveBeenCalledWith(
      "test-installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/comments/200/reactions",
      "eyes",
      "Open-Inspect"
    );

    const cpFetch = getControlPlaneFetch(env);

    const sessionBody = sessionCreateBody(cpFetch);
    expect(sessionBody.scmLogin).toBe("carol");
    expect(sessionBody.scmAvatarUrl).toBe("https://avatars.githubusercontent.com/u/1003");
    // Identity travels via the signed actor assertion, never the body.
    expect(sessionBody).not.toHaveProperty("scmUserId");
    expect(sessionBody).not.toHaveProperty("spawnSource");

    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("src/cache.ts");
    expect(promptBody.content).toContain("const cache = new Map()");
    expect(promptBody.content).toContain("comments/200/replies");
    expect(promptBody).not.toHaveProperty("authorId");
  });

  it("returns early if no @mention", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      comment: { ...reviewCommentPayload.comment, body: "just a comment" },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_mention" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early if comment is from the bot (loop prevention)", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    const payload: ReviewCommentPayload = {
      ...reviewCommentPayload,
      sender: {
        login: "test-bot[bot]",
        id: 2001,
        avatar_url: "https://avatars.githubusercontent.com/u/2001",
      },
    };

    const result = await handleReviewComment(env, log, payload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "self_comment" });
    expect(generateInstallationToken).not.toHaveBeenCalled();
  });

  it("returns early when repo not in enabledRepos", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      enabledRepos: ["other/repo"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewComment(env, log, reviewCommentPayload, "trace-3");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(getControlPlaneFetch(env)).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith("handler.repo_not_enabled", expect.anything());
  });
});

describe("error handling", () => {
  it("throws when session creation fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    let finishReaction!: (ok: boolean) => void;
    vi.mocked(postReaction).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishReaction = resolve;
      })
    );
    mockControlPlaneResponse(
      env,
      /^https:\/\/internal\/sessions$/,
      () => new Response("Internal Server Error", { status: 500 })
    );

    const handlerPromise = handleReviewRequested(env, log, reviewRequestedPayload, "trace-err");
    let handlerSettled = false;
    void handlerPromise
      .finally(() => {
        handlerSettled = true;
      })
      .catch(() => {});
    await vi.waitFor(() => expect(getControlPlaneFetch(env)).toHaveBeenCalled());
    expect(handlerSettled).toBe(false);

    finishReaction(true);
    await expect(handlerPromise).rejects.toThrow("Session creation failed: 500");
  });

  it("proceeds with session even if reaction fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    vi.mocked(postReaction).mockResolvedValue(false);

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-reaction");

    // Session should still be created despite reaction failure
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(4);
    expect(log.warn).toHaveBeenCalledWith("acknowledgment.failed", expect.any(Object));
  });
});

describe("integration config", () => {
  it("fetches config with the correct repo and logger", async () => {
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-config");

    expect(getGitHubConfig).toHaveBeenCalledWith(env, "acme/widgets", log);
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
    const sessionBody = sessionCreateBody(cpFetch);
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
      codeReviewInstructions: null,
      commentActionInstructions: null,
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(
      env,
      log,
      reviewRequestedPayload,
      "trace-failclosed"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
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
    expect(cpFetch).toHaveBeenCalledTimes(4);
  });

  it("rejects sender not in allowedTriggerUsers (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-allowlist");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
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
    expect(getControlPlaneFetch(env)).toHaveBeenCalledTimes(4);
  });

  it("empty allowedTriggerUsers rejects all senders (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: [],
    });
    const env = createMockEnv();
    const log = createMockLogger();

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-empty");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
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

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-noperm");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
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

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-apierr");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "permission_check_failed" });
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

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-pr-gating"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_not_allowed" });
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

    const result = await handleReviewRequested(env, log, payload, "trace-early");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "review_not_for_bot" });
    // Config fetch should NOT happen for cheap early exits
    expect(getGitHubConfig).not.toHaveBeenCalled();
  });

  it("codeReviewInstructions flows into review prompt (handleReviewRequested)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Focus on security.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-review-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Focus on security.");
  });

  it("commentActionInstructions flows into comment prompt (handleIssueComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Run tests first.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleIssueComment(env, log, issueCommentPayload, "trace-comment-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Run tests first.");
  });

  it("codeReviewInstructions flows into review prompt (handlePullRequestOpened)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      codeReviewInstructions: "Check for SQL injection.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handlePullRequestOpened(env, log, pullRequestOpenedPayload, "trace-pr-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Check for SQL injection.");
  });

  it("commentActionInstructions flows into comment prompt (handleReviewComment)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      commentActionInstructions: "Prefer minimal diffs.",
    });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewComment(env, log, reviewCommentPayload, "trace-rc-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).toContain("## Custom Instructions");
    expect(promptBody.content).toContain("Prefer minimal diffs.");
  });

  it("null instructions produce no Custom Instructions section (backward compat)", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({ ...defaultConfig });
    const env = createMockEnv();
    const log = createMockLogger();

    await handleReviewRequested(env, log, reviewRequestedPayload, "trace-null-instr");

    const cpFetch = getControlPlaneFetch(env);
    const promptBody = promptSendBody(cpFetch);
    expect(promptBody.content).not.toContain("## Custom Instructions");
  });
});

describe("default environment targets", () => {
  const fullstackEnvironment = {
    id: "env_abc",
    name: "Fullstack",
    ownerTeamId: null,
    repositories: [
      { repoOwner: "acme", repoName: "widgets" },
      { repoOwner: "acme", repoName: "gadgets" },
    ],
  };

  /**
   * Point the metadata lookup at a default environment and control what the
   * environment fetch returns (null → 404, as for a deleted environment).
   */
  function mockSessionTarget(
    env: Env,
    opts: {
      metadata?: { defaultEnvironmentId?: string } | null;
      metadataStatus?: number;
      environment?:
        | (Omit<typeof fullstackEnvironment, "ownerTeamId"> & { ownerTeamId?: string | null })
        | null;
      teamId?: string | null;
    }
  ) {
    getControlPlaneFetch(env).mockImplementation((url: string) => {
      if (url.startsWith("https://internal/github/route?")) {
        return Promise.resolve(
          Response.json({
            teamId: opts.teamId ?? null,
            via: opts.teamId ? "pull_request_session" : "workspace",
          })
        );
      }
      if (/\/repos\/[^/]+\/[^/]+\/metadata$/.test(url)) {
        if (opts.metadataStatus) {
          return Promise.resolve(new Response("Error", { status: opts.metadataStatus }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ repo: "acme/widgets", metadata: opts.metadata ?? null }), {
            status: 200,
          })
        );
      }
      if (/^https:\/\/internal\/environments\//.test(url)) {
        return opts.environment
          ? Promise.resolve(
              new Response(JSON.stringify({ environment: opts.environment }), { status: 200 })
            )
          : Promise.resolve(new Response("Not found", { status: 404 }));
      }
      if (url === "https://internal/sessions") {
        return Promise.resolve(
          new Response(JSON.stringify({ sessionId: "session-123", status: "created" }), {
            status: 200,
          })
        );
      }
      if (/\/sessions\/.+\/prompt$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ messageId: "msg-456" }), { status: 200 })
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });
  }

  it.each([
    { repository: "acme/gadgets", expectedRepository: "acme/gadgets" },
    { repository: undefined, expectedRepository: "acme/widgets" },
  ])(
    "names the denied repository $expectedRepository for an environment grant refusal",
    async ({ repository, expectedRepository }) => {
      const env = createMockEnv();
      mockSessionTarget(env, {
        metadata: { defaultEnvironmentId: "env_abc" },
        environment: fullstackEnvironment,
        teamId: "team_pr",
      });
      mockControlPlaneResponse(env, /^https:\/\/internal\/sessions$/, () =>
        Response.json({ code: "target_team_missing_grant", repository }, { status: 409 })
      );
      const githubFetch = vi.fn().mockResolvedValue(new Response("", { status: 201 }));
      vi.stubGlobal("fetch", githubFetch);

      expect(
        await handleReviewRequested(
          env,
          createMockLogger(),
          reviewRequestedPayload,
          "trace-secondary-grant"
        )
      ).toEqual({ outcome: "skipped", skip_reason: "target_team_missing_grant" });

      const cpFetch = getControlPlaneFetch(env);
      expect(sessionCreateBody(cpFetch)).toMatchObject({
        environmentId: "env_abc",
        teamId: "team_pr",
      });
      expect(
        cpFetch.mock.calls.filter(([url]) => url === "https://internal/sessions")
      ).toHaveLength(1);
      expect(cpFetch.mock.calls.some(([url]) => String(url).endsWith("/prompt"))).toBe(false);
      expect(githubFetch).toHaveBeenCalledTimes(1);
      expect(githubFetch.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/acme/widgets/issues/42/comments"
      );
      expect(JSON.parse(githubFetch.mock.calls[0][1].body).body).toContain(
        `\`${expectedRepository}\``
      );
      if (repository) {
        expect(JSON.parse(githubFetch.mock.calls[0][1].body).body).not.toContain("`acme/widgets`");
      }
    }
  );

  it.each(["team_pr", null])(
    "uses actor-signed environment reads for routed teams with environment owner %s",
    async (ownerTeamId) => {
      const env = createMockEnv();
      mockSessionTarget(env, {
        metadata: { defaultEnvironmentId: "env_abc" },
        environment: { ...fullstackEnvironment, ownerTeamId },
        teamId: "team_pr",
      });

      await handleReviewRequested(
        env,
        createMockLogger(),
        reviewRequestedPayload,
        "trace-team-env"
      );

      const cpFetch = getControlPlaneFetch(env);
      const environmentCall = cpFetch.mock.calls.find(
        ([url]) => url === "https://internal/environments/env_abc"
      )!;
      expect(new Headers(environmentCall[1].headers).get("X-OpenInspect-Actor")).toBe(
        "github:1001"
      );
      expect(sessionCreateBody(cpFetch)).toMatchObject({
        teamId: "team_pr",
        environmentId: "env_abc",
      });
    }
  );

  it.each(["team_pr", null])(
    "rejects another team's environment even for an allowlisted sender in scope %s",
    async (teamId) => {
      vi.mocked(getGitHubConfig).mockResolvedValue({
        ...defaultConfig,
        allowedTriggerUsers: ["alice"],
      });
      const env = createMockEnv();
      mockSessionTarget(env, {
        metadata: { defaultEnvironmentId: "env_abc" },
        environment: { ...fullstackEnvironment, ownerTeamId: "team_other" },
        teamId,
      });

      await handleReviewRequested(
        env,
        createMockLogger(),
        reviewRequestedPayload,
        "trace-mismatch"
      );

      const body = sessionCreateBody(getControlPlaneFetch(env));
      expect(body).toMatchObject({ repoOwner: "acme", repoName: "widgets", teamId });
      expect(body).not.toHaveProperty("environmentId");
      expect(checkSenderPermission).not.toHaveBeenCalled();
    }
  );

  it("falls back to the scalar repo when environment ownership is missing", async () => {
    const env = createMockEnv();
    const { ownerTeamId: _ownerTeamId, ...environment } = fullstackEnvironment;
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment,
      teamId: "team_pr",
    });

    await handleReviewRequested(
      env,
      createMockLogger(),
      reviewRequestedPayload,
      "trace-missing-owner"
    );

    const body = sessionCreateBody(getControlPlaneFetch(env));
    expect(body).toMatchObject({ repoOwner: "acme", repoName: "widgets", teamId: "team_pr" });
    expect(body).not.toHaveProperty("environmentId");
  });

  it.each([403, 404, 500])(
    "falls back to the routed scalar repo on environment HTTP %s",
    async (status) => {
      const env = createMockEnv();
      mockSessionTarget(env, {
        metadata: { defaultEnvironmentId: "env_abc" },
        environment: fullstackEnvironment,
        teamId: "team_pr",
      });
      mockControlPlaneResponse(
        env,
        /\/environments\//,
        () => new Response("unavailable", { status })
      );

      await handleReviewRequested(
        env,
        createMockLogger(),
        reviewRequestedPayload,
        "trace-denied-env"
      );

      const body = sessionCreateBody(getControlPlaneFetch(env));
      expect(body).toMatchObject({ repoOwner: "acme", repoName: "widgets", teamId: "team_pr" });
      expect(body).not.toHaveProperty("environmentId");
    }
  );

  it("launches the default environment when it contains the trigger repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env");

    expect(result).toMatchObject({ outcome: "processed", session_id: "session-123" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
    expect(sessionBody.repoOwner).toBeUndefined();
    expect(sessionBody.repoName).toBeUndefined();
    expect(log.info).toHaveBeenCalledWith(
      "target.environment_selected",
      expect.objectContaining({ environment_id: "env_abc", repo: "acme/widgets" })
    );
    // Sender permission is verified on the environment's other repository
    // (the trigger repo was already checked by caller gating).
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "test-installation-token",
      "acme",
      "gadgets",
      "alice",
      expect.any(String)
    );
  });

  it("falls back to the repo when the sender lacks permission on another environment repo", async () => {
    vi.mocked(checkSenderPermission).mockImplementation(async (_token, _owner, repo) => ({
      hasPermission: repo !== "gadgets",
    }));
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-authz");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_sender_not_authorized",
      expect.objectContaining({
        environment_id: "env_abc",
        denied_repo: "acme/gadgets",
        sender: "alice",
      })
    );
  });

  it("falls back to the repo when a sender permission check errors", async () => {
    vi.mocked(checkSenderPermission).mockImplementation(async (_token, _owner, repo) =>
      repo === "gadgets" ? { hasPermission: false, error: true } : { hasPermission: true }
    );
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-err");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_sender_not_authorized",
      expect.objectContaining({ denied_repo: "acme/gadgets", permission_check_error: true })
    );
  });

  it("allowlisted senders launch environments without per-repo permission checks", async () => {
    vi.mocked(getGitHubConfig).mockResolvedValue({
      ...defaultConfig,
      allowedTriggerUsers: ["alice"],
    });
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: fullstackEnvironment,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-al");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
    // Allowlist mode never consults GitHub repo permissions — for the trigger
    // repo or the environment's repositories.
    expect(checkSenderPermission).not.toHaveBeenCalled();
  });

  it("falls back to the repo when the environment no longer exists", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_gone" },
      environment: null,
    });

    const result = await handleReviewRequested(env, log, reviewRequestedPayload, "trace-env-gone");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.repoName).toBe("widgets");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_not_found",
      expect.objectContaining({ environment_id: "env_gone" })
    );
  });

  it("falls back to the repo when the environment lacks the trigger repo", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: {
        ...fullstackEnvironment,
        repositories: [{ repoOwner: "acme", repoName: "gadgets" }],
      },
    });

    const result = await handlePullRequestOpened(
      env,
      log,
      pullRequestOpenedPayload,
      "trace-env-nm"
    );

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.environment_missing_trigger_repo",
      expect.objectContaining({ environment_id: "env_abc", repo: "acme/widgets" })
    );
  });

  it("falls back to the repo when the metadata lookup fails", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, { metadataStatus: 500 });

    const result = await handleIssueComment(env, log, issueCommentPayload, "trace-env-meta");

    expect(result).toMatchObject({ outcome: "processed" });
    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.repoOwner).toBe("acme");
    expect(sessionBody.environmentId).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "target.metadata_fetch_failed",
      expect.objectContaining({ repo: "acme/widgets", status: 500 })
    );
  });

  it("membership check is case-insensitive", async () => {
    const env = createMockEnv();
    const log = createMockLogger();
    mockSessionTarget(env, {
      metadata: { defaultEnvironmentId: "env_abc" },
      environment: {
        ...fullstackEnvironment,
        repositories: [{ repoOwner: "ACME", repoName: "Widgets" }],
      },
    });

    await handleReviewComment(env, log, reviewCommentPayload, "trace-env-case");

    const sessionBody = sessionCreateBody(getControlPlaneFetch(env));
    expect(sessionBody.environmentId).toBe("env_abc");
  });
});
