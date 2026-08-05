import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes the caller's event name in structured output", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createLogger("router:automations").info("Automation created", {
      event: "automation.created",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "automation.created",
    });
  });

  it("protects logger-owned fields from context and per-call data", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const spoofedFields = {
      level: "spoofed",
      service: "spoofed",
      component: "spoofed",
      msg: "spoofed",
      ts: "spoofed",
    };
    const logger = createLogger("router", spoofedFields, "info", "control-plane");

    logger.info("Request received", spoofedFields);

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      level: "info",
      service: "control-plane",
      component: "router",
      msg: "Request received",
      ts: expect.any(Number),
    });
  });

  it("lets per-call data override matching context fields", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const logger = createLogger("router", {
      event: "request.started",
      requestId: "context-request",
    });

    logger.info("Request completed", {
      event: "request.completed",
      requestId: "call-request",
    });

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "request.completed",
      requestId: "call-request",
    });
  });

  it("lets child context override parent context while inheriting other fields", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const parent = createLogger("session-do", {
      event: "session.started",
      requestId: "parent-request",
      sessionId: "session-123",
    });
    const child = parent.child({
      event: "prompt.started",
      requestId: "child-request",
    });

    child.info("Prompt started");

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      event: "prompt.started",
      requestId: "child-request",
      sessionId: "session-123",
    });
  });
});
