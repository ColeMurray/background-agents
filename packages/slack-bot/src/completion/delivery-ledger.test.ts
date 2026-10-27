import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import {
  readCompletionDelivery,
  recordCompletionEnqueued,
  recordCompletionPosted,
  SLACK_COMPLETION_DELIVERY_TTL_MS,
} from "./delivery-ledger";

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
  it("records an enqueue and then a confirmed post without shortening the ttl", async () => {
    const { kv, store } = memoryKv();
    const env = envWith(kv);

    expect(await readCompletionDelivery(env, "session-1", "message-1")).toBe("missing");
    await recordCompletionEnqueued(env, "session-1", "message-1");
    expect(await readCompletionDelivery(env, "session-1", "message-1")).toBe("enqueued");
    await recordCompletionPosted(env, "session-1", "message-1");
    expect(await readCompletionDelivery(env, "session-1", "message-1")).toBe("posted");

    const marker = [...store.values()][0];
    expect(marker?.expirationTtl).toBe(SLACK_COMPLETION_DELIVERY_TTL_MS / 1000);
  });

  it("does not downgrade a posted completion when a late enqueue is recorded", async () => {
    const { kv } = memoryKv();
    const env = envWith(kv);

    await recordCompletionPosted(env, "session-1", "message-1");
    await recordCompletionEnqueued(env, "session-1", "message-1");

    expect(await readCompletionDelivery(env, "session-1", "message-1")).toBe("posted");
  });

  it("treats a ledger read failure as unavailable", async () => {
    const env = envWith({
      get: vi.fn(async () => {
        throw new Error("kv down");
      }),
      put: vi.fn(async () => {}),
    } as unknown as KVNamespace);

    expect(await readCompletionDelivery(env, "session-1", "message-1")).toBe("unavailable");
    await recordCompletionEnqueued(env, "session-1", "message-1");
    expect(env.SLACK_KV.put).not.toHaveBeenCalled();
  });

  it("keeps distinct messages distinct", async () => {
    const { kv } = memoryKv();
    const env = envWith(kv);

    await recordCompletionPosted(env, "session-1", "message-1");

    expect(await readCompletionDelivery(env, "session-1", "message-2")).toBe("missing");
  });
});
