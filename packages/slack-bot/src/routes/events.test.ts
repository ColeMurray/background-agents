import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedSlack from "@open-inspect/shared/slack";
import type { Env } from "../types";

const { mockHandleSlackEvent, mockVerifySlackSignature } = vi.hoisted(() => ({
  mockHandleSlackEvent: vi.fn(),
  mockVerifySlackSignature: vi.fn(),
}));

// Only the signature check is stubbed; the payload schemas are the real ones so
// the test exercises the production validation boundary.
vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedSlack>()),
  verifySlackSignature: mockVerifySlackSignature,
}));

vi.mock("../events/dispatcher", () => ({
  handleSlackEvent: mockHandleSlackEvent,
}));

import { eventRoutes } from "./events";

const EVENT_ID = "Ev-kv-unavailable";

function makeEnv(kvOperation: "get" | "put"): Env {
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  };
  kv[kvOperation].mockRejectedValueOnce(
    Object.assign(new Error("KV unavailable"), { code: "KV_UNAVAILABLE" })
  );
  return { SLACK_KV: kv } as unknown as Env;
}

function eventRequest(): Request {
  return slackRequest(
    JSON.stringify({
      type: "event_callback",
      event_id: EVENT_ID,
      event: {
        type: "app_home_opened",
        tab: "home",
        user: "U123",
      },
    })
  );
}

function slackRequest(body: string): Request {
  return new Request("http://localhost/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      "x-slack-retry-num": "2",
      "x-slack-retry-reason": "http_error",
    },
    body,
  });
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

describe("POST /events deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockHandleSlackEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["get", "put"] as const)(
    "acknowledges, logs context, and dispatches when dedupe KV %s fails",
    async (kvOperation) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const env = makeEnv(kvOperation);
      const ctx = makeCtx();

      const response = await eventRoutes.fetch(eventRequest(), env, ctx);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      await ctx.waitUntil.mock.calls[0][0];
      expect(mockHandleSlackEvent).toHaveBeenCalledOnce();

      const logEntry = consoleError.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.msg === "slack.event.dedupe_unavailable");
      expect(logEntry).toEqual(
        expect.objectContaining({
          level: "error",
          service: "slack-bot",
          component: "handler",
          event_id: EVENT_ID,
          event_type: "app_home_opened",
          kv_operation: kvOperation,
          slack_retry_num: "2",
          slack_retry_reason: "http_error",
          outcome: "degraded",
          degradation_mode: "process_without_deduplication",
          error_message: "KV unavailable",
          error_type: "Error",
          error_code: "KV_UNAVAILABLE",
        })
      );
      expect(logEntry?.trace_id).toEqual(expect.any(String));
      expect(logEntry?.error_stack).toEqual(expect.any(String));
    }
  );

  it("dispatches a valid event with file and attachment fields", async () => {
    const env = makeEnv("get");
    const ctx = makeCtx();
    const response = await eventRoutes.fetch(
      slackRequest(
        JSON.stringify({
          type: "event_callback",
          event: {
            type: "message",
            text: "see attached",
            user: "U123",
            channel: "C123",
            ts: "123.456",
            files: [{ id: "F123", name: "trace.txt", size: 42, extra: "ignored" }],
            attachments: [{ is_share: true, text: "shared body", files: [{ id: "F456" }] }],
          },
        })
      ),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.waitUntil.mock.calls[0][0];
    expect(mockHandleSlackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          files: [{ id: "F123", name: "trace.txt", size: 42 }],
          attachments: [{ is_share: true, text: "shared body", files: [{ id: "F456" }] }],
        }),
      }),
      env,
      expect.any(String),
      expect.any(Function)
    );
  });

  it("rejects malformed JSON", async () => {
    const env = makeEnv("get");
    const response = await eventRoutes.fetch(slackRequest("{"), env, makeCtx());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid payload" });
    expect(mockHandleSlackEvent).not.toHaveBeenCalled();
  });

  it("rejects partial payloads without a type", async () => {
    const env = makeEnv("get");
    const response = await eventRoutes.fetch(
      slackRequest(JSON.stringify({ event_id: EVENT_ID })),
      env,
      makeCtx()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid payload" });
    expect(mockHandleSlackEvent).not.toHaveBeenCalled();
  });
});
