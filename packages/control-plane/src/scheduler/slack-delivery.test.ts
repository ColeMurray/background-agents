import { createHmac } from "node:crypto";
import type { SlackAutomationEvent } from "@open-inspect/shared/triggers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { SlackDelivery } from "./slack-delivery";

const secret = "slack-delivery-test-secret";
const run = { automation_id: "automation-1", id: "run-1" };
const meta = { channel: "C1", messageTs: "1700000000.000002" };
const context = {
  sessionId: "session-1",
  messageId: "message-1",
  success: false,
  error: "Run failed",
  repoFullName: "acme/web",
  model: "openai/gpt-5",
  reasoningEffort: "high",
};
const event: SlackAutomationEvent = {
  source: "slack",
  eventType: "message.posted",
  triggerKey: "slack:msg:C1:1700000000.000002",
  concurrencyKey: "slack:thread:C1:1700000000.000001",
  channelId: "C1",
  channelName: "engineering",
  actorUserId: "U1",
  ts: meta.messageTs,
  threadTs: "1700000000.000001",
  permalink: "https://slack.example/message",
  text: "Please investigate",
  contextBlock: "Original context",
  meta: {},
};

function setup(overrides: Partial<Pick<Env, "SLACK_BOT" | "SERVICE_AUTH_SECRET_SLACK_BOT">> = {}) {
  const fetch = vi.fn<NonNullable<Env["SLACK_BOT"]>["fetch"]>();
  fetch.mockResolvedValue(new Response(null, { status: 200 }));
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  const delivery = new SlackDelivery(
    {
      SLACK_BOT: { fetch } as NonNullable<Env["SLACK_BOT"]>,
      SERVICE_AUTH_SECRET_SLACK_BOT: secret,
      ...overrides,
    },
    log
  );
  return { delivery, fetch, log };
}

function signedBody(body: Record<string, unknown>) {
  return JSON.stringify({
    ...body,
    signature: createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SlackDelivery", () => {
  it("posts the complete result with a real HMAC and stops on success", async () => {
    const { delivery, fetch, log } = setup();
    await delivery.notifySlackCompletion(run, meta, context);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://internal/callbacks/automation-complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: signedBody({ channel: meta.channel, reactionMessageTs: meta.messageTs, ...context }),
        signal: expect.any(AbortSignal),
      }
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["binding", "secret", "empty secret"])(
    "no-ops all methods without %s",
    async (missing) => {
      const { delivery, fetch, log } = setup(
        missing === "binding"
          ? { SLACK_BOT: undefined }
          : { SERVICE_AUTH_SECRET_SLACK_BOT: missing === "secret" ? undefined : "" }
      );
      await delivery.notifySlackCompletion(run, meta, context);
      await delivery.notifySlackConcurrencySkip(event);
      await expect(delivery.buildSlackContextWithThread(event)).resolves.toBe(event.contextBlock);
      expect(fetch).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it("no-ops without the triggering message, skip actor, or context thread", async () => {
    const { delivery, fetch } = setup();
    await delivery.notifySlackCompletion(run, { ...meta, messageTs: "" }, context);
    await delivery.notifySlackConcurrencySkip({ ...event, actorUserId: "" });
    await expect(
      delivery.buildSlackContextWithThread({ ...event, threadTs: undefined })
    ).resolves.toBe(event.contextBlock);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["non-OK", true],
    ["thrown fetch", true],
    ["non-OK", false],
    ["thrown fetch", false],
  ] as const)(
    "retries completion after %s (recovery: %s) with bounded exhaustion",
    async (kind, recovers) => {
      vi.useFakeTimers();
      const { delivery, fetch, log } = setup();
      const error = new Error("Network unavailable");
      if (kind === "non-OK") fetch.mockResolvedValue(new Response(null, { status: 503 }));
      else fetch.mockRejectedValue(error);

      const pending = delivery.notifySlackCompletion(run, meta, context);
      // HMAC uses real WebCrypto; wait for it before advancing the retry sleep.
      await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
      expect(fetch).toHaveBeenCalledTimes(1);
      if (recovers) fetch.mockResolvedValue(new Response(null, { status: 200 }));
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
      expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
      expect(log.warn).toHaveBeenCalledTimes(recovers ? 1 : 2);
      for (let attempt = 1; attempt <= (recovers ? 1 : 2); attempt++) {
        expect(log.warn).toHaveBeenNthCalledWith(attempt, "Slack completion callback failed", {
          event: "scheduler.slack_complete_failed",
          automation_id: run.automation_id,
          run_id: run.id,
          attempt,
          ...(kind === "non-OK" ? { http_status: 503 } : { error }),
        });
      }
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([event.threadTs, undefined])(
    "signs skip notices using thread anchor %s",
    async (threadTs) => {
      const { delivery, fetch } = setup();
      await delivery.notifySlackConcurrencySkip({ ...event, threadTs });
      expect(fetch).toHaveBeenCalledExactlyOnceWith("https://internal/callbacks/automation-skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: signedBody({ channel: "C1", user: "U1", threadTs: threadTs ?? event.ts }),
      });
    }
  );

  it.each(["non-OK", "thrown fetch"])(
    "treats skip %s as best effort without retries",
    async (kind) => {
      vi.useFakeTimers();
      const { delivery, fetch, log } = setup();
      if (kind === "non-OK") fetch.mockResolvedValue(new Response(null, { status: 503 }));
      else fetch.mockRejectedValue("offline");
      await expect(delivery.notifySlackConcurrencySkip(event)).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        kind === "non-OK" ? "Slack skip callback failed" : "Slack skip callback errored",
        {
          event: "scheduler.slack_skip_failed",
          channel: "C1",
          ...(kind === "non-OK" ? { http_status: 503 } : { error: new Error("offline") }),
        }
      );
    }
  );

  it.each(["engineering", undefined])(
    "signs the thread request and renders ordered context (%s)",
    async (channelName) => {
      const { delivery, fetch, log } = setup();
      fetch.mockResolvedValue(
        Response.json({ threadContext: "Alice: Earlier message\nBob: Reply" })
      );
      const timeout = vi.spyOn(AbortSignal, "timeout");
      await expect(delivery.buildSlackContextWithThread({ ...event, channelName })).resolves.toBe(
        [
          `A message was posted in Slack channel ${channelName ? "#engineering" : "C1"} by user U1.`,
          `Permalink: ${event.permalink}`,
          "",
          "Alice: Earlier message",
          "Bob: Reply",
          "",
          "<user_content>",
          event.text,
          "</user_content>",
        ].join("\n")
      );
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(fetch).toHaveBeenCalledExactlyOnceWith("https://internal/internal/thread-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: signedBody({ channel: "C1", threadTs: event.threadTs, ts: event.ts }),
        signal: timeout.mock.results[0].value,
      });
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["non-OK", "{}", 503],
    ["invalid JSON", "{", 200],
    ["missing field", "{}", 200],
    ["invalid field type", '{"threadContext":42}', 200],
    ["null schema", "null", 200],
    ["empty thread", '{"threadContext":""}', 200],
  ])("keeps original context for %s", async (_name, body, status) => {
    const { delivery, fetch } = setup();
    fetch.mockResolvedValue(new Response(body, { status }));
    await expect(delivery.buildSlackContextWithThread(event)).resolves.toBe(event.contextBlock);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back when the thread request times out", async () => {
    vi.useFakeTimers();
    const { delivery, fetch, log } = setup();
    const error = new DOMException("Thread request timed out", "TimeoutError");
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      setTimeout(() => controller.abort(error), ms);
      return controller.signal;
    });
    fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const pending = delivery.buildSlackContextWithThread(event);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(event.contextBlock);
    expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("Slack thread context request threw", {
      event: "scheduler.slack_thread_context_failed",
      channel: "C1",
      error,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
