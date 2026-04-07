import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { SandboxRow, SessionRow } from "../../types";
import { createSandboxHandler } from "./sandbox.handler";

function createHandler() {
  const repository = {
    createParticipant: vi.fn(),
  };
  const processSandboxEvent = vi.fn();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const isValidSandboxToken = vi.fn();
  const getSession = vi.fn<() => SessionRow | null>();
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
});
