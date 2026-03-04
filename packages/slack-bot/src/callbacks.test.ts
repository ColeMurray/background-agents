import { describe, it, expect, vi } from "vitest";
import { callbacksRouter } from "./callbacks";
import { Hono } from "hono";
import type { Env } from "./types";

/**
 * Tests for /callbacks/update route (agent progress updates).
 */

async function signPayload(data: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TEST_SECRET = "test-callback-secret-12345";

function createTestApp(envOverrides?: Partial<Env>) {
  const waitUntilMock = vi.fn((promise: Promise<unknown>) => {
    promise.catch(() => {});
  });

  const app = new Hono<{ Bindings: Env }>();
  app.route("/callbacks", callbacksRouter);

  const env: Partial<Env> = {
    INTERNAL_CALLBACK_SECRET: TEST_SECRET,
    SLACK_BOT_TOKEN: "xoxb-test-token",
    WEB_APP_URL: "https://test.axiom.dev",
    ...envOverrides,
  };

  const executionCtx = {
    waitUntil: waitUntilMock,
    passThroughOnException: vi.fn(),
  };

  return { app, env, executionCtx, waitUntilMock };
}

function makeRequest(
  app: Hono<{ Bindings: Env }>,
  body: unknown,
  env: Partial<Env>,
  executionCtx: {
    waitUntil: ReturnType<typeof vi.fn>;
    passThroughOnException: ReturnType<typeof vi.fn>;
  }
) {
  return app.request(
    "/callbacks/update",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env as Env,
    executionCtx as unknown as ExecutionContext
  );
}

describe("/callbacks/update", () => {
  it("returns 400 for invalid payload (missing context)", async () => {
    const { app, env, executionCtx } = createTestApp();
    const res = await makeRequest(app, { message: "hello" }, env, executionCtx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid payload" });
  });

  it("returns 400 when message is missing", async () => {
    const { app, env, executionCtx } = createTestApp();
    const res = await makeRequest(
      app,
      {
        sessionId: "sess-1",
        context: { channel: "C123", threadTs: "1234.5678" },
        signature: "abc",
      },
      env,
      executionCtx
    );

    expect(res.status).toBe(400);
  });

  it("returns 500 when INTERNAL_CALLBACK_SECRET is not configured", async () => {
    const { app, env, executionCtx } = createTestApp({ INTERNAL_CALLBACK_SECRET: "" });

    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Progress update",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };
    const signature = await signPayload(payload, TEST_SECRET);

    const res = await makeRequest(app, { ...payload, signature }, env, executionCtx);
    expect(res.status).toBe(500);
  });

  it("returns 401 for invalid signature", async () => {
    const { app, env, executionCtx } = createTestApp();

    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Progress update",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };

    const res = await makeRequest(app, { ...payload, signature: "invalid-sig" }, env, executionCtx);
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid signature and text-only update", async () => {
    const { app, env, executionCtx } = createTestApp();

    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Completed step 1 of 3",
      screenshotUrl: null,
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };
    const signature = await signPayload(payload, TEST_SECRET);

    const res = await makeRequest(app, { ...payload, signature }, env, executionCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it("returns 200 with valid signature and screenshot URL", async () => {
    const { app, env, executionCtx } = createTestApp();

    const payload = {
      sessionId: "sess-1",
      messageId: "msg-1",
      message: "Here is a screenshot",
      screenshotUrl: "https://control-plane.dev/api/media/sess-1/abc.png",
      timestamp: Date.now(),
      context: { channel: "C123", threadTs: "1234.5678" },
    };
    const signature = await signPayload(payload, TEST_SECRET);

    const res = await makeRequest(app, { ...payload, signature }, env, executionCtx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
  });
});
