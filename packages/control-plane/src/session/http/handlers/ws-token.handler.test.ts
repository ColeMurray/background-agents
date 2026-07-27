import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { ParticipantRow } from "../../types";
import { createWsTokenHandler } from "./ws-token.handler";

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: "scm-user-1",
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: "enc-access",
    scm_refresh_token_encrypted: "enc-refresh",
    scm_token_expires_at: 1000,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const repository = {
    createParticipant: vi.fn(),
    updateParticipantCoalesce: vi.fn(),
    updateParticipantWsToken: vi.fn(),
  };

  const getParticipantByUserId = vi.fn<(userId: string) => ParticipantRow | null>();
  const generateId = vi
    .fn<(bytes?: number) => string>()
    .mockImplementation((bytes?: number) => (bytes === 32 ? "plain-token" : "participant-1"));
  const hashToken = vi.fn<(token: string) => Promise<string>>().mockResolvedValue("token-hash");
  const now = vi.fn(() => 1234);
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const wsTokenHandler = createWsTokenHandler({
    repository,
    getParticipantByUserId,
    generateId,
    hashToken,
    now,
  });

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    generateWsToken: (request: Request) => wsTokenHandler.generateWsToken(request, log),
  };

  return {
    handler,
    repository,
    getParticipantByUserId,
    generateId,
    hashToken,
    now,
    log,
  };
}

describe("createWsTokenHandler", () => {
  it("returns 400 when userId is missing", async () => {
    const { handler } = createHandler();

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "userId is required" });
  });

  it("returns 400 for malformed token metadata", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", scmTokenExpiresAt: "tomorrow" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(repository.updateParticipantCoalesce).not.toHaveBeenCalled();
  });

  it("updates an existing participant and issues a new token", async () => {
    const { handler, repository, getParticipantByUserId, hashToken, log } = createHandler();
    const participant = createParticipant({ scm_token_expires_at: 1000 });
    getParticipantByUserId.mockReturnValue(participant);

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmUserId: "scm-user-1",
          scmLogin: "octocat-updated",
          scmName: "Updated Octocat",
          scmEmail: "updated@example.com",
          scmTokenEncrypted: "enc-access-new",
          scmRefreshTokenEncrypted: "enc-refresh-new",
          scmTokenExpiresAt: 2000,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: "plain-token",
      participantId: "participant-1",
    });
    expect(repository.updateParticipantCoalesce).toHaveBeenCalledWith("participant-1", {
      scmUserId: "scm-user-1",
      scmLogin: "octocat-updated",
      scmName: "Updated Octocat",
      authName: null,
      scmEmail: "updated@example.com",
      scmAccessTokenEncrypted: "enc-access-new",
      scmRefreshTokenEncrypted: "enc-refresh-new",
      scmTokenExpiresAt: 2000,
    });
    expect(hashToken).toHaveBeenCalledWith("plain-token");
    expect(repository.updateParticipantWsToken).toHaveBeenCalledWith(
      "participant-1",
      "token-hash",
      1234
    );
    expect(log.info).toHaveBeenCalledWith("Generated WS token", {
      participant_id: "participant-1",
      user_id: "user-1",
    });
  });

  it("does not overwrite newer existing tokens with stale client values", async () => {
    const { handler, repository, getParticipantByUserId } = createHandler();
    const participant = createParticipant({
      scm_token_expires_at: 5000,
      scm_refresh_token_encrypted: "server-refresh",
    });
    getParticipantByUserId.mockReturnValue(participant);

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmTokenEncrypted: "stale-access",
          scmRefreshTokenEncrypted: "stale-refresh",
          scmTokenExpiresAt: 4000,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.updateParticipantCoalesce).toHaveBeenCalledWith("participant-1", {
      scmUserId: null,
      scmLogin: null,
      scmName: null,
      authName: null,
      scmEmail: null,
      scmAccessTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: null,
    });
  });

  it("creates a new participant when one does not exist", async () => {
    const { handler, repository, getParticipantByUserId, generateId } = createHandler();
    const createdParticipant = createParticipant({ id: "participant-new" });
    getParticipantByUserId.mockReturnValueOnce(null).mockReturnValueOnce(createdParticipant);
    generateId.mockReturnValueOnce("participant-new").mockReturnValueOnce("plain-token");

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmUserId: "scm-user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
          scmEmail: "octocat@example.com",
          scmTokenEncrypted: "enc-access",
          scmRefreshTokenEncrypted: "enc-refresh",
          scmTokenExpiresAt: 2000,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: "plain-token",
      participantId: "participant-new",
    });
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-new",
      userId: "user-1",
      scmUserId: "scm-user-1",
      scmLogin: "octocat",
      scmName: "The Octocat",
      authName: null,
      scmEmail: "octocat@example.com",
      scmAccessTokenEncrypted: "enc-access",
      scmRefreshTokenEncrypted: "enc-refresh",
      scmTokenExpiresAt: 2000,
      role: "member",
      joinedAt: 1234,
    });
    expect(repository.updateParticipantWsToken).toHaveBeenCalledWith(
      "participant-new",
      "token-hash",
      1234
    );
    expect(getParticipantByUserId).toHaveBeenCalledTimes(2);
  });

  it("accepts nullable optional token fields", async () => {
    const { handler, repository, getParticipantByUserId } = createHandler();
    const createdParticipant = createParticipant({ id: "participant-new" });
    getParticipantByUserId.mockReturnValueOnce(null).mockReturnValueOnce(createdParticipant);

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          scmUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "user-1",
      scmUserId: null,
      scmLogin: null,
      scmName: null,
      authName: null,
      scmEmail: null,
      scmAccessTokenEncrypted: null,
      scmRefreshTokenEncrypted: null,
      scmTokenExpiresAt: null,
      role: "member",
      joinedAt: 1234,
    });
  });

  it("persists a provider-agnostic authName for presence (e.g. Google users)", async () => {
    const { handler, repository, getParticipantByUserId } = createHandler();
    const createdParticipant = createParticipant({ id: "participant-new", scm_name: null });
    getParticipantByUserId.mockReturnValueOnce(null).mockReturnValueOnce(createdParticipant);

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Google auth: no SCM fields, but a display name is supplied.
        body: JSON.stringify({ userId: "google-sub-123", authName: "Ada Lovelace" }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "google-sub-123",
        scmName: null,
        authName: "Ada Lovelace",
      })
    );
  });

  it("persists authName on the update path for an existing participant", async () => {
    const { handler, repository, getParticipantByUserId } = createHandler();
    // Existing participant → update path (createParticipant is not called).
    getParticipantByUserId.mockReturnValue(createParticipant({ scm_name: null }));

    const response = await handler.generateWsToken(
      new Request("http://internal/internal/ws-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "google-sub-123", authName: "Ada Lovelace" }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(repository.updateParticipantCoalesce).toHaveBeenCalledWith(
      "participant-1",
      expect.objectContaining({ authName: "Ada Lovelace" })
    );
  });
});
