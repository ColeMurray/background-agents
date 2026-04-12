import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { SandboxRow, SessionRow } from "../../types";
import { createSandboxHandler } from "./sandbox.handler";

function createHandler() {
  const repository = {
    createParticipant: vi.fn(),
    createArtifact: vi.fn(),
    createEvent: vi.fn(),
    getProcessingMessage: vi.fn(),
  };
  const processSandboxEvent = vi.fn();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const isValidSandboxToken = vi.fn();
  const getSession = vi.fn<() => SessionRow | null>();
  const refreshOpenAIToken = vi.fn();
  const isOpenAISecretsConfigured = vi.fn();
  const broadcast = vi.fn();
  const generateId = vi.fn(() => "participant-1");
  const now = vi.fn(() => 1234);

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const handler = createSandboxHandler({
    repository,
    processSandboxEvent,
    getSandbox,
    isValidSandboxToken,
    getSession,
    refreshOpenAIToken,
    isOpenAISecretsConfigured,
    broadcast,
    generateId,
    now,
    getLog: () => log,
  });

  return {
    handler,
    repository,
    processSandboxEvent,
    getSandbox,
    isValidSandboxToken,
    getSession,
    refreshOpenAIToken,
    isOpenAISecretsConfigured,
    broadcast,
    generateId,
    now,
    log,
  };
}

describe("createSandboxHandler", () => {
  it("processes sandbox event and returns ok response", async () => {
    const { handler, processSandboxEvent } = createHandler();
    const event = { type: "heartbeat" };

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

  it("creates a media artifact row and matching timeline event", async () => {
    const { handler, getSandbox, repository, broadcast, generateId } = createHandler();
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
    expect(repository.createArtifact).toHaveBeenCalledWith({
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

  it("rejects media artifacts when no prompt is active", async () => {
    const { handler, getSandbox, repository, broadcast } = createHandler();
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
    expect(repository.createArtifact).not.toHaveBeenCalled();
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

  it("returns 410 when sandbox is stopped", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue({ status: "stopped" } as SandboxRow);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ valid: false, error: "Sandbox stopped" });
    expect(log.warn).toHaveBeenCalledWith(
      "Sandbox token verification failed: sandbox is stopped/stale",
      { status: "stopped" }
    );
  });

  it("returns 410 when sandbox is stale", async () => {
    const { handler, getSandbox, log } = createHandler();
    getSandbox.mockReturnValue({ status: "stale" } as SandboxRow);

    const response = await handler.verifySandboxToken(
      new Request("http://internal/internal/verify-sandbox-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "abc" }),
      })
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ valid: false, error: "Sandbox stopped" });
    expect(log.warn).toHaveBeenCalledWith(
      "Sandbox token verification failed: sandbox is stopped/stale",
      { status: "stale" }
    );
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
    const { handler, getSession, isOpenAISecretsConfigured } = createHandler();
    getSession.mockReturnValue({} as SessionRow);
    isOpenAISecretsConfigured.mockReturnValue(false);

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Secrets not configured" });
  });

  it("returns mapped service error from openai token refresh", async () => {
    const { handler, getSession, isOpenAISecretsConfigured, refreshOpenAIToken } = createHandler();
    getSession.mockReturnValue({ id: "session-1" } as SessionRow);
    isOpenAISecretsConfigured.mockReturnValue(true);
    refreshOpenAIToken.mockResolvedValue({
      ok: false,
      status: 502,
      error: "OpenAI token refresh failed",
    });

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "OpenAI token refresh failed" });
  });

  it("returns openai access token payload on success", async () => {
    const { handler, getSession, isOpenAISecretsConfigured, refreshOpenAIToken } = createHandler();
    const session = { id: "session-1" } as SessionRow;
    getSession.mockReturnValue(session);
    isOpenAISecretsConfigured.mockReturnValue(true);
    refreshOpenAIToken.mockResolvedValue({
      ok: true,
      accessToken: "access-token",
      expiresIn: 3600,
      accountId: "acct_123",
    });

    const response = await handler.openaiTokenRefresh();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "access-token",
      expires_in: 3600,
      account_id: "acct_123",
    });
    expect(refreshOpenAIToken).toHaveBeenCalledWith(session);
  });
});
