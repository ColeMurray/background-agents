import { describe, expect, it } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import type { SourceControlProvider } from "../../src/source-control";
import type { SessionDO } from "../../src/session/durable-object";
import { generateInternalToken } from "../../src/auth/internal";
import { initNamedSession, initSession, queryDO, seedMessage } from "./helpers";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("POST /internal/create-pr", () => {
  it("returns 404 when session is not initialized", async () => {
    const id = env.SESSION.newUniqueId();
    const stub = env.SESSION.get(id);

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("Session not found");
  });

  it("returns 400 when no processing message exists", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe(
      "No active prompt found. PR creation must be triggered by a user prompt."
    );
  });

  it("returns 401 when processing message author cannot be resolved", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = ?",
      "user-1"
    );
    const ownerParticipantId = participants[0]?.id;
    if (!ownerParticipantId) {
      throw new Error("Expected owner participant");
    }

    await seedMessage(stub, {
      id: "msg-processing-missing-author",
      authorId: ownerParticipantId,
      content: "Create a PR",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec("PRAGMA foreign_keys = OFF");
      instance.ctx.storage.sql.exec(
        "UPDATE messages SET author_id = ? WHERE id = ?",
        "participant-does-not-exist",
        "msg-processing-missing-author"
      );
      instance.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
    });

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("User not found. Please re-authenticate.");
  });
  it("falls back to app auth when expired OAuth token cannot be refreshed", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = ?",
      "user-1"
    );
    const ownerParticipantId = participants[0]?.id;
    if (!ownerParticipantId) {
      throw new Error("Expected owner participant");
    }

    await seedMessage(stub, {
      id: "msg-processing-expired-token",
      authorId: ownerParticipantId,
      content: "Create a PR",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "UPDATE participants SET scm_access_token_encrypted = ?, scm_refresh_token_encrypted = ?, scm_token_expires_at = ? WHERE id = ?",
        "invalid-access-token",
        "invalid-refresh-token",
        Date.now() - 60_000,
        ownerParticipantId
      );

      // Set up mock provider so the app-token fallback path can complete
      const mockProvider = {
        name: "github",
        generatePushAuth: async () => ({ authType: "app", token: "push-token" as const }),
        getRepository: async () => ({
          owner: "acme",
          name: "web-app",
          fullName: "acme/web-app",
          defaultBranch: "main",
          isPrivate: true,
          providerRepoId: 12345,
        }),
        createPullRequest: async () => ({
          id: 99,
          webUrl: "https://github.com/acme/web-app/pull/99",
          apiUrl: "https://api.github.com/repos/acme/web-app/pulls/99",
          state: "open" as const,
          sourceBranch: "open-inspect/test-session",
          targetBranch: "main",
        }),
        buildManualPullRequestUrl: (config: {
          owner: string;
          name: string;
          sourceBranch: string;
          targetBranch: string;
        }) =>
          `https://github.com/${config.owner}/${config.name}/pull/new/${config.targetBranch}...${config.sourceBranch}`,
        buildGitPushSpec: (config: { targetBranch: string }) => ({
          remoteUrl: "https://example.invalid/repo.git",
          redactedRemoteUrl: "https://example.invalid/<redacted>.git",
          refspec: `HEAD:refs/heads/${config.targetBranch}`,
          targetBranch: config.targetBranch,
          force: true,
        }),
      } as unknown as SourceControlProvider;

      (
        instance as unknown as { _sourceControlProvider: SourceControlProvider | null }
      )._sourceControlProvider = mockProvider;
    });

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    // Should succeed via app token fallback, not fail with 401
    expect(res.status).toBe(200);
    const body = await res.json<{ prNumber: number; prUrl: string; state: string }>();
    expect(body.prNumber).toBe(99);
    expect(body.prUrl).toBe("https://github.com/acme/web-app/pull/99");
  });

  it("creates PR with app auth when prompting user has no OAuth token", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = ?",
      "user-1"
    );
    const ownerParticipantId = participants[0]?.id;
    if (!ownerParticipantId) {
      throw new Error("Expected owner participant");
    }

    await seedMessage(stub, {
      id: "msg-processing-1",
      authorId: ownerParticipantId,
      content: "Create a PR",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      const mockProvider = {
        name: "github",
        generatePushAuth: async () => ({ authType: "app", token: "push-token" as const }),
        getRepository: async () => ({
          owner: "acme",
          name: "web-app",
          fullName: "acme/web-app",
          defaultBranch: "main",
          isPrivate: true,
          providerRepoId: 12345,
        }),
        createPullRequest: async () => ({
          id: 42,
          webUrl: "https://github.com/acme/web-app/pull/42",
          apiUrl: "https://api.github.com/repos/acme/web-app/pulls/42",
          state: "open" as const,
          sourceBranch: "open-inspect/test-session",
          targetBranch: "main",
        }),
        buildManualPullRequestUrl: (config: {
          owner: string;
          name: string;
          sourceBranch: string;
          targetBranch: string;
        }) =>
          `https://github.com/${config.owner}/${config.name}/pull/new/${config.targetBranch}...${config.sourceBranch}`,
        buildGitPushSpec: (config: { targetBranch: string }) => ({
          remoteUrl: "https://example.invalid/repo.git",
          redactedRemoteUrl: "https://example.invalid/<redacted>.git",
          refspec: `HEAD:refs/heads/${config.targetBranch}`,
          targetBranch: config.targetBranch,
          force: true,
        }),
      } as unknown as SourceControlProvider;

      (
        instance as unknown as { _sourceControlProvider: SourceControlProvider | null }
      )._sourceControlProvider = mockProvider;
    });

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      prNumber: number;
      prUrl: string;
      state: string;
    }>();
    expect(body.prNumber).toBe(42);
    expect(body.prUrl).toBe("https://github.com/acme/web-app/pull/42");
    expect(body.state).toBe("open");

    const artifacts = await queryDO<{ type: string; metadata: string | null }>(
      stub,
      "SELECT type, metadata FROM artifacts ORDER BY created_at DESC LIMIT 1"
    );
    expect(artifacts[0]?.type).toBe("pr");
    expect(artifacts[0]?.metadata).toContain('"number":42');
  });

  it("returns 409 when a PR artifact already exists", async () => {
    const { stub } = await initSession({ userId: "user-1" });

    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = ?",
      "user-1"
    );
    const ownerParticipantId = participants[0]?.id;
    if (!ownerParticipantId) {
      throw new Error("Expected owner participant");
    }

    await seedMessage(stub, {
      id: "msg-processing-2",
      authorId: ownerParticipantId,
      content: "Create a PR",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      instance.ctx.storage.sql.exec(
        "INSERT INTO artifacts (id, type, url, metadata, created_at) VALUES (?, ?, ?, ?, ?)",
        "artifact-pr-existing",
        "pr",
        "https://github.com/acme/web-app/pull/1",
        JSON.stringify({ number: 1 }),
        Date.now()
      );
    });

    const res = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test PR",
        body: "Body from integration test",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe(
      "A pull request has already been created for acme/web-app in this session."
    );
  });

  describe("multi-repo sessions", () => {
    const multiRepoInit = {
      repoOwner: "acme",
      repoName: "web-app",
      repoId: 1,
      defaultBranch: "main",
      repositories: [
        { repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
      ],
    };

    async function seedProcessingMessage(stub: DurableObjectStub, messageId: string) {
      const participants = await queryDO<{ id: string }>(
        stub,
        "SELECT id FROM participants WHERE user_id = ?",
        "user-1"
      );
      const ownerParticipantId = participants[0]?.id;
      if (!ownerParticipantId) {
        throw new Error("Expected owner participant");
      }
      await seedMessage(stub, {
        id: messageId,
        authorId: ownerParticipantId,
        content: "Create a PR",
        source: "web",
        status: "processing",
        createdAt: Date.now() - 1000,
        startedAt: Date.now() - 500,
      });
    }

    async function installMockProvider(stub: DurableObjectStub) {
      await runInDurableObject(stub, (instance: SessionDO) => {
        let prCounter = 0;
        const mockProvider = {
          name: "github",
          generatePushAuth: async () => ({ authType: "app", token: "push-token" as const }),
          getRepository: async (_auth: unknown, config: { owner: string; name: string }) => ({
            owner: config.owner,
            name: config.name,
            fullName: `${config.owner}/${config.name}`,
            defaultBranch: "main",
            isPrivate: true,
            providerRepoId: 12345,
          }),
          createPullRequest: async (
            _auth: unknown,
            config: { repository: { owner: string; name: string } }
          ) => {
            prCounter += 1;
            return {
              id: prCounter,
              webUrl: `https://github.com/${config.repository.owner}/${config.repository.name}/pull/${prCounter}`,
              apiUrl: `https://api.github.com/repos/${config.repository.owner}/${config.repository.name}/pulls/${prCounter}`,
              state: "open" as const,
              sourceBranch: "open-inspect/test-session",
              targetBranch: "main",
            };
          },
          buildManualPullRequestUrl: (config: {
            owner: string;
            name: string;
            sourceBranch: string;
            targetBranch: string;
          }) =>
            `https://github.com/${config.owner}/${config.name}/pull/new/${config.targetBranch}...${config.sourceBranch}`,
          buildGitPushSpec: (config: { owner: string; name: string; targetBranch: string }) => ({
            remoteUrl: `https://example.invalid/${config.owner}/${config.name}.git`,
            redactedRemoteUrl: `https://example.invalid/<redacted>.git`,
            refspec: `HEAD:refs/heads/${config.targetBranch}`,
            targetBranch: config.targetBranch,
            repoOwner: config.owner,
            repoName: config.name,
            force: true,
          }),
        } as unknown as SourceControlProvider;

        (
          instance as unknown as { _sourceControlProvider: SourceControlProvider | null }
        )._sourceControlProvider = mockProvider;
      });
    }

    function postPr(stub: DurableObjectStub, body: Record<string, unknown>) {
      return stub.fetch("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("creates one PR per member repo with repo metadata on each artifact", async () => {
      const { stub } = await initSession({ userId: "user-1", ...multiRepoInit });
      await seedProcessingMessage(stub, "msg-multi-1");
      await installMockProvider(stub);

      const first = await postPr(stub, {
        title: "Web PR",
        body: "desc",
        repoOwner: "acme",
        repoName: "web-app",
      });
      expect(first.status).toBe(200);

      const second = await postPr(stub, {
        title: "Backend PR",
        body: "desc",
        repoOwner: "acme",
        repoName: "backend",
      });
      expect(second.status).toBe(200);

      const artifacts = await queryDO<{ type: string; url: string; metadata: string }>(
        stub,
        "SELECT type, url, metadata FROM artifacts WHERE type = 'pr' ORDER BY created_at"
      );
      expect(artifacts).toHaveLength(2);
      const parsed = artifacts.map((artifact) => JSON.parse(artifact.metadata));
      expect(parsed[0]).toMatchObject({ repoOwner: "acme", repoName: "web-app" });
      expect(parsed[1]).toMatchObject({ repoOwner: "acme", repoName: "backend", base: "develop" });

      // Per-repo branch state: both member rows carry the shared generated
      // branch; the scalar mirror only tracks the primary.
      const memberRows = await queryDO<{ repo_name: string; branch_name: string | null }>(
        stub,
        "SELECT repo_name, branch_name FROM session_repositories ORDER BY position"
      );
      expect(memberRows[0]?.branch_name).not.toBeNull();
      expect(memberRows[1]?.branch_name).toBe(memberRows[0]?.branch_name);

      // The WebSocket session state surfaces each member's own PR URL.
      const state = await runInDurableObject(stub, (instance: SessionDO) =>
        (
          instance as unknown as {
            getSessionState(): Promise<{
              repositories: Array<{ repoName: string; prUrl: string | null }>;
            }>;
          }
        ).getSessionState()
      );
      expect(state.repositories.map((repo) => repo.prUrl)).toEqual([
        "https://github.com/acme/web-app/pull/1",
        "https://github.com/acme/backend/pull/2",
      ]);
    });

    it("returns 409 only for the member that already has a PR", async () => {
      const { stub } = await initSession({ userId: "user-1", ...multiRepoInit });
      await seedProcessingMessage(stub, "msg-multi-2");
      await installMockProvider(stub);

      const first = await postPr(stub, {
        title: "Backend PR",
        body: "desc",
        repoOwner: "acme",
        repoName: "backend",
      });
      expect(first.status).toBe(200);

      const duplicate = await postPr(stub, {
        title: "Backend PR again",
        body: "desc",
        repoOwner: "acme",
        repoName: "backend",
      });
      expect(duplicate.status).toBe(409);
      const dupBody = await duplicate.json<{ error: string }>();
      expect(dupBody.error).toBe(
        "A pull request has already been created for acme/backend in this session."
      );

      const other = await postPr(stub, {
        title: "Web PR",
        body: "desc",
        repoOwner: "acme",
        repoName: "web-app",
      });
      expect(other.status).toBe(200);
    });

    it("rejects an omitted target on a multi-repo session through the proxy route", async () => {
      const sessionName = `pr-target-400-${Date.now()}`;
      await initNamedSession(sessionName, multiRepoInit);

      const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/pr`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ title: "PR", body: "desc" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe(
        "This session spans multiple repositories — specify repoOwner and repoName (one of: acme/web-app, acme/backend)"
      );
    });

    it("rejects a non-member target with 403 through the proxy route", async () => {
      const sessionName = `pr-target-403-${Date.now()}`;
      await initNamedSession(sessionName, multiRepoInit);

      const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/pr`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({
          title: "PR",
          body: "desc",
          repoOwner: "evil",
          repoName: "exfil",
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe("Repository evil/exfil is not part of this session");
    });
  });
});
