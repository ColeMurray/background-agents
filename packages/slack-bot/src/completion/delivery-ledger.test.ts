import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  isCompletionEnqueued,
  isCompletionPosted,
  markCompletionEnqueued,
  markCompletionPosted,
  SLACK_COMPLETION_DELIVERY_TTL_MS,
} from "./delivery-ledger";

const deliveryId = "completion:session-1:message-1";

function memoryKv() {
  const store = new Map<string, { value: string; expirationTtl?: number }>();
  return {
    store,
    kv: {
      get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
      put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, { value, expirationTtl: options?.expirationTtl });
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace,
  };
}

function envWith(kv: KVNamespace): Env {
  return { SLACK_KV: kv } as Env;
}

describe("completion delivery ledger", () => {
  it("records an enqueue and a post on separate keys", async () => {
    const { kv, store } = memoryKv();
    const env = envWith(kv);

    expect(await isCompletionEnqueued(env, deliveryId)).toBe(false);
    expect(await isCompletionPosted(env, deliveryId)).toBe(false);

    await markCompletionEnqueued(env, deliveryId);
    expect(await isCompletionEnqueued(env, deliveryId)).toBe(true);
    expect(await isCompletionPosted(env, deliveryId)).toBe(false);

    await markCompletionPosted(env, deliveryId);
    expect(await isCompletionPosted(env, deliveryId)).toBe(true);
    expect(await isCompletionEnqueued(env, deliveryId)).toBe(true);
    expect(store.size).toBe(2);

    for (const marker of store.values()) {
      expect(marker.expirationTtl).toBe(SLACK_COMPLETION_DELIVERY_TTL_MS / 1000);
      expect(marker.value).toBe("1");
    }
  });

  it("does not let a late enqueue clear the posted marker", async () => {
    const { kv, store } = memoryKv();
    const env = envWith(kv);

    await markCompletionPosted(env, deliveryId);
    await markCompletionEnqueued(env, deliveryId);

    expect(await isCompletionPosted(env, deliveryId)).toBe(true);
    expect(store.size).toBe(2);
  });

  it("treats a marker read failure as not recorded", async () => {
    const env = envWith({
      get: vi.fn(async () => {
        throw new Error("kv down");
      }),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace);

    expect(await isCompletionEnqueued(env, deliveryId)).toBe(false);
    expect(await isCompletionPosted(env, deliveryId)).toBe(false);
    await markCompletionEnqueued(env, deliveryId);
    expect(env.SLACK_KV.put).toHaveBeenCalledOnce();
  });

  it("keeps distinct deliveries distinct", async () => {
    const { kv } = memoryKv();
    const env = envWith(kv);

    await markCompletionPosted(env, deliveryId);

    expect(await isCompletionPosted(env, "completion:session-1:message-2")).toBe(false);
  });
});
