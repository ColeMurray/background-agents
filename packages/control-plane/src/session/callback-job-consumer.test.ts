import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import {
  AUTOMATION_CONTEXT,
  COMPLETION_JOB,
  LINEAR_CONTEXT,
  SLACK_CONTEXT,
} from "../../test/callback-fixtures";
import { deliverJob, type JobDeps } from "../jobs";
import { createLogger } from "../logger";
import type { FetchClient } from "../platform-ports";
import { Scheduler } from "../scheduler/scheduler";
import type { Env } from "../types";
import { handleSessionCallback } from "./callback-job-consumer";

function callbackDeps() {
  const fetch = vi.fn<FetchClient["fetch"]>().mockImplementation(async () => new Response("ok"));
  const dispatch = vi
    .fn<Env["SESSION"]>()
    .mockResolvedValue(Response.json({ messages: [], hasMore: false }));
  const deps: JobDeps = {
    env: {
      SLACK_BOT: { fetch },
      LINEAR_BOT: { fetch },
      SESSION: dispatch,
      SERVICE_AUTH_SECRET_SLACK_BOT: "slack-key",
      SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-key",
    } as unknown as Env,
    db: {} as JobDeps["db"],
    log: createLogger("test", {}, "error"),
    correlation: { trace_id: "trace", request_id: "request" },
  };
  return { deps, fetch, dispatch };
}
const delivery = { attempts: 1, maxAttempts: 13 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session callback delivery", () => {
  it("delivers a fresh activity refresh only while its message is processing", async () => {
    const h = callbackDeps();
    h.dispatch.mockResolvedValue(
      Response.json({
        hasMore: false,
        messages: [
          {
            id: "message-1",
            authorId: "author",
            content: "prompt",
            source: "slack",
            attachments: null,
            status: "processing",
            createdAt: 1,
            startedAt: 2,
            completedAt: null,
          },
        ],
      })
    );
    const job: SessionCallbackJob = {
      version: 1,
      type: "slack.activity_refresh",
      payload: {
        kind: "slack.activity_refresh",
        sessionId: "session-1",
        messageId: "message-1",
        timestamp: Date.now(),
        context: SLACK_CONTEXT,
      },
    };
    expect(await handleSessionCallback(job, delivery, h.deps)).toBe("ack");
    expect(h.fetch.mock.calls[0][0]).toBe("https://internal/callbacks/activity");
    expect(
      await verifyCallbackSignature(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)), "slack-key")
    ).toBe(true);
  });
  it.each([
    [COMPLETION_JOB, "complete", "slack-key"],
    [
      {
        ...COMPLETION_JOB,
        type: "linear.completed",
        payload: { ...COMPLETION_JOB.payload, context: LINEAR_CONTEXT },
      },
      "complete",
      "linear-key",
    ],
    [
      {
        version: 1,
        type: "linear.started",
        payload: {
          sessionId: "session-1",
          messageId: "message-1",
          timestamp: 1000,
          context: LINEAR_CONTEXT,
        },
      },
      "start",
      "linear-key",
    ],
    [
      {
        version: 1,
        type: "slack.tool_call",
        payload: {
          sessionId: "session-1",
          timestamp: 1000,
          tool: "bash",
          args: {},
          callId: "call-1",
          context: SLACK_CONTEXT,
        },
      },
      "tool_call",
      "slack-key",
    ],
    [
      {
        version: 1,
        type: "linear.tool_call",
        payload: {
          sessionId: "session-1",
          timestamp: 1000,
          tool: "bash",
          args: {},
          callId: "call-1",
          context: LINEAR_CONTEXT,
        },
      },
      "tool_call",
      "linear-key",
    ],
  ] as const)(
    "signs %j using the destination key and preserves event time across retries",
    async (job, endpoint, key) => {
      const h = callbackDeps();
      for (const attempts of [1, 2])
        expect(await handleSessionCallback(job, { ...delivery, attempts }, h.deps)).toBe("ack");
      for (const [url, init] of h.fetch.mock.calls) {
        expect(url).toBe(`https://internal/callbacks/${endpoint}`);
        const body = JSON.parse(String(init?.body));
        expect(body.timestamp).toBe(job.payload.timestamp);
        expect(await verifyCallbackSignature(body, key)).toBe(true);
      }
    }
  );

  it.each([429, 500, 401])(
    "returns retry on terminal HTTP %s; the host owns the delay",
    async (status) => {
      const h = callbackDeps();
      h.fetch.mockResolvedValue(new Response(null, { status }));
      expect(await handleSessionCallback(COMPLETION_JOB, delivery, h.deps)).toEqual({
        retry: true,
      });
      expect(h.fetch).toHaveBeenCalledOnce();
    }
  );

  it("retries missing terminal configuration, but acknowledges failed cosmetic delivery", async () => {
    const h = callbackDeps();
    delete h.deps.env.SLACK_BOT;
    expect(await handleSessionCallback(COMPLETION_JOB, delivery, h.deps)).toEqual({ retry: true });
    expect(
      await handleSessionCallback(
        {
          version: 1,
          type: "slack.tool_call",
          payload: {
            sessionId: "session-1",
            timestamp: 1,
            tool: "bash",
            args: {},
            callId: "call-1",
            context: SLACK_CONTEXT,
          },
        },
        delivery,
        h.deps
      )
    ).toBe("ack");
  });

  it("aborts a stuck request and asks the host to retry", async () => {
    const h = callbackDeps();
    h.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true });
        })
    );
    vi.useFakeTimers();
    const pending = handleSessionCallback(COMPLETION_JOB, delivery, h.deps);
    // HMAC uses real WebCrypto; wait for it before advancing the timeout.
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ retry: true });
  });

  it("does not send malformed persisted jobs", async () => {
    const h = callbackDeps();
    expect(
      await deliverJob("session.callback", { ...COMPLETION_JOB, version: 2 }, 1, h.deps)
    ).toEqual({ retry: true });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("runs automation completion in the consumer, with scheduler retries owned by the host", async () => {
    const h = callbackDeps();
    const complete = vi.spyOn(Scheduler.prototype, "runComplete").mockResolvedValue();
    const job: SessionCallbackJob = {
      ...COMPLETION_JOB,
      type: "automation.completed",
      payload: { ...COMPLETION_JOB.payload, context: AUTOMATION_CONTEXT },
    };
    expect(await handleSessionCallback(job, delivery, h.deps)).toBe("ack");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "auto-1",
        runId: "run-1",
        sessionId: "session-1",
        messageId: "message-1",
      })
    );
    expect(h.fetch).not.toHaveBeenCalled();
    complete.mockRejectedValue(Error("store down"));
    expect(await deliverJob("session.callback", job, 2, h.deps)).toEqual({ retry: true });
  });

  it.each([0, 120_000])(
    "drops a refresh for a finished turn or stale event (%s ms)",
    async (age) => {
      const h = callbackDeps();
      const job: SessionCallbackJob = {
        version: 1,
        type: "slack.activity_refresh",
        payload: {
          kind: "slack.activity_refresh",
          sessionId: "session-1",
          messageId: "message-1",
          timestamp: Date.now() - age,
          context: SLACK_CONTEXT,
        },
      };
      expect(await handleSessionCallback(job, delivery, h.deps)).toBe("ack");
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.dispatch).toHaveBeenCalledTimes(age ? 0 : 1);
    }
  );
});
