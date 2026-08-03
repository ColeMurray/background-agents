import { describe, expect, it, vi } from "vitest";
import {
  claimDelivery,
  clearDeliveryClaim,
  deleteExpiredDeliveries,
  markDeliveryFailed,
  markDeliveryProcessed,
  runDeliveryStep,
} from "./delivery-store";
import { createFakeDeliveryDb, createFakeKV, makeLinearBotEnv } from "./test-helpers";

describe("delivery store", () => {
  it("atomically claims a delivery and reports a competing claim", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb();
    const env = makeLinearBotEnv(kv, { DB: db });

    expect(await claimDelivery(env, "delivery-1", "worker-1")).toBe("claimed");
    expect(await claimDelivery(env, "delivery-1", "worker-2")).toBe("processing");
  });

  it("allows a retried queue message to renew its own lease", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb();
    const env = makeLinearBotEnv(kv, { DB: db });

    expect(await claimDelivery(env, "delivery-1", "queue-message-1")).toBe("claimed");
    expect(await claimDelivery(env, "delivery-1", "queue-message-1")).toBe("claimed");
  });

  it("retains processed deliveries and clears failed claims", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb();
    const env = makeLinearBotEnv(kv, { DB: db });

    await claimDelivery(env, "processed", "worker-1");
    await markDeliveryProcessed(env, "processed", "worker-1");
    expect(await claimDelivery(env, "processed", "worker-2")).toBe("processed");

    await claimDelivery(env, "failed", "worker-1");
    await clearDeliveryClaim(env, "failed", "worker-1");
    expect(await claimDelivery(env, "failed", "worker-2")).toBe("claimed");
  });

  it("retains a terminal failed tombstone", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb();
    const env = makeLinearBotEnv(kv, { DB: db });

    await claimDelivery(env, "failed", "worker-1");
    await markDeliveryFailed(env, "failed", "worker-1");

    expect(await claimDelivery(env, "failed", "worker-2")).toBe("failed");
  });

  it("does not repeat a completed delivery step", async () => {
    const { kv } = createFakeKV();
    const { db } = createFakeDeliveryDb();
    const env = makeLinearBotEnv(kv, { DB: db });
    const operation = vi.fn(async () => undefined);
    await claimDelivery(env, "delivery-1", "worker-1");

    await runDeliveryStep(env, "delivery-1", "worker-1", "activity", operation);
    await runDeliveryStep(env, "delivery-1", "worker-1", "activity", operation);

    expect(operation).toHaveBeenCalledOnce();
  });

  it("deletes expired terminal deliveries", async () => {
    const { kv } = createFakeKV();
    const { db, store } = createFakeDeliveryDb({ expired: "processed", active: "processed" });
    const env = makeLinearBotEnv(kv, { DB: db });
    store.get("expired")!.updatedAt = 0;

    await deleteExpiredDeliveries(env);

    expect(store.has("expired")).toBe(false);
    expect(store.has("active")).toBe(true);
  });
});
