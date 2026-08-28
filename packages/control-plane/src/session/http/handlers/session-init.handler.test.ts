import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import { SessionInitHandler } from "./session-init.handler";
import type { ParticipantRepository } from "../../participant-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import { getValidModelOrDefault } from "@open-inspect/shared/models";

function createHandler() {
  const repository = {
    upsertSession: vi.fn(),
    replaceSessionRepositories: vi.fn(),
    transaction: vi.fn((callback: () => void) => callback()),
    createParticipant: vi.fn(),
  };
  const sandboxRepository = {
    createSandbox: vi.fn(),
  } as unknown as SandboxRepository;
  const encryptScmToken = vi.fn();
  const generateId = vi.fn();
  const now = vi.fn(() => 1234);
  const scheduleWarmSandbox = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const sessionInitHandler = new SessionInitHandler(
    repository as unknown as SessionCoreRepository,
    sandboxRepository,
    repository as unknown as ParticipantRepository,
    "session-do-id",
    scheduleWarmSandbox,
    encryptScmToken,
    generateId,
    now
  );

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    init: (request: Request) => sessionInitHandler.init(request, log),
  };

  return {
    handler,
    repository,
    sandboxRepository,
    encryptScmToken,
    generateId,
    now,
    scheduleWarmSandbox,
    log,
  };
}

describe("SessionInitHandler", () => {
  it.each([
    ["repoOwner without repoName", { repoOwner: "acme", repoName: null }],
    ["repoId without repository context", { repoOwner: null, repoName: null, repoId: 123 }],
    ["repository context without repoId", { repoOwner: "acme", repoName: "repo", repoId: null }],
  ])("rejects partial repository contexts during init: %s", async (_name, repoFields) => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          ...repoFields,
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Repository context must include repoOwner, repoName, and repoId together",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
  });

  it("initializes session, sandbox, and owner participant", async () => {
    const {
      handler,
      repository,
      sandboxRepository,
      encryptScmToken,
      generateId,
      scheduleWarmSandbox,
      log,
    } = createHandler();
    encryptScmToken.mockResolvedValue("encrypted-scm-token");
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          defaultBranch: "main",
          branch: "feature/work",
          title: "Session title",
          model: "anthropic/claude-haiku-4-5",
          reasoningEffort: "high",
          userId: "slack:U123",
          canonicalUserId: "canonical-user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
          scmEmail: "octocat@example.com",
          scmToken: "plain-scm-token",
          scmRefreshTokenEncrypted: "encrypted-refresh-token",
          scmTokenExpiresAt: 9999999,
          scmUserId: "github-user-123",
          parentSessionId: "parent-1",
          spawnSource: "agent",
          spawnDepth: 1,
          vncEnabled: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: "session-do-id", status: "created" });
    expect(repository.upsertSession).toHaveBeenCalledWith({
      id: "session-do-id",
      sessionName: "session-public-id",
      title: "Session title",
      repoOwner: "acme",
      repoName: "repo",
      repoId: 123,
      baseBranch: "feature/work",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      status: "created",
      parentSessionId: "parent-1",
      spawnSource: "agent",
      spawnDepth: 1,
      codeServerEnabled: false,
      vncEnabled: true,
      sandboxSettings: null,
      environmentId: null,
      createdAt: 1234,
      updatedAt: 1234,
    });
    expect(sandboxRepository.createSandbox).toHaveBeenCalledWith({
      id: "sandbox-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "slack:U123",
      canonicalUserId: "canonical-user-1",
      scmUserId: "github-user-123",
      scmLogin: "octocat",
      scmName: "The Octocat",
      scmEmail: "octocat@example.com",
      scmAccessTokenEncrypted: "encrypted-scm-token",
      scmRefreshTokenEncrypted: "encrypted-refresh-token",
      scmTokenExpiresAt: 9999999,
      role: "owner",
      joinedAt: 1234,
    });
    // Scalar init synthesizes a one-entry member set.
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([
      {
        position: 0,
        repoOwner: "acme",
        repoName: "repo",
        repoId: 123,
        baseBranch: "feature/work",
      },
    ]);
    expect(repository.transaction).toHaveBeenCalledOnce();
    expect(scheduleWarmSandbox).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Triggering sandbox spawn for new session");
  });

  it("persists the repositories list in position order", async () => {
    const { handler, repository, generateId } = createHandler();
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          defaultBranch: "main",
          repositories: [
            { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
            { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
          ],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([
      { position: 0, repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
      { position: 1, repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
    ]);
  });

  it("persists an empty member set for repo-less sessions", async () => {
    const { handler, repository, generateId } = createHandler();
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([]);
  });

  it("accepts nullable init fields and sandbox settings", async () => {
    const { handler, repository, generateId } = createHandler();
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repoId: null,
          environmentId: null,
          // initialize.ts forwards these straight from SessionInitInput, where
          // every one of them is nullable — the schema must accept null, not
          // just absence, or session creation 400s.
          reasoningEffort: null,
          canonicalUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmToken: null,
          scmTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
          scmUserId: null,
          parentSessionId: null,
          sandboxSettings: { cpuCores: null, memoryMib: null, tunnelPorts: [3000] },
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: null,
        repoName: null,
        repoId: null,
        environmentId: null,
        parentSessionId: null,
      })
    );
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        scmLogin: null,
        scmName: null,
        scmEmail: null,
      })
    );
    const upsert = repository.upsertSession.mock.calls[0]![0];
    expect(JSON.parse(upsert.sandboxSettings!)).toEqual({
      cpuCores: null,
      memoryMib: null,
      tunnelPorts: [3000],
    });
  });

  it("preserves optional init fields the schema must not silently drop", async () => {
    const { handler, repository, generateId } = createHandler();
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repoId: null,
          userId: "user-1",
          canonicalUserId: "platform-user-1",
          vncEnabled: true,
          // sandboxTimeoutMs is validated by normalizeSandboxSettings, not by a
          // restated field list — a hand-copied schema would drop it here.
          sandboxSettings: { sandboxTimeoutMs: 14_400_000, vncPort: 6080 },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ vncEnabled: true })
    );
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalUserId: "platform-user-1" })
    );
    const upsert = repository.upsertSession.mock.calls[0]![0];
    expect(JSON.parse(upsert.sandboxSettings!)).toEqual({
      sandboxTimeoutMs: 14_400_000,
      vncPort: 6080,
    });
  });

  it("rejects malformed init bodies before creating records", async () => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          userId: 123,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
  });

  it("rejects a repositories list whose primary does not match the scalar mirror", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          defaultBranch: "main",
          repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" }],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories[0] must match the scalar repository mirror",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(repository.replaceSessionRepositories).not.toHaveBeenCalled();
  });

  it("rejects an explicit empty repositories list alongside scalar context", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          repositories: [],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories must include the scalar repository",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
  });

  it("rejects a repositories list on a repo-less session", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" }],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories[0] must match the scalar repository mirror",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
  });

  it("falls back to pre-encrypted token when plain-token encryption fails", async () => {
    const { handler, repository, encryptScmToken, generateId, log } = createHandler();
    encryptScmToken.mockRejectedValue(new Error("encrypt failed"));
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          userId: "user-1",
          scmToken: "plain-scm-token",
          scmTokenEncrypted: "existing-encrypted-token",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        scmAccessTokenEncrypted: "existing-encrypted-token",
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "Failed to encrypt SCM token",
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("logs invalid model warning and stores normalized model", async () => {
    const { handler, repository, generateId, log } = createHandler();
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          model: "invalid/model-name",
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: getValidModelOrDefault("invalid/model-name"),
      })
    );
    expect(log.warn).toHaveBeenCalledWith("Invalid model name, using default", {
      requested_model: "invalid/model-name",
      default_model: getValidModelOrDefault("invalid/model-name"),
    });
  });
});
