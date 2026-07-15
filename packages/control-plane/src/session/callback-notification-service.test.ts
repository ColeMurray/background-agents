import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "../logger";
import {
  CallbackNotificationService,
  type CallbackRepository,
  type CallbackServiceEnv,
  type CallbackServiceDeps,
} from "./callback-notification-service";

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

type MockFetcher = Fetcher & { fetch: ReturnType<typeof vi.fn> };

function createMockFetcher(): MockFetcher {
  return { fetch: vi.fn() } as unknown as MockFetcher;
}

function createTestHarness(overrides?: { env?: Partial<CallbackServiceEnv> }) {
  const log = createMockLogger();
  const repository = createMockRepository();

  const slackBot = createMockFetcher();
  const linearBot = createMockFetcher();
  const sleep = vi.fn(async () => {});

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
    sleep,
  };

  return {
    service: new CallbackNotificationService(deps),
    repository,
    log,
    env,
    slackBot,
    linearBot,
    sleep,
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

      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "rejected",
          reject_reason: "no_callback_context",
          duration_ms: expect.any(Number),
        })
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
        callback_context: JSON.stringify({ channel: "C123" }),
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
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "slack",
          outcome: "rejected",
          reject_reason: "no_binding",
          duration_ms: expect.any(Number),
        })
      );
    });

    it("calls binding with signed payload on success", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123", threadTs: "1234.5678" }),
        source: "slack",
        trace_id: "trace-1",
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
          headers: { "Content-Type": "application/json", "x-trace-id": "trace-1" },
        })
      );

      // Verify payload shape
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        success: true,
        context: { channel: "C123", threadTs: "1234.5678" },
      });
      expect(body.signature).toEqual(expect.any(String));
      expect(body.timestamp).toEqual(expect.any(Number));

      const terminalEvents = vi
        .mocked(harness.log.info)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "slack",
          outcome: "success",
          duration_ms: expect.any(Number),
          attempts: 1,
          retries: 0,
          http_status: 200,
        })
      );
    });

    it("retries once on fetch failure", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
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
        "callback.complete_delivery",
        expect.objectContaining({ message_id: "msg-1", attempts: 2, retries: 1 })
      );
    });

    it("emits one terminal event after retries are exhausted", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });
      harness.slackBot.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

      await harness.service.notifyComplete("msg-1", false);

      const terminalEvents = vi
        .mocked(harness.log.error)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "error",
          duration_ms: expect.any(Number),
          attempts: 2,
          retries: 1,
          http_status: 503,
        })
      );
    });

    it("does not report a stale HTTP status when the final attempt throws", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });
      harness.slackBot.fetch
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockRejectedValueOnce(new Error("network error"));

      await harness.service.notifyComplete("msg-1", false);

      const terminalEvent = vi
        .mocked(harness.log.error)
        .mock.calls.find(([event]) => event === "callback.complete_delivery");
      expect(terminalEvent?.[1]).toEqual(
        expect.objectContaining({ outcome: "error", attempts: 2, retries: 1 })
      );
      expect(terminalEvent?.[1]).not.toHaveProperty("http_status");
    });

    it("routes to LINEAR_BOT for linear source", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ issueId: "LIN-123" }),
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
  });

  describe("notifyStarted", () => {
    it("sends an authenticated start callback for a Linear message", async () => {
      const context = {
        source: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
        model: "anthropic/claude-haiku-4-5",
        organizationId: "org-1",
        appUserId: "app-user-1",
        transitionIssueOnStart: true,
      };
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(context),
        source: "linear",
        trace_id: "trace-start-1",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/start",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json", "x-trace-id": "trace-start-1" },
        })
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        messageId: "msg-1",
        context,
        timestamp: expect.any(Number),
        signature: expect.any(String),
      });
      expect(body).not.toHaveProperty("success");
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("retries a failed start callback once", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: true,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock
        .mockResolvedValueOnce(new Response("retry", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.sleep).toHaveBeenCalledWith(1000);
      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.started_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "success",
          attempts: 2,
          retries: 1,
          http_status: 200,
          duration_ms: expect.any(Number),
        })
      );
    });

    it("retries when failure logging throws", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ source: "linear", issueId: "issue-1" }),
        source: "linear",
      });
      harness.linearBot.fetch
        .mockResolvedValueOnce(new Response("retry", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.mocked(harness.log.warn).mockImplementationOnce(() => {
        throw new Error("log sink unavailable");
      });

      await harness.service.notifyStarted("msg-1");

      expect(harness.linearBot.fetch).toHaveBeenCalledTimes(2);
    });

    it("contains start callback failure after the bounded retry", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: true,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockRejectedValue(new Error("network unavailable"));

      await expect(harness.service.notifyStarted("msg-1")).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(harness.log.error).toHaveBeenCalledWith(
        "callback.started_delivery",
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          outcome: "error",
          attempts: 2,
          retries: 1,
          duration_ms: expect.any(Number),
        })
      );
    });

    it("forwards opaque Linear context without interpreting transition policy", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "linear",
          issueId: "issue-1",
          transitionIssueOnStart: false,
        }),
        source: "linear",
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(body.context).toEqual({
        source: "linear",
        issueId: "issue-1",
        transitionIssueOnStart: false,
      });
    });

    it.each(["{not-json", "null"])(
      "ignores invalid stored callback context: %s",
      async (context) => {
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: context,
          source: "linear",
        });

        await expect(harness.service.notifyStarted("msg-1")).resolves.toBeUndefined();
        expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      }
    );
  });

  describe("notifyToolCall", () => {
    it("skips when throttled (< 3s since last call)", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
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
        callback_context: JSON.stringify({ channel: "C123" }),
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
        callId: "call-1",
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
        context: { channel: "C123" },
      });
      expect(body.signature).toEqual(expect.any(String));
    });

    it("skips automation source — the SchedulerDO has no tool-call consumer", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ automationId: "a1", runId: "r1" }),
        source: "automation",
      });

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "glob",
        callId: "call-1",
      });

      // No forward at all — previously this 404'd against the SchedulerDO.
      const slackFetch = (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(slackFetch).not.toHaveBeenCalled();
      expect(harness.log.debug).toHaveBeenCalledWith(
        "callback.tool_call",
        expect.objectContaining({
          source: "automation",
          outcome: "skipped",
          skip_reason: "automation_no_consumer",
        })
      );
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
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = (h.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("dedup by callId", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it("fires once per callId even when events arrive past the throttle window", async () => {
        // Anthropic emits running+completed for the same tool. OpenAI's
        // Responses API may report only completed. Either way, one activity.
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(
          (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
        );
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Advance well past the 3s throttle so the second call is throttle-eligible
        vi.setSystemTime(start + 5_000);

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-abc",
          status: "completed",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("fires once per distinct callId across many tool calls", async () => {
        vi.useFakeTimers();
        let now = 1_700_000_000_000;
        vi.setSystemTime(now);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(
          (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
        );
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        for (let i = 0; i < 3; i++) {
          // Each tool emits running then completed; only running should fire
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "running",
          });
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "completed",
          });
          now += 3_001;
          vi.setSystemTime(now);
        }

        expect(fetchMock).toHaveBeenCalledTimes(3);
      });

      it("evicts the oldest callId (FIFO) once the cap is exceeded", async () => {
        vi.useFakeTimers();
        let now = 1_700_000_000_000;
        vi.setSystemTime(now);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(
          (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
        );
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        // Cap is 500. Fire 501 distinct callIds; the first one ("call-0")
        // should be evicted when "call-500" is admitted.
        for (let i = 0; i <= 500; i++) {
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            callId: `call-${i}`,
            status: "running",
          });
          now += 3_001;
          vi.setSystemTime(now);
        }
        expect(fetchMock).toHaveBeenCalledTimes(501);

        // call-0 was evicted, so a re-fire is treated as a fresh tool call
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-0",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(502);

        // call-1 is still in the set (it became the new oldest), so it dedupes
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-1",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(502);
      });

      it("falls back to throttle-only behavior when callId is missing", async () => {
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(
          (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
        );
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // No callId on either event — second event past throttle should fire
        vi.setSystemTime(start + 5_000);
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("retries on a later event when the first delivery for a callId fails", async () => {
        // markCallIdNotified runs only on response.ok, so a transient failure
        // (e.g. network error or non-2xx) on Anthropic's "running" event must
        // not prevent the subsequent "completed" event from re-delivering.
        vi.useFakeTimers();
        const start = 1_700_000_000_000;
        vi.setSystemTime(start);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(
          (harness.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
        );
        fetchMock
          .mockRejectedValueOnce(new Error("network"))
          .mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "running",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Advance past the throttle window so the retry is eligible.
        vi.setSystemTime(start + 5_000);

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "completed",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Third event for the same callId after a successful delivery should dedupe.
        vi.setSystemTime(start + 10_000);
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          callId: "call-retry",
          status: "completed",
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("notifyComplete — automation callback", () => {
    it("routes automation callbacks to SCHEDULER_CALLBACK binding", async () => {
      const schedulerFetcher = createMockFetcher();
      const h = createTestHarness({
        env: { SCHEDULER_CALLBACK: schedulerFetcher },
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      const fetchMock = vi.mocked(
        (schedulerFetcher as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await h.service.notifyComplete("msg-1", true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/internal/run-complete",
        expect.objectContaining({ method: "POST" })
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        automationId: "auto-1",
        runId: "run-1",
        sessionId: "session-123",
        success: true,
        automationName: "Daily sync",
      });
      // Automation callbacks do NOT include HMAC signature (unlike bot callbacks)
      expect(body.signature).toBeUndefined();
    });

    it("sends failure details for failed automation runs", async () => {
      const schedulerFetcher = createMockFetcher();
      const h = createTestHarness({
        env: { SCHEDULER_CALLBACK: schedulerFetcher },
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      const fetchMock = vi.mocked(
        (schedulerFetcher as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await h.service.notifyComplete("msg-1", false, "Sandbox crashed");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        success: false,
        error: "Sandbox crashed",
      });
    });

    it("skips when no SCHEDULER_CALLBACK binding", async () => {
      const h = createTestHarness({
        env: { SCHEDULER_CALLBACK: undefined },
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      const terminalEvents = vi
        .mocked(h.log.info)
        .mock.calls.filter(([event]) => event === "callback.complete_delivery");
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0][1]).toEqual(
        expect.objectContaining({
          session_id: "session-123",
          message_id: "msg-1",
          source: "automation",
          outcome: "rejected",
          reject_reason: "no_binding",
          duration_ms: expect.any(Number),
          attempts: 0,
          retries: 0,
        })
      );
    });

    it("retries once on automation callback failure", async () => {
      const schedulerFetcher = createMockFetcher();
      const h = createTestHarness({
        env: { SCHEDULER_CALLBACK: schedulerFetcher },
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      const fetchMock = vi.mocked(
        (schedulerFetcher as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      await h.service.notifyComplete("msg-1", true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({ source: "automation", attempts: 2, retries: 1 })
      );
    });

    it("does not route automation callbacks to SLACK_BOT", async () => {
      const schedulerFetcher = createMockFetcher();
      const h = createTestHarness({
        env: { SCHEDULER_CALLBACK: schedulerFetcher },
      });

      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          runId: "run-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      const fetchMock = vi.mocked(
        (schedulerFetcher as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch
      );
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await h.service.notifyComplete("msg-1", true);

      const slackFetch = (h.slackBot as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch;
      expect(slackFetch).not.toHaveBeenCalled();
    });
  });
});
