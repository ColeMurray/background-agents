import { describe, expect, it } from "vitest";
import { claimDelivery, clearDeliveryClaim, markDeliveryProcessed } from "./delivery-store";
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
});
