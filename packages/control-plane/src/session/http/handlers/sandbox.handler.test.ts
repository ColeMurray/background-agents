import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import {
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
} from "../../openai-token-refresh-service";
import type { SandboxRow, SessionRow } from "../../types";
import { createSandboxHandler } from "./sandbox.handler";
import type { ArtifactRepository } from "../../artifact-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { EventRepository } from "../../event-repository";
import type { MessageRepository } from "../../message-repository";

function createHandler() {
  const repository = {
    createParticipant: vi.fn(),
    createEvent: vi.fn(),
    getProcessingMessage: vi.fn(),
  };
  const artifactRepository = { createArtifact: vi.fn() } as unknown as ArtifactRepository;
  const processSandboxEvent = vi.fn();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const isValidSandboxToken = vi.fn();
  const getSession = vi.fn<() => SessionRow | null>();
  const refreshOpenAIToken = vi.fn();
  const refreshXaiToken = vi.fn();
  const isManagedSecretsConfigured = vi.fn();
  const getScmCredentials = vi.fn();
  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const generateId = vi.fn(() => "participant-1");
  const now = vi.fn(() => 1234);

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const sandboxHandler = createSandboxHandler({
    messageRepository: repository as unknown as MessageRepository,
    eventRepository: repository as unknown as EventRepository,
    participantRepository: repository as unknown as ParticipantRepository,
    artifactRepository,
    processSandboxEvent,
    getSandbox,
    isValidSandboxToken,
    getSession,
    refreshOpenAIToken,
    refreshXaiToken,
    isManagedSecretsConfigured,
    getScmCredentials,
    messenger,
    generateId,
    now,
  });

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    ...sandboxHandler,
    verifySandboxToken: (request: Request) => sandboxHandler.verifySandboxToken(request, log),
    openaiTokenRefresh: () => sandboxHandler.openaiTokenRefresh(log),
    xaiTokenRefresh: () => sandboxHandler.xaiTokenRefresh(log),
    scmCredentials: () => sandboxHandler.scmCredentials(log),
    tunnelUrls: () => sandboxHandler.tunnelUrls(log),
  };

  return {
    handler,
    repository,
    artifactRepository,
    processSandboxEvent,
    getSandbox,
    isValidSandboxToken,
    getSession,
    refreshOpenAIToken,
    refreshXaiToken,
    isManagedSecretsConfigured,
    getScmCredentials,
    broadcast,
    generateId,
    now,
    log,
  };
}

describe("createSandboxHandler", () => {
  it("processes sandbox event and returns ok response", async () => {
    const { handler, processSandboxEvent } = createHandler();
    const event = {
      type: "heartbeat",
      sandboxId: "sandbox-1",
      status: "running",
      timestamp: 123,
    };

    const response = await handler.sandboxEvent(
      new Request("http://internal/internal/sandbox/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(processSandboxEvent).toHaveBeenCalledWith(event);
  });

  it("rejects malformed sandbox events", async () => {
    const { handler, processSandboxEvent } = createHandler();

    const response = await handler.sandboxEvent(
      new Request("http://internal/internal/sandbox/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "heartbeat" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid sandbox event" });
    expect(processSandboxEvent).not.toHaveBeenCalled();
  });

  it("adds participant with defaults and returns id", async () => {
    const { handler, repository, generateId, now } = createHandler();

    const response = await handler.addParticipant(
      new Request("http://internal/internal/participants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "participant-1", status: "added" });
    expect(generateId).toHaveBeenCalled();
    expect(now).toHaveBeenCalled();
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "user-1",
      scmLogin: "octocat",
      scmName: "The Octocat",
      scmEmail: null,
      role: "member",
      joinedAt: 1234,
    });
  });

  it("adds participant with a parsed owner role", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.addParticipant(
      new Request("http://internal/internal/participants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", role: "owner" }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", role: "owner" })
    );
  });

  it("rejects malformed participant bodies", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.addParticipant(
      new Request("http://internal/internal/participants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: 123 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid participant body" });
    expect(repository.createParticipant).not.toHaveBeenCalled();
  });

  it("rejects invalid participant roles", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.addParticipant(
      new Request("http://internal/internal/participants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", role: "admin" }),
      })
    );

    expect(response.status).toBe(400);
    expect(repository.createParticipant).not.toHaveBeenCalled();
  });

  it("creates a media artifact row and matching timeline event", async () => {
    const { handler, getSandbox, repository, artifactRepository, broadcast, generateId } =
      createHandler();
    getSandbox.mockReturnValue({
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
    } as SandboxRow);
    repository.getProcessingMessage.mockReturnValue({ id: "msg-1" });
    generateId.mockReturnValueOnce("event-1");

    const response = await handler.createMediaArtifact(
      new Request("http://internal/internal/create-media-artifact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact-1",
          artifactType: "screenshot",
          objectKey: "sessions/session-1/media/artifact-1.png",
          metadata: {
            objectKey: "sessions/session-1/media/artifact-1.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", artifactId: "artifact-1" });
    expect(artifactRepository.createArtifact).toHaveBeenCalledWith({
      id: "artifact-1",
      type: "screenshot",
      url: "sessions/session-1/media/artifact-1.png",
      metadata: JSON.stringify({
        objectKey: "sessions/session-1/media/artifact-1.png",
        mimeType: "image/png",
        sizeBytes: 128,
      }),
      createdAt: 1234,
    });
    expect(repository.createEvent).toHaveBeenCalledWith({
      id: "event-1",
      type: "artifact",
      data: JSON.stringify({
        type: "artifact",
        artifactType: "screenshot",
        artifactId: "artifact-1",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
        messageId: "msg-1",
        sandboxId: "sandbox-1",
        timestamp: 1.234,
      }),
      messageId: "msg-1",
      createdAt: 1234,
    });
    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: "artifact_created",
      artifact: {
        id: "artifact-1",
        type: "screenshot",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
        createdAt: 1234,
        updatedAt: 1234,
      },
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, {
      type: "sandbox_event",
      event: {
        type: "artifact",
        artifactType: "screenshot",
        artifactId: "artifact-1",
        url: "sessions/session-1/media/artifact-1.png",
        metadata: {
          objectKey: "sessions/session-1/media/artifact-1.png",
          mimeType: "image/png",
          sizeBytes: 128,
        },
        messageId: "msg-1",
        sandboxId: "sandbox-1",
        timestamp: 1.234,
      },
    });
  });

  it("rejects malformed media artifact bodies", async () => {
    const { handler, repository, artifactRepository, broadcast } = createHandler();

    const response = await handler.createMediaArtifact(
      new Request("http://internal/internal/create-media-artifact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: "artifact-1", objectKey: 123 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid media artifact body" });
    expect(artifactRepository.createArtifact).not.toHaveBeenCalled();
    expect(repository.createEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects media artifacts when no prompt is active", async () => {
    const { handler, getSandbox, repository, artifactRepository, broadcast } = createHandler();
    getSandbox.mockReturnValue({
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
    } as SandboxRow);
    repository.getProcessingMessage.mockReturnValue(null);

    const response = await handler.createMediaArtifact(
      new Request("http://internal/internal/create-media-artifact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          artifactId: "artifact-1",
          artifactType: "screenshot",
          objectKey: "sessions/session-1/media/artifact-1.png",
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "No active prompt" });
    expect(artifactRepository.createArtifact).not.toHaveBeenCalled();
    expect(repository.createEvent).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("returns 400 when sandbox token is missing", async () => {
    const { handler } = createHandler();

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ valid: false, error: "Missing token" });
  });

  it("returns 400 when sandbox token is not a string", async () => {
    const { handler, isValidSandboxToken } = createHandler();

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: 123 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ valid: false, error: "Missing token" });
    expect(isValidSandboxToken).not.toHaveBeenCalled();
  });

  it("returns 404 when sandbox is missing", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue(null);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ valid: false, error: "No sandbox" });
    expect(log.warn).toHaveBeenCalledWith("Sandbox token verification failed: no sandbox");
  });

  it.each(["stopped", "stale", "failed"] as const)(
    "returns 410 without comparing the token when sandbox is %s",
    async (status) => {
      const { handler, getSandbox, isValidSandboxToken, log } = createHandler();
      getSandbox.mockReturnValue({ status } as SandboxRow);

      const response = await handler.verifySandboxToken(
        new Request("http://internal/internal/verify-sandbox-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "abc" }),
        })
      );

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ valid: false, error: "Sandbox not active" });
      expect(log.warn).toHaveBeenCalledWith("Sandbox token verification failed: sandbox is dead", {
        status,
      });
      expect(isValidSandboxToken).not.toHaveBeenCalled();
    }
  );

  // Boot-time states (spawning/connecting) must authenticate — the git
  // credential broker is called during the initial clone, before the sandbox
  // WebSocket connect flips the status to ready. "running" is not currently
  // produced by any lifecycle path but remains a valid live state.
  it.each([
    "pending",
    "spawning",
    "connecting",
    "warming",
    "syncing",
    "ready",
    "running",
    "snapshotting",
  ] as const)("accepts a valid token when sandbox is %s", async (status) => {
    const { handler, getSandbox, isValidSandboxToken } = createHandler();
    getSandbox.mockReturnValue({ status } as SandboxRow);
    vi.mocked(isValidSandboxToken).mockResolvedValue(true);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
  });

  it("returns 401 when sandbox token is invalid", async () => {
    const { handler, getSandbox, isValidSandboxToken, log } = createHandler();
    getSandbox.mockReturnValue({ status: "running" } as SandboxRow);
    vi.mocked(isValidSandboxToken).mockResolvedValue(false);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ valid: false, error: "Invalid token" });
    expect(log.warn).toHaveBeenCalledWith("Sandbox token verification failed: token mismatch");
  });

  it("returns 200 when sandbox token is valid", async () => {
    const { handler, getSandbox, isValidSandboxToken, log } = createHandler();
    getSandbox.mockReturnValue({ status: "running" } as SandboxRow);
    vi.mocked(isValidSandboxToken).mockResolvedValue(true);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true });
    expect(log.info).toHaveBeenCalledWith("Sandbox token verified successfully");
  });

  it("returns 404 when openai token refresh has no session", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No session" });
  });

  it("returns 500 when openai secrets are not configured", async () => {
    const { handler, getSession, isManagedSecretsConfigured } = createHandler();
    getSession.mockReturnValue({} as SessionRow);
    isManagedSecretsConfigured.mockReturnValue(false);

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Secrets not configured" });
  });

  it.each([
    [OpenAITokenNotConfiguredError, 404, "OPENAI_OAUTH_REFRESH_TOKEN not configured"],
    [OpenAITokenUnauthorizedError, 401, "OpenAI token refresh failed: unauthorized"],
    [OpenAITokenStorageError, 500, "Failed to read token state"],
    [
      OpenAITokenStorageError,
      500,
      "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth",
    ],
    [OpenAITokenUpstreamError, 502, "OpenAI token refresh failed"],
  ])("maps %s to status %i", async (ErrorType, status, message) => {
    const { handler, getSession, isManagedSecretsConfigured, refreshOpenAIToken } = createHandler();
    getSession.mockReturnValue({ id: "session-1" } as SessionRow);
    isManagedSecretsConfigured.mockReturnValue(true);
    refreshOpenAIToken.mockRejectedValue(new ErrorType(message));

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it("does not mask unexpected OpenAI token refresh failures", async () => {
    const { handler, getSession, isManagedSecretsConfigured, refreshOpenAIToken } = createHandler();
    getSession.mockReturnValue({ id: "session-1" } as SessionRow);
    isManagedSecretsConfigured.mockReturnValue(true);
    const unexpected = new Error("unexpected refresh failure");
    refreshOpenAIToken.mockRejectedValue(unexpected);

    await expect(handler.openaiTokenRefresh()).rejects.toBe(unexpected);
  });

  it("returns openai access token payload on success", async () => {
    const { handler, getSession, isManagedSecretsConfigured, refreshOpenAIToken, log } =
      createHandler();
    const session = { id: "session-1" } as SessionRow;
    getSession.mockReturnValue(session);
    isManagedSecretsConfigured.mockReturnValue(true);
    refreshOpenAIToken.mockResolvedValue({
      accessToken: "access-token",
      expiresIn: 3600,
      accountId: "acct_123",
    });

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      access_token: "access-token",
      expires_in: 3600,
      account_id: "acct_123",
    });
    expect(refreshOpenAIToken).toHaveBeenCalledWith(session, log);
  });

  it("returns xAI access token payload on success", async () => {
    const { handler, getSession, isManagedSecretsConfigured, refreshXaiToken, log } =
      createHandler();
    const session = { id: "session-1" } as SessionRow;
    getSession.mockReturnValue(session);
    isManagedSecretsConfigured.mockReturnValue(true);
    refreshXaiToken.mockResolvedValue({ ok: true, accessToken: "xai-access", expiresIn: 3600 });

    const response = await handler.xaiTokenRefresh();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ access_token: "xai-access", expires_in: 3600 });
    expect(refreshXaiToken).toHaveBeenCalledWith(session, log);
  });

  it("returns 404 when xAI token refresh has no session", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.xaiTokenRefresh();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No session" });
  });

  it("returns 500 when managed secrets are not configured for xAI", async () => {
    const { handler, getSession, isManagedSecretsConfigured } = createHandler();
    getSession.mockReturnValue({} as SessionRow);
    isManagedSecretsConfigured.mockReturnValue(false);

    const response = await handler.xaiTokenRefresh();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Secrets not configured" });
  });

  it("returns mapped service error from xAI token refresh", async () => {
    const { handler, getSession, isManagedSecretsConfigured, refreshXaiToken } = createHandler();
    getSession.mockReturnValue({ id: "session-1" } as SessionRow);
    isManagedSecretsConfigured.mockReturnValue(true);
    refreshXaiToken.mockResolvedValue({ ok: false, status: 401, error: "xAI unauthorized" });

    const response = await handler.xaiTokenRefresh();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "xAI unauthorized" });
  });

  it("returns 404 when scm credentials have no session", async () => {
    const { handler, getSession, getScmCredentials } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.scmCredentials();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No session" });
    expect(getScmCredentials).not.toHaveBeenCalled();
  });

  it("returns mapped service error from scm credentials", async () => {
    const { handler, getSession, getScmCredentials } = createHandler();
    getSession.mockReturnValue({
      id: "session-1",
      repo_owner: "acme",
      repo_name: "web-app",
    } as SessionRow);
    getScmCredentials.mockResolvedValue({
      ok: false,
      status: 503,
      error: "GitHub App not configured",
    });

    const response = await handler.scmCredentials();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "GitHub App not configured" });
  });

  it("rejects scm credentials for no-repository sessions", async () => {
    const { handler, getSession, getScmCredentials } = createHandler();
    getSession.mockReturnValue({
      id: "session-1",
      repo_owner: null,
      repo_name: null,
    } as SessionRow);

    const response = await handler.scmCredentials();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "SCM credentials require a repository context",
    });
    expect(getScmCredentials).not.toHaveBeenCalled();
  });

  it("returns scm credentials payload on success", async () => {
    const { handler, getSession, getScmCredentials } = createHandler();
    getSession.mockReturnValue({
      id: "session-1",
      repo_owner: "acme",
      repo_name: "web-app",
    } as SessionRow);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    getScmCredentials.mockResolvedValue({
      ok: true,
      username: "x-access-token",
      password: "ghs_secret",
      expiresAtEpochMs: expiresAt,
    });

    const response = await handler.scmCredentials();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      username: "x-access-token",
      password: "ghs_secret",
      expires_at_epoch_ms: expiresAt,
    });
  });

  it("returns 404 when tunnel URLs have no sandbox", async () => {
    const { handler, getSandbox } = createHandler();
    getSandbox.mockReturnValue(null);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No sandbox" });
  });

  it("returns an empty map when no tunnel URLs are stored yet", async () => {
    const { handler, getSandbox } = createHandler();
    getSandbox.mockReturnValue({ tunnel_urls: null } as unknown as SandboxRow);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ tunnelUrls: {} });
  });

  it("returns parsed tunnel URLs on success", async () => {
    const { handler, getSandbox } = createHandler();
    getSandbox.mockReturnValue({
      tunnel_urls: JSON.stringify({ "3000": "https://a.example", "5000": "https://b.example" }),
    } as unknown as SandboxRow);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      tunnelUrls: { "3000": "https://a.example", "5000": "https://b.example" },
    });
  });

  it("returns 500 when stored tunnel URLs are malformed JSON", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue({ tunnel_urls: "{not json" } as unknown as SandboxRow);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Invalid stored tunnel URLs" });
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns 500 when stored tunnel URLs are not an object", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue({
      tunnel_urls: JSON.stringify(["3000", "5000"]),
    } as unknown as SandboxRow);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Invalid stored tunnel URLs" });
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns 500 when a stored tunnel URL value is not a string", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue({
      tunnel_urls: JSON.stringify({ "3000": "https://a.example", "5000": 5000 }),
    } as unknown as SandboxRow);

    const response = await handler.tunnelUrls();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Invalid stored tunnel URLs" });
    expect(log.warn).toHaveBeenCalled();
  });
});
