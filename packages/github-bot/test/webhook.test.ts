import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";
import app from "../src/index";

/** Generate a valid GitHub webhook signature for a given secret and body. */
async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

const SECRET = "test-webhook-secret";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv() {
  const githubKv = createMockKV();
  return {
    GITHUB_KV: githubKv,
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
  } as unknown as Env;
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

describe("POST /webhooks/github", () => {
  it("returns 401 for invalid signature", async () => {
    const body = '{"action":"created"}';
    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": "sha256=invalid",
          "X-GitHub-Event": "issue_comment",
        },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "invalid signature" });
  });

  it("returns 401 for missing signature", async () => {
    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body: "{}",
        headers: { "X-GitHub-Event": "push" },
      }),
      makeEnv(),
      makeCtx()
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 and calls waitUntil for valid webhook", async () => {
    const body = JSON.stringify({
      action: "review_requested",
      repository: { owner: { login: "test" }, name: "repo" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-123",
        },
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
  });

  it("deduplicates repeated deliveries by X-GitHub-Delivery", async () => {
    const body = JSON.stringify({
      action: "review_requested",
      repository: { owner: { login: "test" }, name: "repo" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-123",
        },
      });

    const firstRes = await app.fetch(request(), env, ctx);
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 0);

    const secondRes = await app.fetch(request(), env, ctx);
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true, duplicate: true });

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    const githubKv = env.GITHUB_KV as unknown as {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
    };
    expect(githubKv.get).toHaveBeenCalledTimes(2);
    expect(githubKv.put).toHaveBeenCalledTimes(2);
  });

  it("allows redelivery after async processing failure clears the marker", async () => {
    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        title: "Broken payload",
        body: null,
        user: { login: "alice" },
        head: { ref: "feature/test", sha: "abc123" },
        base: { ref: "main" },
        draft: false,
      },
      repository: null,
      sender: { login: "alice" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const request = () =>
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-failure",
        },
      });

    const firstRes = await app.fetch(request(), env, ctx);
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 0);

    const secondRes = await app.fetch(request(), env, ctx);
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true });
    await flushWaitUntil(ctx, 1);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    const githubKv = env.GITHUB_KV as unknown as {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    expect(githubKv.delete).toHaveBeenCalledTimes(2);
  });

  it("returns 200 for unhandled event type", async () => {
    const body = '{"action":"opened"}';
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "push",
        },
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
  });

  it("returns 200 for handled event with non-matching action", async () => {
    const body = JSON.stringify({
      action: "closed",
      repository: { owner: { login: "test" }, name: "repo" },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
        },
      }),
      makeEnv(),
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
  });
});

describe("GET /health", () => {
  it("returns healthy status", async () => {
    const res = await app.fetch(new Request("http://localhost/health"), makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "healthy",
      service: "open-inspect-github-bot",
    });
  });
});
