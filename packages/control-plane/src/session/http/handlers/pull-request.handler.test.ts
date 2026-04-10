import { describe, expect, it, vi } from "vitest";
import type { ParticipantRow, SessionRow } from "../../types";
import { createPullRequestHandler } from "./pull-request.handler";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-session-1",
    title: "Session title",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: "feature/test",
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: "scm-user-1",
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    role: "member",
    scm_access_token_encrypted: "enc-access",
    scm_refresh_token_encrypted: "enc-refresh",
    scm_token_expires_at: 1234,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const getSession = vi.fn<() => SessionRow | null>();
  const getPromptingParticipantForPR = vi.fn();
  const resolveAuthForPR = vi.fn();
  const getSessionUrl = vi.fn();
  const createPullRequest = vi.fn();

  const handler = createPullRequestHandler({
    getSession,
    getPromptingParticipantForPR,
    resolveAuthForPR,
    getSessionUrl,
    createPullRequest,
  });

  return {
    handler,
    getSession,
    getPromptingParticipantForPR,
    resolveAuthForPR,
    getSessionUrl,
    createPullRequest,
  };
}

describe("createPullRequestHandler", () => {
  it("returns 404 when session is missing", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("returns prompting participant error payload", async () => {
    const { handler, getSession, getPromptingParticipantForPR } = createHandler();
    getSession.mockReturnValue(createSession());
    getPromptingParticipantForPR.mockResolvedValue({
      error: "No active prompt found",
      status: 400,
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No active prompt found" });
  });

  it("returns auth resolution error payload", async () => {
    const { handler, getSession, getPromptingParticipantForPR, resolveAuthForPR } = createHandler();
    const participant = createParticipant();
    getSession.mockReturnValue(createSession());
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({
      error: "Token expired",
      status: 401,
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Token expired" });
  });

  it("forwards service error and uses session base branch fallback", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      getSessionUrl,
      createPullRequest,
    } = createHandler();
    const session = createSession({ base_branch: "develop" });
    const participant = createParticipant({ user_id: "user-123" });
    getSession.mockReturnValue(session);
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({ auth: { authType: "oauth", token: "token" } });
    getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
    createPullRequest.mockResolvedValue({
      kind: "error",
      status: 409,
      error: "PR already exists",
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc", headBranch: "feature/pr" }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PR already exists" });
    expect(createPullRequest).toHaveBeenCalledWith({
      title: "PR",
      body: "desc",
      headBranch: "feature/pr",
      baseBranch: "develop",
      promptingUserId: "user-123",
      promptingAuth: { authType: "oauth", token: "token" },
      sessionUrl: "https://app.example.com/session/public-session-1",
    });
  });

  it("returns mapped success payload", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      getSessionUrl,
      createPullRequest,
    } = createHandler();
    const session = createSession();
    const participant = createParticipant();
    getSession.mockReturnValue(session);
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({ auth: null });
    getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
    createPullRequest.mockResolvedValue({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "PR",
          body: "desc",
          baseBranch: "release",
          headBranch: "feature/pr",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
    });
    expect(createPullRequest).toHaveBeenCalledWith({
      title: "PR",
      body: "desc",
      baseBranch: "release",
      headBranch: "feature/pr",
      promptingUserId: "user-1",
      promptingAuth: null,
      sessionUrl: "https://app.example.com/session/public-session-1",
    });
  });
});
