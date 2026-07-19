import { afterEach, describe, expect, it, vi } from "vitest";

import { createForwardingLogger, createLogger } from "./logger";
import type { Logger } from "./logger";

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

describe("createForwardingLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards every level to whatever the source returns at call time", () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let current: Logger = createLogger("session-do", { source: "first" }, "debug");
    const forwarding = createForwardingLogger(() => current);

    forwarding.debug("debug line");
    forwarding.info("info line");
    forwarding.warn("warn line");
    forwarding.error("error line");
    current = createLogger("session-do", { source: "second" }, "debug");
    forwarding.info("after swap");

    expect(JSON.parse(consoleLogSpy.mock.calls[0][0] as string)).toMatchObject({
      level: "debug",
      source: "first",
    });
    expect(JSON.parse(consoleWarnSpy.mock.calls[0][0] as string)).toMatchObject({
      level: "warn",
      source: "first",
    });
    expect(JSON.parse(consoleErrorSpy.mock.calls[0][0] as string)).toMatchObject({
      level: "error",
      source: "first",
    });
    expect(JSON.parse(consoleLogSpy.mock.calls[2][0] as string)).toMatchObject({
      msg: "after swap",
      source: "second",
    });
  });

  it("does not pin a request-scoped child captured at construction time", () => {
    // Regression scenario: a Durable Object swaps its logger to a
    // request-scoped child during fetch() and restores it afterwards. A
    // lazily-constructed service that received the logger while the child
    // was installed must log with the restored logger, not the first
    // request's child.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sessionLogger = createLogger("session-do", { session_id: "session-123" });
    let log = sessionLogger;
    const service = { log: createForwardingLogger(() => log) };

    log = sessionLogger.child({ trace_id: "trace-first-request" });
    service.log.info("constructed during first request");
    log = sessionLogger;
    service.log.info("logged after request completed");

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      trace_id: "trace-first-request",
    });
    const restored = JSON.parse(consoleSpy.mock.calls[1][0] as string);
    expect(restored).toMatchObject({ session_id: "session-123" });
    expect(restored).not.toHaveProperty("trace_id");
  });

  it("derives child loggers from the current source", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let current = createLogger("session-do", { source: "first" });
    const forwarding = createForwardingLogger(() => current);
    current = createLogger("session-do", { source: "second" });

    forwarding.child({ child_ctx: "yes" }).info("from child");

    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      source: "second",
      child_ctx: "yes",
    });
  });
});
