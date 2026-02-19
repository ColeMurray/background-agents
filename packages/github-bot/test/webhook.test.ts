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

function makeEnv() {
  return {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function makeCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
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
