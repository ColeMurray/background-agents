import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { SourceControlProvider } from "../../src/source-control";
import type { SessionDO } from "../../src/session/durable-object";
import { initSession, queryDO, seedMessage } from "./helpers";

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
  it("returns 401 when expired OAuth token cannot be refreshed", async () => {
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
    expect(body.error).toBe(
      "Your source control token has expired and could not be refreshed. Please re-authenticate."
    );
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
    expect(body.error).toBe("A pull request has already been created for this session.");
  });
});
