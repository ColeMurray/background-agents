import { vi } from "vitest";
import type { Env } from "./types";

export const LINEAR_WEBHOOK_TEST_SECRET = "test-linear-webhook-secret";

export interface PutCall {
  key: string;
  value: string;
  options?: { expirationTtl?: number };
}

export function createFakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls: PutCall[] = [];

  const kv = {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      if (value === null) return null;
      if (type === "json") return JSON.parse(value) as unknown;
      return value;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, value);
      putCalls.push({ key, value, options });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  return { kv: kv as unknown as KVNamespace, store, putCalls };
}

export function makeLinearBotEnv(kv: KVNamespace, overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_KV: kv,
    LINEAR_WEBHOOK_SECRET: LINEAR_WEBHOOK_TEST_SECRET,
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.example.test",
    WEB_APP_URL: "https://web.example.test",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
    WORKER_URL: "https://linear-bot.example.test",
    ANTHROPIC_API_KEY: "anthropic-key",
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Fetcher,
    ...overrides,
  };
}

export function makeExecutionContext() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

export async function signLinearWebhookRequest(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(LINEAR_WEBHOOK_TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
