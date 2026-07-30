import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebhookHandler from "./webhook-handler";
import { consumeLinearWebhooks } from "./webhook-consumer";
import { createFakeDeliveryDb, createFakeKV, makeLinearBotEnv } from "./test-helpers";

const mocks = vi.hoisted(() => ({
  handleAgentSessionEvent: vi.fn(async () => undefined),
}));

vi.mock("./webhook-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof WebhookHandler>();
  return { ...actual, handleAgentSessionEvent: mocks.handleAgentSessionEvent };
});

const payload = {
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org-1",
  appUserId: "app-user-1",
  webhookId: "webhook-1",
  agentSession: { id: "agent-session-1" },
};

function makeBatch() {
  const message = {
    id: "message-1",
    timestamp: new Date(),
    body: { version: 1, deliveryId: "delivery-1", traceId: "trace-1", payload },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return {
    queue: "linear-webhooks",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    message,
  };
}

describe("consumeLinearWebhooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks successful deliveries processed before acknowledging", async () => {
    const { kv } = createFakeKV();
    const { db, store } = createFakeDeliveryDb();
    const batch = makeBatch();

    await consumeLinearWebhooks(
      batch as unknown as MessageBatch<unknown>,
      makeLinearBotEnv(kv, { DB: db })
    );

    expect(mocks.handleAgentSessionEvent).toHaveBeenCalledWith(
      payload,
      expect.any(Object),
      "trace-1",
      "delivery-1"
    );
    expect(store.get("delivery-1")?.status).toBe("processed");
    expect(batch.message.ack).toHaveBeenCalledOnce();
    expect(batch.message.retry).not.toHaveBeenCalled();
  });

  it("clears processing and retries when handling fails", async () => {
    mocks.handleAgentSessionEvent.mockRejectedValueOnce(new Error("processing failed"));
    const { kv } = createFakeKV();
    const { db, store } = createFakeDeliveryDb();
    const batch = makeBatch();

    await consumeLinearWebhooks(
      batch as unknown as MessageBatch<unknown>,
      makeLinearBotEnv(kv, { DB: db })
    );

    expect(store.has("delivery-1")).toBe(false);
    expect(batch.message.retry).toHaveBeenCalledOnce();
    expect(batch.message.ack).not.toHaveBeenCalled();
  });

  it("acknowledges an already processed redelivery without processing it", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb({ "delivery-1": "processed" });
    const batch = makeBatch();

    await consumeLinearWebhooks(
      batch as unknown as MessageBatch<unknown>,
      makeLinearBotEnv(kv, { DB: db })
    );

    expect(mocks.handleAgentSessionEvent).not.toHaveBeenCalled();
    expect(batch.message.ack).toHaveBeenCalledOnce();
  });
});
