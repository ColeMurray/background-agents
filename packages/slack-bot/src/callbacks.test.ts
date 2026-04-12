import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import type { Env } from "./types";
import type * as SlackClientModule from "./utils/slack-client";
import type * as ExtractorModule from "./completion/extractor";

const { mockPostMessage, mockRemoveReaction } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockRemoveReaction: vi.fn(),
}));

const { mockExtractAgentResponse } = vi.hoisted(() => ({
  mockExtractAgentResponse: vi.fn(),
}));

vi.mock("./utils/slack-client", async () => {
  const actual = await vi.importActual<typeof SlackClientModule>("./utils/slack-client");
  return {
    ...actual,
    postMessage: mockPostMessage,
    removeReaction: mockRemoveReaction,
  };
});

vi.mock("./completion/extractor", async () => {
  const actual = await vi.importActual<typeof ExtractorModule>("./completion/extractor");
  return {
    ...actual,
    extractAgentResponse: mockExtractAgentResponse,
  };
});

import { callbacksRouter } from "./callbacks";

function makeEnv(): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    CONTROL_PLANE: {} as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    LOG_LEVEL: "error",
  };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

describe("callbacksRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ok: true, ts: "post-1" });
    mockRemoveReaction.mockResolvedValue({ ok: true });
    mockExtractAgentResponse.mockResolvedValue({
      textContent: "Investigation complete.",
      toolCalls: [],
      artifacts: [],
      success: true,
    });
  });

  it("posts completion to the thread root and clears the progress reaction", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const unsignedPayload = {
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      context: {
        source: "slack" as const,
        channel: "C123",
        threadTs: "111.222",
        repoFullName: "acme/app",
        model: "anthropic/claude-haiku-4-5",
        reactionMessageTs: "222.333",
      },
    };
    const signature = await computeHmacHex(JSON.stringify(unsignedPayload), "callback-secret");
    const request = new Request("http://localhost/complete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...unsignedPayload,
        signature,
      }),
    });

    const response = await callbacksRouter.fetch(request, env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await flushWaitUntil(ctx);

    expect(mockPostMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C123",
      "Investigation complete.",
      expect.objectContaining({ thread_ts: "111.222" })
    );
    expect(mockRemoveReaction).toHaveBeenCalledWith("xoxb-test", "C123", "222.333", "eyes");
  });
});
