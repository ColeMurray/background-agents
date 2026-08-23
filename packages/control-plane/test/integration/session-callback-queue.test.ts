import { describe, expect, it, vi } from "vitest";
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import worker from "../../src/index";
import type { Env } from "../../src/types";
import type { FetchClient } from "../../src/platform-ports";

describe("session callback Queue integration", () => {
  it("delivers a completion after the producing actor has been evicted", async () => {
    const persistedJob = {
      version: 1 as const,
      type: "session.completed" as const,
      payload: {
        sessionId: "evicted-session",
        messageId: "message-1",
        source: "slack",
        success: true,
        context: { channel: "C123", threadTs: "123.45" },
      },
    };
    const batch = createMessageBatch("open-inspect-session-callback-test", [
      {
        id: "callback-message-1",
        timestamp: new Date(),
        attempts: 1,
        body: persistedJob,
      },
    ]);
    const fetch = vi.fn<FetchClient["fetch"]>().mockResolvedValue(new Response("ok"));
    const consumerEnv = {
      ...env,
      SLACK_BOT: { fetch },
      SERVICE_AUTH_SECRET_SLACK_BOT: "test-service-secret-slack-bot",
    } as unknown as Env;

    const ctx = createExecutionContext();
    await worker.queue(batch, consumerEnv, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(["callback-message-1"]);
    expect(result.retryMessages).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      sessionId: "evicted-session",
      messageId: "message-1",
      success: true,
    });
    expect(await verifyCallbackSignature(body, "test-service-secret-slack-bot")).toBe(true);
  });
});
