import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "../logger";
import {
  CallbackNotificationService,
  SLACK_ACTIVITY_REFRESH_INTERVAL_MS,
  type CallbackRepository,
  type CallbackServiceEnv,
  type CallbackServiceDeps,
} from "./callback-notification-service";
import type { MessageRepository } from "./message-repository";
import type { FetchClient } from "../platform-ports";
import type { SlackPostScope } from "../authorization/slack-post-gate";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import {
  linearCompletionCallbackSchema,
  linearToolCallCallbackSchema,
  slackCallbackContextSchema,
  SLACK_ACTIVITY_REFRESH_KIND,
} from "@open-inspect/shared/types/session-api";

const LINEAR_CALLBACK_CONTEXT = {
  source: "linear",
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};

const SLACK_CALLBACK_CONTEXT = {
  channel: "C123",
  threadTs: "1234.5678",
  repoFullName: "secret/repository",
  model: "private-model",
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

function createMockRepository() {
  return {
    getMessageCallbackContext: vi.fn<MessageRepository["getMessageCallbackContext"]>(() => null),
    getProcessingMessageWithStartedAt: vi.fn<
      MessageRepository["getProcessingMessageWithStartedAt"]
    >(() => null),
    getSession: vi.fn(() => null),
  };
}

function createMockFetcher() {
  return { fetch: vi.fn<FetchClient["fetch"]>() };
}

function createTestHarness(overrides?: {
  env?: Partial<CallbackServiceEnv>;
  getSessionId?: () => string;
  completeAutomationRun?: CallbackServiceDeps["completeAutomationRun"];
}) {
  const log = createMockLogger();
  const repository = createMockRepository();

  const slackBot = createMockFetcher();
  const linearBot = createMockFetcher();
  const sleep = vi.fn(async () => {});
  const slackPostScope = {
    getSession: vi.fn<SlackPostScope["getSession"]>().mockResolvedValue({
      ownerTeamId: "team-a",
      visibility: "workspace",
    }),
    getChannelBinding: vi.fn<SlackPostScope["getChannelBinding"]>().mockResolvedValue(null),
  };

  const env: CallbackServiceEnv = {
    SERVICE_AUTH_SECRET_SLACK_BOT: "test-secret",
    SERVICE_AUTH_SECRET_LINEAR_BOT: "test-secret",
    SLACK_BOT: slackBot,
    LINEAR_BOT: linearBot,
    ...overrides?.env,
  };

  const deps: CallbackServiceDeps = {
    repository: repository as CallbackRepository,
    messageRepository: repository as unknown as MessageRepository,
    slackPostScope,
    env,
    log,
    getSessionId: overrides?.getSessionId ?? (() => "session-123"),
    completeAutomationRun: overrides?.completeAutomationRun,
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
    slackPostScope,
  };
}

// ---- Tests ----

describe("CallbackNotificationService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  describe.each(["complete", "tool_call", "activity"] as const)("Slack post gate: %s", (path) => {
    it.each(["getSession", "getChannelBinding"] as const)(
      "fails closed when %s fails",
      async (lookup) => {
        harness.repository.getMessageCallbackContext.mockReturnValue({
          callback_context: JSON.stringify(SLACK_CALLBACK_CONTEXT),
          source: "slack",
        });
        harness.repository.getProcessingMessageWithStartedAt.mockReturnValue({
          id: "msg-1",
          started_at: 1,
        });
        harness.slackBot.fetch.mockResolvedValue(new Response("ok"));
        harness.slackPostScope[lookup].mockRejectedValue(new Error("D1 unavailable"));
        if (path === "complete") {
          await harness.service.notifyComplete("msg-1", false, "secret error");
        } else if (path === "tool_call") {
          await harness.service.notifyToolCall("msg-1", {
            type: "tool_call",
            tool: "bash",
            args: { command: "secret command" },
            callId: "call-1",
          });
        } else {
          await harness.service.refreshSlackActivity("msg-1", Date.now());
        }
        expect(harness.repository.getSession).not.toHaveBeenCalled();
        expect(harness.slackPostScope.getSession).toHaveBeenCalledWith("session-123");
        expect(harness.slackPostScope.getChannelBinding).toHaveBeenCalledWith("C123");
        expect(harness.slackBot.fetch).not.toHaveBeenCalled();
        expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      }
    );
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
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("skips when callback_context is null on the message", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: null,
        source: "slack",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("absorbs and logs unexpected callback failures", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: "{",
        source: "slack",
      });

      await expect(harness.service.notifyComplete("msg-1", true)).resolves.toBeUndefined();

      expect(harness.log.error).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          message_id: "msg-1",
          outcome: "error",
          error: expect.any(SyntaxError),
        })
      );
    });

    it("absorbs session identity lookup failures", async () => {
      const sessionError = new Error("session unavailable");
      const h = createTestHarness({
        getSessionId: () => {
          throw sessionError;
        },
      });

      await expect(h.service.notifyComplete("msg-1", true)).resolves.toBeUndefined();

      expect(h.log.error).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          session_id: null,
          message_id: "msg-1",
          outcome: "error",
          error: sessionError,
        })
      );
    });

    it("skips when the destination bot's signing secret is unbound", async () => {
      const h = createTestHarness({
        env: {
          SERVICE_AUTH_SECRET_SLACK_BOT: undefined,
          SERVICE_AUTH_SECRET_LINEAR_BOT: undefined,
        },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(h.slackBot.fetch).not.toHaveBeenCalled();
      expect(h.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(h.sleep).not.toHaveBeenCalled();
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
      expect(h.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(h.sleep).not.toHaveBeenCalled();
    });

    it.each([null, { teamId: "team-a" }])(
      "calls binding with signed payload on success: %j",
      async (binding) => {
        harness.slackPostScope.getChannelBinding.mockResolvedValue(binding);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123", threadTs: "1234.5678" }),
          source: "slack",
        });

        const mockResponse = new Response("ok", { status: 200 });
        vi.mocked(harness.slackBot.fetch).mockResolvedValue(mockResponse);

        await harness.service.notifyComplete("msg-1", true);

        const fetchMock = harness.slackBot.fetch;
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://internal/callbacks/complete",
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
          })
        );

        // Verify payload shape
        const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
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
      }
    );

    it.each(["fetch", "getSession", "getChannelBinding"] as const)(
      "retries once on %s failure",
      async (failure) => {
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify(SLACK_CALLBACK_CONTEXT),
          source: "slack",
        });

        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok"));
        (failure === "fetch" ? fetchMock : harness.slackPostScope[failure]).mockRejectedValueOnce(
          new Error("delivery unavailable")
        );

        await harness.service.notifyComplete("msg-1", true);

        expect(fetchMock).toHaveBeenCalledTimes(failure === "fetch" ? 2 : 1);
        expect(fetchMock).toHaveBeenLastCalledWith(
          "https://internal/callbacks/complete",
          expect.anything()
        );
        const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
        expect(body).toMatchObject({
          messageId: "msg-1",
          success: true,
          context: SLACK_CALLBACK_CONTEXT,
        });
        expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
        expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
        expect(harness.slackPostScope.getChannelBinding).toHaveBeenCalledTimes(2);
        expect(harness.sleep).toHaveBeenCalledExactlyOnceWith(1000);
        expect(harness.log.info).toHaveBeenCalledWith(
          "callback.complete_delivery",
          expect.objectContaining({
            session_id: "session-123",
            message_id: "msg-1",
            outcome: "success",
            attempts: 2,
            retries: 1,
          })
        );
      }
    );

    describe("Slack publication preparation retries", () => {
      beforeEach(() => {
        harness.repository.getMessageCallbackContext.mockReturnValue({
          callback_context: JSON.stringify(SLACK_CALLBACK_CONTEXT),
          source: "slack",
        });
        harness.slackBot.fetch.mockResolvedValue(new Response("ok"));
      });

      it.each([
        { visibility: "private", binding: null, reason: "private_session" },
        {
          visibility: "workspace",
          binding: { teamId: "team-b" },
          reason: "channel_team_mismatch",
        },
      ] as const)(
        "selects only closure on recovered $reason without nested transport retries",
        async ({ visibility, binding, reason }) => {
          harness.slackPostScope.getSession
            .mockRejectedValueOnce(new Error("D1 unavailable"))
            .mockResolvedValue({ ownerTeamId: "team-a", visibility });
          harness.slackPostScope.getChannelBinding.mockResolvedValue(binding);
          harness.slackBot.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));

          await harness.service.notifyComplete("msg-1", false, "secret error");

          expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
          expect(harness.sleep).toHaveBeenCalledExactlyOnceWith(1000);
          expect(harness.slackBot.fetch).toHaveBeenCalledOnce();
          expect(harness.slackBot.fetch.mock.calls[0][0]).toBe(
            "https://internal/callbacks/thread_closed"
          );
          const body = JSON.parse(String(harness.slackBot.fetch.mock.calls[0][1]?.body));
          expect(body).toEqual({
            kind: "slack.thread_closed",
            sessionId: "session-123",
            timestamp: expect.any(Number),
            context: { channel: "C123", threadTs: "1234.5678" },
            signature: expect.any(String),
          });
          expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
          expect(harness.log.info).toHaveBeenCalledWith(
            "callback.complete_delivery",
            expect.objectContaining({
              outcome: "rejected",
              reject_reason: reason,
              attempts: 2,
              retries: 1,
              http_status: 503,
            })
          );
        }
      );

      it("rechecks scope after transport failure and replaces completion with closure", async () => {
        harness.slackPostScope.getChannelBinding
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ teamId: "team-b" });
        harness.slackBot.fetch
          .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
          .mockResolvedValueOnce(new Response("ok"));

        await harness.service.notifyComplete("msg-1", false, "secret error");

        expect(harness.slackBot.fetch.mock.calls.map(([url]) => url)).toEqual([
          "https://internal/callbacks/complete",
          "https://internal/callbacks/thread_closed",
        ]);
        expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
        const closure = JSON.parse(String(harness.slackBot.fetch.mock.calls[1][1]?.body));
        expect(closure.context).toEqual({ channel: "C123", threadTs: "1234.5678" });
        expect(closure).not.toHaveProperty("error");
        expect(closure).not.toHaveProperty("messageId");
      });

      it("does not retain a denied outcome when the retry's current scope allows completion", async () => {
        harness.slackPostScope.getSession
          .mockResolvedValueOnce({ ownerTeamId: "team-a", visibility: "private" })
          .mockResolvedValue({ ownerTeamId: "team-a", visibility: "workspace" });
        harness.slackBot.fetch
          .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
          .mockResolvedValueOnce(new Response("ok"));

        await harness.service.notifyComplete("msg-1", true);

        expect(harness.slackBot.fetch.mock.calls.map(([url]) => url)).toEqual([
          "https://internal/callbacks/thread_closed",
          "https://internal/callbacks/complete",
        ]);
        const terminalEvent = vi.mocked(harness.log.info).mock.calls.at(-1)?.[1];
        expect(terminalEvent).toMatchObject({ outcome: "success", attempts: 2, retries: 1 });
        expect(terminalEvent).not.toHaveProperty("reject_reason");
      });

      it.each(["getSession", "getChannelBinding"] as const)(
        "exhausts %s reads without sending content or closure",
        async (lookup) => {
          harness.slackPostScope[lookup].mockRejectedValue(new Error("D1 unavailable"));

          await expect(harness.service.notifyComplete("msg-1", true)).resolves.toBeUndefined();

          expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
          expect(harness.slackPostScope.getChannelBinding).toHaveBeenCalledTimes(2);
          expect(harness.slackBot.fetch).not.toHaveBeenCalled();
          expect(harness.sleep).toHaveBeenCalledExactlyOnceWith(1000);
          expect(harness.log.error).toHaveBeenCalledWith(
            "callback.complete_delivery",
            expect.objectContaining({ outcome: "error", attempts: 2, retries: 1 })
          );
        }
      );

      it.each(["workspace", "private"] as const)(
        "does not transport a timed-out %s attempt after its uncancelable scope read finishes",
        async (visibility) => {
          vi.useFakeTimers();
          try {
            let release!: (session: Awaited<ReturnType<SlackPostScope["getSession"]>>) => void;
            const pendingRead = new Promise<Awaited<ReturnType<SlackPostScope["getSession"]>>>(
              (resolve) => {
                release = resolve;
              }
            );
            harness.slackPostScope.getSession.mockReturnValueOnce(pendingRead);
            const completion = harness.service.notifyComplete("msg-1", true);

            await vi.advanceTimersByTimeAsync(10_000);
            release({ ownerTeamId: "team-a", visibility });
            await completion;

            expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
            expect(harness.slackBot.fetch).toHaveBeenCalledOnce();
            expect(harness.slackBot.fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
            expect(harness.sleep).toHaveBeenCalledExactlyOnceWith(1000);
          } finally {
            vi.useRealTimers();
          }
        }
      );

      it.each([false, true])(
        "keeps invalid closure coordinates a rejected no-op after a transient read: %s",
        async (retryRead) => {
          harness.repository.getMessageCallbackContext.mockReturnValue({
            callback_context: JSON.stringify({ channel: "C123" }),
            source: "slack",
          });
          harness.slackPostScope.getSession.mockResolvedValue({
            ownerTeamId: "team-a",
            visibility: "private",
          });
          if (retryRead) {
            harness.slackPostScope.getSession.mockRejectedValueOnce(new Error("D1 unavailable"));
          }

          await harness.service.notifyComplete("msg-1", true);

          expect(harness.slackBot.fetch).not.toHaveBeenCalled();
          expect(harness.sleep).toHaveBeenCalledTimes(retryRead ? 1 : 0);
          expect(harness.log.info).toHaveBeenCalledWith(
            "callback.complete_delivery",
            expect.objectContaining({
              outcome: "rejected",
              reject_reason: "private_session",
              attempts: retryRead ? 2 : 0,
            })
          );
        }
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
        callback_context: JSON.stringify({
          source: "linear",
          issueId: " issue-1 ",
          issueIdentifier: "LIN-123",
          issueUrl: "https://linear.app/acme/issue/LIN-123",
          model: "anthropic/claude-haiku-4-5",
        }),
        source: "linear",
      });

      const mockResponse = new Response("ok", { status: 200 });
      vi.mocked(harness.linearBot.fetch).mockResolvedValue(mockResponse);

      await harness.service.notifyComplete("msg-1", false);

      const linearFetch = harness.linearBot.fetch;
      expect(linearFetch).toHaveBeenCalledTimes(1);

      const slackFetch = harness.slackBot.fetch;
      expect(slackFetch).not.toHaveBeenCalled();

      const body = JSON.parse(String(linearFetch.mock.calls[0][1]?.body));
      expect(body.context.issueId).toBe("issue-1");
      expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
    });

    it("preserves signed Linear completion retries without Slack authority reads", async () => {
      harness.repository.getMessageCallbackContext.mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });
      harness.linearBot.fetch
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok"));

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.linearBot.fetch).toHaveBeenCalledTimes(2);
      expect(harness.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(harness.slackPostScope.getChannelBinding).not.toHaveBeenCalled();
      expect(harness.sleep).toHaveBeenCalledExactlyOnceWith(1000);
      for (const [, init] of harness.linearBot.fetch.mock.calls) {
        const body = JSON.parse(String(init?.body));
        expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
        expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
      }
    });

    it("rejects invalid Linear completion payloads without retrying", async () => {
      harness.repository.getMessageCallbackContext.mockReturnValue({
        callback_context: JSON.stringify({ source: "linear" }),
        source: "linear",
      });

      await harness.service.notifyComplete("msg-1", true);

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.sleep).not.toHaveBeenCalled();
      expect(harness.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(harness.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({ reject_reason: "invalid_payload", attempts: 0 })
      );
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
      });
      const fetchMock = harness.linearBot.fetch;
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await harness.service.notifyStarted("msg-1");

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://internal/callbacks/start",
        expect.objectContaining({ method: "POST" })
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
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
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
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

  describe("refreshSlackActivity", () => {
    // The real shape the slack-bot stores and its own route re-validates —
    // a thinner fixture would sign a body the route rejects.
    const SLACK_CONTEXT = {
      source: "slack",
      channel: "C123",
      threadTs: "111.222",
      repoFullName: "acme/app",
      model: "anthropic/claude-haiku-4-5",
    };
    // `now` is a wall-clock reading taken by the sandbox-event router.
    const NOW = 1_700_000_000_000;

    function withSlackMessage(processingId: string | null = "msg-1") {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });
      vi.mocked(harness.repository.getProcessingMessageWithStartedAt).mockReturnValue(
        processingId === null ? null : { id: processingId, started_at: NOW - 1000 }
      );
      const fetchMock = vi.mocked(harness.slackBot.fetch);
      fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
      return fetchMock;
    }

    it.each([null, { teamId: "team-a" }, { teamId: "team-b" }])(
      "posts a signed refresh or safe closure for a slack message: %j",
      async (binding) => {
        const denied = binding?.teamId === "team-b";
        harness.slackPostScope.getChannelBinding.mockResolvedValue(binding);
        const fetchMock = withSlackMessage();

        await harness.service.refreshSlackActivity("msg-1", NOW);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          `https://internal/callbacks/${denied ? "thread_closed" : "activity"}`,
          expect.objectContaining({ method: "POST" })
        );
        const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
        if (denied) {
          expect(body).toEqual({
            kind: "slack.thread_closed",
            sessionId: "session-123",
            timestamp: expect.any(Number),
            context: { channel: "C123", threadTs: "111.222" },
            signature: expect.any(String),
          });
          expect(harness.log.info).toHaveBeenCalledWith(
            "callback.activity_refresh",
            expect.objectContaining({ outcome: "rejected", reject_reason: "channel_team_mismatch" })
          );
        } else {
          expect(body).toMatchObject({
            kind: SLACK_ACTIVITY_REFRESH_KIND,
            sessionId: "session-123",
            messageId: "msg-1",
            timestamp: NOW,
          });
          // The route re-parses the context it is handed, so the producer must
          // already satisfy the canonical contract.
          expect(slackCallbackContextSchema.safeParse(body.context).success).toBe(true);
        }
        expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
        expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      }
    );

    it("does not refresh a message that is no longer processing", async () => {
      const fetchMock = withSlackMessage(null);

      await harness.service.refreshSlackActivity("msg-1", NOW);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not refresh once a different message owns the turn", async () => {
      const fetchMock = withSlackMessage("msg-2");

      await harness.service.refreshSlackActivity("msg-1", NOW);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("abandons a refresh whose message terminates before it reaches the wire", async () => {
      const fetchMock = withSlackMessage();
      // The turn completes between the heartbeat that asked for this refresh
      // and the moment the refresh is ready to send.
      vi.mocked(harness.repository.getProcessingMessageWithStartedAt).mockImplementation(
        () => null
      );

      await harness.service.refreshSlackActivity("msg-1", NOW);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("holds the next refresh until the interval has passed", async () => {
      const fetchMock = withSlackMessage();

      await harness.service.refreshSlackActivity("msg-1", NOW);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await harness.service.refreshSlackActivity(
        "msg-1",
        NOW + SLACK_ACTIVITY_REFRESH_INTERVAL_MS - 1
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await harness.service.refreshSlackActivity("msg-1", NOW + SLACK_ACTIVITY_REFRESH_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("refreshes on the first heartbeat after a runtime is rebuilt", async () => {
      const fetchMock = withSlackMessage();
      await harness.service.refreshSlackActivity("msg-1", NOW);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // An evicted Durable Object reconstructs the service, so the window is
      // gone. Losing it can only make a refresh earlier, never later.
      const rebuilt = createTestHarness();
      vi.mocked(rebuilt.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });
      vi.mocked(rebuilt.repository.getProcessingMessageWithStartedAt).mockReturnValue({
        id: "msg-1",
        started_at: NOW - 1000,
      });
      vi.mocked(rebuilt.slackBot.fetch).mockResolvedValue(new Response("ok", { status: 200 }));

      await rebuilt.service.refreshSlackActivity("msg-1", NOW + 30_000);
      expect(rebuilt.slackBot.fetch).toHaveBeenCalledTimes(1);
    });

    it("does not read the message while the window is still open", async () => {
      withSlackMessage();

      await harness.service.refreshSlackActivity("msg-1", NOW);
      harness.repository.getMessageCallbackContext.mockClear();

      await harness.service.refreshSlackActivity("msg-1", NOW + 30_000);
      expect(harness.repository.getMessageCallbackContext).not.toHaveBeenCalled();
    });

    it("sends one bounded attempt and leaves the window open when it fails", async () => {
      const fetchMock = withSlackMessage();
      fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

      await harness.service.refreshSlackActivity("msg-1", NOW);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

      // A heartbeat well inside the interval still retries: nothing was
      // delivered, so nothing moved the window.
      await harness.service.refreshSlackActivity("msg-1", NOW + 30_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("swallows a delivery that throws", async () => {
      const fetchMock = withSlackMessage();
      fetchMock.mockRejectedValue(new Error("binding exploded"));

      await expect(harness.service.refreshSlackActivity("msg-1", NOW)).resolves.toBeUndefined();
      expect(harness.log.warn).toHaveBeenCalled();
    });

    it("skips a non-slack message without calling any bot", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });

      await harness.service.refreshSlackActivity("msg-1", NOW);

      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(harness.slackPostScope.getChannelBinding).not.toHaveBeenCalled();
    });

    it("skips a slack message that carries no callback context", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: null,
        source: "slack",
      });

      await harness.service.refreshSlackActivity("msg-1", NOW);

      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("skips when the slack binding is absent", async () => {
      harness = createTestHarness({ env: { SLACK_BOT: undefined } });
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(SLACK_CONTEXT),
        source: "slack",
      });

      await expect(harness.service.refreshSlackActivity("msg-1", NOW)).resolves.toBeUndefined();
      expect(harness.slackBot.fetch).not.toHaveBeenCalled();
    });

    it("is renewed by a delivered tool-call callback, so a busy turn pays nothing", async () => {
      const fetchMock = withSlackMessage();
      const toolCallAt = Date.now();

      await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // That callback set the Slack indicator, so a heartbeat arriving inside
      // the interval has nothing left to do.
      await harness.service.refreshSlackActivity("msg-1", toolCallAt + 30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not let an in-flight refresh rewind the window past a newer tool call", async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = withSlackMessage();
        let release!: (response: Response) => void;
        let markOnWire!: () => void;
        // Park the refresh on the wire, keyed on its route rather than on call
        // order — the refresh awaits HMAC signing first, so the tool call can
        // otherwise reach `fetch` before it does.
        const refreshOnWire = new Promise<void>((resolve) => {
          markOnWire = resolve;
        });
        fetchMock.mockImplementation((url) => {
          if (!String(url).endsWith("/callbacks/activity")) {
            return Promise.resolve(new Response("ok", { status: 200 }));
          }
          markOnWire();
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        });

        vi.setSystemTime(NOW);
        const refresh = harness.service.refreshSlackActivity("msg-1", NOW);
        await refreshOnWire;

        // A tool call asserts the indicator two intervals later, while the
        // refresh minted at NOW is still in flight.
        vi.setSystemTime(NOW + 2 * SLACK_ACTIVITY_REFRESH_INTERVAL_MS);
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

        release(new Response("ok", { status: 200 }));
        await refresh;

        // Back to a plain responder so the probe below fails on the assertion
        // rather than by parking on the wire.
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
        const sent = fetchMock.mock.calls.length;
        // The tool call's assertion is the newer truth. If the resolved
        // refresh had rewound the window to NOW, this would re-send.
        await harness.service.refreshSlackActivity(
          "msg-1",
          NOW + 2 * SLACK_ACTIVITY_REFRESH_INTERVAL_MS + 1_000
        );
        expect(fetchMock.mock.calls).toHaveLength(sent);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("notifyToolCall", () => {
    it.each([null, { teamId: "team-a" }])(
      "skips when throttled (< 3s since last call): %j",
      async (binding) => {
        harness.slackPostScope.getChannelBinding.mockResolvedValue(binding);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });

        const fetchMock = vi.mocked(harness.slackBot.fetch);
        fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

        // First call should go through
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://internal/callbacks/tool_call",
          expect.anything()
        );

        // Second call within 3s should be throttled
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
        expect(fetchMock).toHaveBeenCalledTimes(1); // still 1
        expect(harness.slackPostScope.getSession).toHaveBeenCalledOnce();
        expect(harness.slackPostScope.getChannelBinding).toHaveBeenCalledOnce();
      }
    );

    it("throttles denied tool events without repeated reads or closure callbacks", async () => {
      vi.useFakeTimers();
      try {
        const now = 1_700_000_000_000;
        vi.setSystemTime(now);
        harness.repository.getMessageCallbackContext.mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123", threadTs: "111.222" }),
          source: "slack",
        });
        harness.slackPostScope.getSession.mockResolvedValue({
          ownerTeamId: "team-a",
          visibility: "private",
        });
        harness.slackBot.fetch.mockResolvedValue(new Response("ok"));
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });
        expect(harness.slackBot.fetch).toHaveBeenLastCalledWith(
          "https://internal/callbacks/thread_closed",
          expect.anything()
        );
        vi.setSystemTime(now + 1000);
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
        expect(harness.slackPostScope.getSession).toHaveBeenCalledOnce();
        expect(harness.slackPostScope.getChannelBinding).toHaveBeenCalledOnce();
        expect(harness.slackBot.fetch).toHaveBeenCalledOnce();
        harness.slackPostScope.getSession.mockResolvedValue({
          ownerTeamId: "team-a",
          visibility: "workspace",
        });
        vi.setSystemTime(now + 3000);
        await harness.service.notifyToolCall("msg-1", { type: "tool_call", tool: "read" });
        expect(harness.slackPostScope.getSession).toHaveBeenCalledTimes(2);
        expect(harness.slackBot.fetch).toHaveBeenCalledTimes(2);
        expect(harness.slackBot.fetch).toHaveBeenLastCalledWith(
          "https://internal/callbacks/tool_call",
          expect.anything()
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("fires callback on first call", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });

      const fetchMock = vi.mocked(harness.linearBot.fetch);
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

      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body).toMatchObject({
        sessionId: "session-123",
        tool: "bash",
        args: { cmd: "ls" },
        callId: "call-1",
        status: "running",
        context: expect.objectContaining({ source: "linear", issueId: "issue-1" }),
      });
      expect(body.signature).toEqual(expect.any(String));
      expect(linearToolCallCallbackSchema.safeParse(body).success).toBe(true);
      expect(await verifyCallbackSignature(body, "test-secret")).toBe(true);
      expect(harness.slackPostScope.getSession).not.toHaveBeenCalled();
      expect(harness.slackPostScope.getChannelBinding).not.toHaveBeenCalled();
    });

    it("skips Linear callbacks whose tool arguments are missing", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
        source: "linear",
      });

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "bash",
        callId: "call-1",
      });

      expect(harness.linearBot.fetch).not.toHaveBeenCalled();
      expect(harness.log.warn).toHaveBeenCalledWith(
        "callback.tool_call",
        expect.objectContaining({ outcome: "skipped", skip_reason: "invalid_payload" })
      );
    });

    it("skips automation source because the scheduler has no tool-call consumer", async () => {
      vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ automationId: "a1", runId: "r1" }),
        source: "automation",
      });

      await harness.service.notifyToolCall("msg-1", {
        type: "tool_call",
        tool: "glob",
        callId: "call-1",
      });

      // No forward at all; automation callbacks only report completion.
      const slackFetch = harness.slackBot.fetch;
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

      const fetchMock = harness.slackBot.fetch;
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when no secret configured", async () => {
      const h = createTestHarness({
        env: {
          SERVICE_AUTH_SECRET_SLACK_BOT: undefined,
          SERVICE_AUTH_SECRET_LINEAR_BOT: undefined,
        },
      });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({ channel: "C123" }),
        source: "slack",
      });

      await h.service.notifyToolCall("msg-1", { type: "tool_call", tool: "bash" });

      const fetchMock = h.slackBot.fetch;
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
        const fetchMock = vi.mocked(harness.slackBot.fetch);
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

      it("does not throttle a valid Linear callback after rejecting an invalid one", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify(LINEAR_CALLBACK_CONTEXT),
          source: "linear",
        });
        harness.linearBot.fetch.mockResolvedValue(new Response("ok", { status: 200 }));

        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { command: "invalid without callId" },
        });
        await harness.service.notifyToolCall("msg-1", {
          type: "tool_call",
          tool: "bash",
          args: { command: "valid" },
          callId: "call-valid",
        });

        expect(harness.linearBot.fetch).toHaveBeenCalledOnce();
      });

      it("fires once per distinct callId across many tool calls", async () => {
        vi.useFakeTimers();
        let now = 1_700_000_000_000;
        vi.setSystemTime(now);

        vi.mocked(harness.repository.getMessageCallbackContext).mockReturnValue({
          callback_context: JSON.stringify({ channel: "C123" }),
          source: "slack",
        });
        const fetchMock = vi.mocked(harness.slackBot.fetch);
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
        const fetchMock = vi.mocked(harness.slackBot.fetch);
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
        const fetchMock = vi.mocked(harness.slackBot.fetch);
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
        const fetchMock = vi.mocked(harness.slackBot.fetch);
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
    it("routes automation callbacks to the injected completion function", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
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

      expect(completeAutomationRun).toHaveBeenCalledTimes(1);
      expect(completeAutomationRun).toHaveBeenCalledWith({
        automationId: "auto-1",
        runId: "run-1",
        sessionId: "session-123",
        messageId: "msg-1",
        success: true,
        error: undefined,
        automationName: "Daily sync",
      });
    });

    it("sends failure details for failed automation runs", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
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

      await h.service.notifyComplete("msg-1", false, "Sandbox crashed");

      expect(completeAutomationRun).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Sandbox crashed",
        })
      );
    });

    it("skips when no automation completion function is configured", async () => {
      const h = createTestHarness();

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
      const completeAutomationRun = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(undefined);
      const h = createTestHarness({
        completeAutomationRun,
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

      expect(completeAutomationRun).toHaveBeenCalledTimes(2);
      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({ source: "automation", attempts: 2, retries: 1 })
      );
    });

    it("rejects malformed persisted automation context before scheduler completion", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({ completeAutomationRun });
      vi.mocked(h.repository.getMessageCallbackContext).mockReturnValue({
        callback_context: JSON.stringify({
          source: "automation",
          automationId: "auto-1",
          automationName: "Daily sync",
        }),
        source: "automation",
      });

      await h.service.notifyComplete("msg-1", true);

      expect(completeAutomationRun).not.toHaveBeenCalled();
      expect(h.log.info).toHaveBeenCalledWith(
        "callback.complete_delivery",
        expect.objectContaining({
          source: "automation",
          outcome: "rejected",
          reject_reason: "invalid_callback_context",
          attempts: 0,
        })
      );
    });

    it("does not route automation callbacks to SLACK_BOT", async () => {
      const completeAutomationRun = vi.fn(async () => undefined);
      const h = createTestHarness({
        completeAutomationRun,
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

      const slackFetch = h.slackBot.fetch;
      expect(slackFetch).not.toHaveBeenCalled();
    });
  });
});
