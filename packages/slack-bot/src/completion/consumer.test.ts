import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeSlackCompletions } from "./consumer";
import { processSlackCompletion } from "./delivery";
import type { SlackCompletionJob } from "./job";
import type { Env } from "../types";
import type * as DeliveryModule from "./delivery";

vi.mock("./delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof DeliveryModule>();
  return { ...actual, processSlackCompletion: vi.fn() };
});

function makeEnv(): Env {
  return {
    SLACK_KV: {} as KVNamespace,
    SLACK_COMPLETION_QUEUE: {} as Queue,
    CONTROL_PLANE: {} as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
  };
}

function job(): SlackCompletionJob {
  return {
    version: 1,
    deliveryId: "11111111-1111-4111-8111-111111111111",
    source: "session",
    sessionId: "session-1",
    messageId: "message-1",
    success: true,
    channel: "C123",
    threadTs: "111.222",
    context: { repoFullName: "acme/app", model: "anthropic/claude-haiku-4-5" },
  };
}

function batch(body: unknown) {
  const message = {
    id: "queue-message-1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return {
    queue: "slack-completions",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    message,
  };
}

describe("consumeSlackCompletions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(processSlackCompletion).mockReset();
  });

  it("processes and acknowledges a valid completion", async () => {
    const input = batch(job());

    await consumeSlackCompletions(input as unknown as MessageBatch<unknown>, makeEnv());

    expect(processSlackCompletion).toHaveBeenCalledWith(job(), expect.any(Object));
    expect(input.message.ack).toHaveBeenCalledOnce();
    expect(input.message.retry).not.toHaveBeenCalled();
  });

  it("acknowledges invalid jobs without processing them", async () => {
    const input = batch({ version: 99 });

    await consumeSlackCompletions(input as unknown as MessageBatch<unknown>, makeEnv());

    expect(processSlackCompletion).not.toHaveBeenCalled();
    expect(input.message.ack).toHaveBeenCalledOnce();
  });

  it("acknowledges isolated processing errors", async () => {
    vi.mocked(processSlackCompletion).mockRejectedValue(new Error("unexpected"));
    const input = batch(job());

    await consumeSlackCompletions(input as unknown as MessageBatch<unknown>, makeEnv());

    expect(input.message.ack).toHaveBeenCalledOnce();
    expect(input.message.retry).not.toHaveBeenCalled();
  });
});
