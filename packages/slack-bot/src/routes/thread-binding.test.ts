import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { SLACK_THREAD_BINDING_KIND } from "@open-inspect/shared/types/session-api";
import { makeExecutionContext } from "../test-helpers";
import { lookupThreadSession, storeThreadSession } from "../sessions/thread-session-store";
import type { Env } from "../types";
import app from "../app";

const SECRET = "callback-secret";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv(): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    SLACK_BOT_TOKEN: "xoxb-test",
    SERVICE_AUTH_SECRET: SECRET,
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: SLACK_THREAD_BINDING_KIND,
    channel: "C1",
    threadTs: "1700000000.000100",
    sessionId: "sess-1",
    repoFullName: "acme/web-app",
    model: "openai/gpt-6-sol",
    reasoningEffort: "high",
    timestamp: Date.now(),
    ...overrides,
  };
}

async function post(body: Record<string, unknown>, env: Env, secret = SECRET) {
  const signed = { ...body, signature: await computeHmacHex(JSON.stringify(body), secret) };
  return app.fetch(
    new Request("http://localhost/internal/thread-binding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    }),
    env,
    makeExecutionContext()
  );
}

describe("POST /internal/thread-binding", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
  });

  it("binds the thread so an @mention reply reaches the posting session", async () => {
    const res = await post(binding(), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bound: true });
    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toMatchObject({
      sessionId: "sess-1",
      repoFullName: "acme/web-app",
      model: "openai/gpt-6-sol",
      reasoningEffort: "high",
      // Human replies posted after the agent's message are forwarded with the
      // first follow-up; the agent's own post is not.
      lastPromptTs: "1700000000.000100",
    });
  });

  it("verifies the signature over the body as signed, whatever its key order", async () => {
    const { timestamp, kind, ...rest } = binding();
    const res = await post({ timestamp, ...rest, kind }, env);

    expect(res.status).toBe(200);
  });

  it("labels a session without a repository like the bot's own no-repository target", async () => {
    await post(binding({ repoFullName: null }), env);

    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toMatchObject({
      repoFullName: "No repository",
    });
  });

  it("never re-points a thread that already belongs to a session", async () => {
    await storeThreadSession(env, "C1", "1700000000.000100", {
      sessionId: "sess-original",
      repoId: "acme/api",
      repoFullName: "acme/api",
      model: "anthropic/claude-opus-5-5",
      createdAt: 1,
    });

    const res = await post(binding(), env);

    expect(await res.json()).toEqual({ ok: true, bound: false });
    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toMatchObject({
      sessionId: "sess-original",
    });
  });

  it("rejects a body signed with another key", async () => {
    const res = await post(binding(), env, "wrong-secret");

    expect(res.status).toBe(401);
    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toBeNull();
  });

  it("rejects a captured body replayed after the freshness window", async () => {
    const res = await post(binding({ timestamp: Date.now() - 10 * 60 * 1000 }), env);

    expect(res.status).toBe(401);
    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toBeNull();
  });

  it("rejects a validly signed body minted for another callback", async () => {
    const res = await post(binding({ kind: "slack.activity_refresh" }), env);

    expect(res.status).toBe(400);
    expect(await lookupThreadSession(env, "C1", "1700000000.000100")).toBeNull();
  });
});
