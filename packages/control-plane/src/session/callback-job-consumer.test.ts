import { describe, expect, it, vi } from "vitest";
import { verifyCallbackSignature } from "@open-inspect/shared/auth";
import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";
import { linearCompletionCallbackSchema } from "@open-inspect/shared/types/session-api";
import type { Env } from "../types";
import type { FetchClient } from "../platform-ports";
import {
  consumeSessionCallbackBatch,
  deliverSessionCallbackJob,
  SESSION_CALLBACK_RETRY_DELAY_SECONDS,
} from "./callback-job-consumer";

const LINEAR_CONTEXT = {
  source: "linear",
  issueId: " issue-1 ",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "anthropic/claude-haiku-4-5",
};
const CALLBACK_TIMESTAMP = 1_700_000_000_000;

function message(body: unknown) {
  return {
    id: "queue-message-1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batch(...messages: ReturnType<typeof message>[]): MessageBatch<unknown> {
  return {
    queue: "open-inspect-session-callback-test",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

function completionJob(source: string | null = "slack"): SessionCallbackJob {
  return {
    version: 1,
    type: "session.completed",
    payload: {
      sessionId: "session-1",
      messageId: "message-1",
      source,
      success: true,
      timestamp: CALLBACK_TIMESTAMP,
      context: source === "linear" ? LINEAR_CONTEXT : { channel: "C123", threadTs: "123.45" },
    },
  };
}

describe("session callback Queue consumer", () => {
  it("resolves, signs, and delivers a Linear completion with the unchanged contract", async () => {
    const fetch = vi.fn<FetchClient["fetch"]>().mockResolvedValue(new Response("ok"));
    const env = {
      LINEAR_BOT: { fetch },
      SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-secret",
    } as unknown as Env;

    const result = await deliverSessionCallbackJob(completionJob("linear"), env);

    expect(result).toMatchObject({ delivered: true, destination: "linear-bot", httpStatus: 200 });
    expect(fetch).toHaveBeenCalledWith(
      "https://internal/callbacks/complete",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(linearCompletionCallbackSchema.safeParse(body).success).toBe(true);
    expect(body.context.issueId).toBe("issue-1");
    expect(body.timestamp).toBe(CALLBACK_TIMESTAMP);
    expect(await verifyCallbackSignature(body, "linear-secret")).toBe(true);
  });

  it("keeps the existing start and tool-call callback endpoints", async () => {
    const linearFetch = vi.fn<FetchClient["fetch"]>().mockResolvedValue(new Response("ok"));
    const slackFetch = vi.fn<FetchClient["fetch"]>().mockResolvedValue(new Response("ok"));
    const env = {
      LINEAR_BOT: { fetch: linearFetch },
      SLACK_BOT: { fetch: slackFetch },
      SERVICE_AUTH_SECRET_LINEAR_BOT: "linear-secret",
      SERVICE_AUTH_SECRET_SLACK_BOT: "slack-secret",
    } as unknown as Env;

    await deliverSessionCallbackJob(
      {
        version: 1,
        type: "session.started",
        payload: {
          sessionId: "session-1",
          messageId: "message-1",
          timestamp: CALLBACK_TIMESTAMP,
          context: LINEAR_CONTEXT,
        },
      },
      env
    );
    await deliverSessionCallbackJob(
      {
        version: 1,
        type: "tool_call",
        payload: {
          sessionId: "session-1",
          messageId: "message-1",
          source: "slack",
          tool: "bash",
          args: {},
          callId: "call-1",
          timestamp: CALLBACK_TIMESTAMP,
          context: { channel: "C123" },
        },
      },
      env
    );

    expect(linearFetch).toHaveBeenCalledWith(
      "https://internal/callbacks/start",
      expect.objectContaining({ method: "POST" })
    );
    expect(slackFetch).toHaveBeenCalledWith(
      "https://internal/callbacks/tool_call",
      expect.objectContaining({ method: "POST" })
    );
    const startBody = JSON.parse(String(linearFetch.mock.calls[0][1]?.body));
    const toolBody = JSON.parse(String(slackFetch.mock.calls[0][1]?.body));
    expect(startBody.timestamp).toBe(CALLBACK_TIMESTAMP);
    expect(toolBody.timestamp).toBe(CALLBACK_TIMESTAMP);
    expect(await verifyCallbackSignature(startBody, "linear-secret")).toBe(true);
    expect(await verifyCallbackSignature(toolBody, "slack-secret")).toBe(true);
  });

  it("retries terminal delivery and acknowledges it after a later success", async () => {
    const queued = message(completionJob());
    const failedDelivery = vi.fn(async () => ({
      delivered: false as const,
      destination: "slack-bot" as const,
      httpStatus: 503,
    }));

    await consumeSessionCallbackBatch(batch(queued), failedDelivery);

    expect(queued.retry).toHaveBeenCalledWith({
      delaySeconds: SESSION_CALLBACK_RETRY_DELAY_SECONDS,
    });
    expect(queued.ack).not.toHaveBeenCalled();

    const redelivery = message(completionJob());
    redelivery.attempts = 2;
    await consumeSessionCallbackBatch(
      batch(redelivery),
      vi.fn(async () => ({
        delivered: true as const,
        destination: "slack-bot" as const,
        httpStatus: 200,
      }))
    );
    expect(redelivery.ack).toHaveBeenCalledOnce();
  });

  it("never retries cosmetic tool-call delivery", async () => {
    const queued = message({
      version: 1,
      type: "tool_call",
      payload: {
        sessionId: "session-1",
        messageId: "message-1",
        source: "slack",
        tool: "bash",
        args: {},
        callId: "call-1",
        timestamp: CALLBACK_TIMESTAMP,
        context: { channel: "C123" },
      },
    });

    await consumeSessionCallbackBatch(
      batch(queued),
      vi.fn(async () => ({
        delivered: false as const,
        destination: "slack-bot" as const,
        error: new Error("network unavailable"),
      }))
    );

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
  });

  it("acknowledges malformed jobs without delivery", async () => {
    const queued = message({ version: 1, type: "session.completed", payload: {} });
    const deliver = vi.fn();

    await consumeSessionCallbackBatch(batch(queued), deliver);

    expect(deliver).not.toHaveBeenCalled();
    expect(queued.ack).toHaveBeenCalledOnce();
  });
});
