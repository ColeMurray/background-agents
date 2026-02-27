import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import {
  CallbackNotificationService,
  type CallbackRepository,
  type CallbackServiceEnv,
  type CallbackServiceDeps,
} from "./callback-notification-service";

const SLACK_CONTEXT = {
  source: "slack" as const,
  channel: "C123",
  threadTs: "1234.5678",
  repoFullName: "open-inspect/repo",
  model: "openai/gpt-5",
};

const LINEAR_CONTEXT = {
  source: "linear" as const,
  issueId: "LIN-123",
  issueIdentifier: "LIN-123",
  issueUrl: "https://linear.app/team/issue/LIN-123",
  repoFullName: "open-inspect/repo",
  model: "openai/gpt-5",
};

// ---- Mock factories ----

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createMockRepository(): CallbackRepository {
  return {
    getMessageCallbackContext: vi.fn(() => null),
    getSession: vi.fn(() => null),
  };
}

function createMockFetcher(): Fetcher {
  return { fetch: vi.fn() } as unknown as Fetcher;
}

function createTestHarness(overrides?: { env?: Partial<CallbackServiceEnv> }) {
  const log = createMockLogger();
  const repository = createMockRepository();

  const slackBot = createMockFetcher();
  const linearBot = createMockFetcher();

  const env: CallbackServiceEnv = {
    INTERNAL_CALLBACK_SECRET: "test-secret",
    SLACK_BOT: slackBot,
    LINEAR_BOT: linearBot,
    ...overrides?.env,
  };

  const deps: CallbackServiceDeps = {
    repository,
    env,
    log,
    getSessionId: () => "session-123",
  };

  return {
    service: new CallbackNotificationService(deps),
    repository,
    log,
    env,
    slackBot,
    linearBot,
  };
}

// ---- Tests ----

describe("CallbackNotificationService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  describe("notifyComplete", () => {
    it("skips when no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue(null);

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.log.debug).toHaveBeenCalledWith(
        "No callback context for message, skipping notification",
        expect.objectContaining({ message_id: "msg-1" })
      );
      expect(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).not.toHaveBeenCalled();
    });

    it("skips when callback_context is null on the message", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: null,
        source: "slack",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).not.toHaveBeenCalled();
    });

    it("skips when no INTERNAL_CALLBACK_SECRET", async () => {
      const h = createTestHarness({ env: { INTERNAL_CALLBACK_SECRET: undefined } });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(
        (h.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).not.toHaveBeenCalled();
    });

    it("skips when no binding for source", async () => {
      const h = createTestHarness({
        env: { SLACK_BOT: undefined, LINEAR_BOT: undefined },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(h.log.debug).toHaveBeenCalledWith(
        "No callback binding for source, skipping notification",
        expect.objectContaining({ message_id: "msg-1", source: "slack" })
      );
    });

    it("calls binding with signed payload on success", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      const mockResponse = new Response("ok", { status: 200 });
      vi.mocked(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).mockResolvedValue(mockResponse);

      await harness.service.notifyComplete("msg-1", true);

      const fetchMock = (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/complete",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );

      // Verify payload shape
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        success: true,
        context: SLACK_CONTEXT,
      });
      expect(body.signature).toEqual(expect.any(String));
      expect(body.timestamp).toEqual(expect.any(Number));

      expect(harness.log.info).toHaveBeenCalledWith(
        "Callback succeeded",
        expect.objectContaining({ message_id: "msg-1", source: "slack" })
      );
    });

    it("retries once on fetch failure", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      const fetchMock = vi.mocked(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await harness.service.notifyComplete("msg-1", true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.log.info).toHaveBeenCalledWith(
        "Callback succeeded",
        expect.objectContaining({ message_id: "msg-1" })
      );
    });

    it("routes to LINEAR_BOT for linear source", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CONTEXT),
        source: "linear",
      });

      const mockResponse = new Response("ok", { status: 200 });
      vi.mocked(
        (harness.linearBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).mockResolvedValue(mockResponse);

      await harness.service.notifyComplete("msg-1", false);

      const linearFetch = (harness.linearBot as unknown as { fetch: ReturnType<typeof vi.fn> })
        .fetch;
      expect(linearFetch).toHaveBeenCalledTimes(1);

      const slackFetch = (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(slackFetch).not.toHaveBeenCalled();
    });

    it("skips when callback_context JSON is invalid", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: "{not-json}",
        source: "slack",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.log.warn).toHaveBeenCalledWith(
        "Invalid callback context JSON, skipping notification",
        expect.objectContaining({ message_id: "msg-1", source: "slack" })
      );
      expect(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).not.toHaveBeenCalled();
    });

    it("skips when callback_context schema is invalid", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ source: "slack", channel: "C123" }),
        source: "slack",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.log.warn).toHaveBeenCalledWith(
        "Invalid callback context schema, skipping notification",
        expect.objectContaining({ message_id: "msg-1", source: "slack" })
      );
      expect(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      ).not.toHaveBeenCalled();
    });
  });

  describe("notifyToolCall", () => {
    it("skips when throttled (< 3s since last call)", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      const fetchMock = vi.mocked(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      // First call should go through
      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second call within 3s should be throttled
      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
      expect(fetchMock).toHaveBeenCalledTimes(1); // still 1
    });

    it("fires callback on first call", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      const fetchMock = vi.mocked(
        (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "bash",
        args: { cmd: "ls" },
        call_id: "call-1",
        status: "running",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/tool_call",
        expect.objectContaining({ method: "POST" })
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        sessionId: "session-123",
        tool: "bash",
        args: { cmd: "ls" },
        callId: "call-1",
        status: "running",
        context: SLACK_CONTEXT,
      });
      expect(body.signature).toEqual(expect.any(String));
    });

    it("skips when no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue(null);

      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when no secret configured", async () => {
      const h = createTestHarness({ env: { INTERNAL_CALLBACK_SECRET: undefined } });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      await h.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = (h.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
