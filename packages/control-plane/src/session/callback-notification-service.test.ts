import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import type { Logger } from "../logger";
import type { MessageRepository } from "./message-repository";
import {
  CallbackNotificationService,
  type CallbackServiceDeps,
} from "./callback-notification-service";

const LINEAR_CONTEXT = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

function createHarness(overrides: Partial<CallbackServiceDeps> = {}) {
  const repository = {
    getSession: vi.fn(() => null),
    getMessageCallbackContext: vi.fn<MessageRepository["getMessageCallbackContext"]>(() => null),
  };
  const send = vi.fn<(job: SessionCallbackJob) => Promise<unknown>>(async () => undefined);
  const log = createLogger();
  const service = new CallbackNotificationService({
    messageRepository: repository as unknown as MessageRepository,
    jobs: { send },
    log,
    getSessionId: () => "session-123",
    sleep: async () => {},
    ...overrides,
  });
  return { service, repository, send, log };
}

describe("CallbackNotificationService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues unsigned completion data without bot dependencies", async () => {
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "slack",
      callback_context: JSON.stringify({ channel: "C123", threadTs: "123.45" }),
    });

    await harness.service.notifyComplete("message-1", false, "sandbox failed");

    expect(harness.send).toHaveBeenCalledWith({
      version: 1,
      type: "session.completed",
      payload: {
        sessionId: "session-123",
        messageId: "message-1",
        source: "slack",
        success: false,
        error: "sandbox failed",
        timestamp: expect.any(Number),
        context: { channel: "C123", threadTs: "123.45" },
      },
    });
    expect(harness.send.mock.calls[0][0]).not.toHaveProperty("signature");
  });

  it("enqueues Linear start only after finding an object callback context", async () => {
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "linear",
      callback_context: JSON.stringify(LINEAR_CONTEXT),
    });

    await harness.service.notifyStarted("message-1");

    expect(harness.send).toHaveBeenCalledWith({
      version: 1,
      type: "session.started",
      payload: {
        sessionId: "session-123",
        messageId: "message-1",
        timestamp: expect.any(Number),
        context: LINEAR_CONTEXT,
      },
    });
  });

  it.each([null, { source: "slack", callback_context: "{}" }])(
    "does not enqueue a start callback for an ineligible message",
    async (message) => {
      harness.repository.getMessageCallbackContext.mockReturnValue(message);
      await harness.service.notifyStarted("message-1");
      expect(harness.send).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed Linear completion data before enqueue", async () => {
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "linear",
      callback_context: JSON.stringify({ source: "linear", issueId: "issue-1" }),
    });

    await harness.service.notifyComplete("message-1", true);

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.log.info).toHaveBeenCalledWith(
      "callback.complete_enqueue",
      expect.objectContaining({ reject_reason: "invalid_payload" })
    );
  });

  it("routes automation completion in process instead of creating a bot job", async () => {
    const completeAutomationRun = vi.fn(async () => new Response("ok"));
    harness = createHarness({ completeAutomationRun });
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "automation",
      callback_context: JSON.stringify({
        source: "automation",
        automationId: "automation-1",
        runId: "run-1",
        automationName: "Nightly",
      }),
    });

    await harness.service.notifyComplete("message-1", true);

    expect(completeAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "automation-1",
        runId: "run-1",
        sessionId: "session-123",
      })
    );
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("enqueues each eligible tool call once and throttles subsequent calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "linear",
      callback_context: JSON.stringify(LINEAR_CONTEXT),
    });

    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      args: { command: "ls" },
      callId: "call-1",
      status: "running",
    });
    vi.setSystemTime(1_700_000_001_000);
    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      args: { command: "ls" },
      callId: "call-2",
      status: "completed",
    });

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith({
      version: 1,
      type: "tool_call",
      payload: expect.objectContaining({
        sessionId: "session-123",
        messageId: "message-1",
        source: "linear",
        tool: "bash",
        callId: "call-1",
      }),
    });
  });

  it("deduplicates a tool call after the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "slack",
      callback_context: JSON.stringify({ channel: "C123" }),
    });

    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      callId: "call-1",
    });
    vi.setSystemTime(1_700_000_005_000);
    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      callId: "call-1",
    });

    expect(harness.send).toHaveBeenCalledOnce();
  });

  it("allows a later tool event to enqueue when Queue publication failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    harness.repository.getMessageCallbackContext.mockReturnValue({
      source: "slack",
      callback_context: JSON.stringify({ channel: "C123" }),
    });
    harness.send.mockRejectedValueOnce(new Error("queue unavailable"));

    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      callId: "call-1",
    });
    await harness.service.notifyToolCall("message-1", {
      type: "tool_call",
      tool: "bash",
      callId: "call-1",
    });

    expect(harness.send).toHaveBeenCalledTimes(2);
  });
});
