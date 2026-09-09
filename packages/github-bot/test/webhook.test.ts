import { describe, it, expect, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn().mockResolvedValue({ hasPermission: true }),
}));

import app from "../src/index";
import { postReaction } from "../src/github-auth";

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
    AUTOFIX_QUEUE: {
      send: vi.fn(async () => undefined),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    },
    GITHUB_WEBHOOK_SECRET: SECRET,
    SERVICE_AUTH_SECRET: "test-internal-secret",
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
  it("queues an eligible pull request comment before acknowledging the webhook", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1234,
        body: "Please handle the null case.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1234",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledWith({
      version: 1,
      eventType: "issue_comment",
      action: "created",
      deliveryId: "delivery-comment-1234",
      providerObject: { kind: "pr_comment", id: "1234" },
      repository: { id: "99", owner: "test", name: "repo" },
      pullRequestNumber: 42,
      receivedAt: expect.any(String),
    });
    await flushWaitUntil(ctx);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/internal/github-event",
      expect.any(Object)
    );
  });

  it("does not queue explicit bot mentions for Autofix", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1235,
        body: "@test-bot[bot] please investigate this.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1235",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).not.toHaveBeenCalled();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("queues one Autofix request for a submitted review", async () => {
    const body = JSON.stringify({
      action: "submitted",
      review: {
        id: 5678,
        state: "changes_requested",
      },
      pull_request: { number: 42 },
      repository: {
        id: 99,
        name: "repo",
        owner: { login: "test" },
      },
      sender: { id: 7, login: "alice", type: "User" },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request_review",
          "X-GitHub-Delivery": "delivery-review-5678",
        },
      }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledWith({
      version: 1,
      eventType: "pull_request_review",
      action: "submitted",
      deliveryId: "delivery-review-5678",
      providerObject: { kind: "review", id: "5678" },
      repository: { id: "99", owner: "test", name: "repo" },
      pullRequestNumber: 42,
      receivedAt: expect.any(String),
    });
  });

  it("does not queue individual review comment webhooks", async () => {
    const body = JSON.stringify({
      action: "created",
      pull_request: {
        number: 42,
        title: "Handle nullable input",
        head: { ref: "feature/nulls", sha: "abc123" },
        base: { ref: "main" },
      },
      comment: {
        id: 5679,
        body: "Please handle the null case.",
        path: "src/input.ts",
        diff_hunk: "@@ -1 +1 @@",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request_review_comment",
          "X-GitHub-Delivery": "delivery-review-comment-5679",
        },
      }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(200);
    expect(env.AUTOFIX_QUEUE.send).not.toHaveBeenCalled();
  });

  it("continues normal webhook handling when Autofix queueing fails", async () => {
    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Handle nullable input",
        pull_request: {
          url: "https://api.github.com/repos/test/repo/pulls/42",
        },
      },
      comment: {
        id: 1236,
        body: "Please handle the null case.",
        user: { login: "alice" },
      },
      repository: {
        id: 99,
        name: "repo",
        private: false,
        owner: { login: "test" },
      },
      sender: {
        id: 7,
        login: "alice",
        type: "User",
        avatar_url: "https://example.com/alice.png",
      },
    });
    const signature = await sign(SECRET, body);
    const env = makeEnv();
    const ctx = makeCtx();
    env.AUTOFIX_QUEUE.send.mockRejectedValueOnce(new Error("queue unavailable"));

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-comment-1236",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);
    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/internal/github-event",
      expect.any(Object)
    );
    expect(env.GITHUB_KV.delete).not.toHaveBeenCalled();
  });

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

  it("keeps reaction work in the root Worker lifecycle task", async () => {
    let finishReaction!: (ok: boolean) => void;
    vi.mocked(postReaction).mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishReaction = resolve;
      })
    );
    const body = JSON.stringify({
      action: "review_requested",
      pull_request: {
        number: 42,
        title: "Bound GitHub requests",
        body: null,
        user: { login: "alice" },
        head: { ref: "feature/timeouts", sha: "abc123" },
        base: { ref: "main" },
      },
      requested_reviewer: { login: "test-bot[bot]" },
      repository: { owner: { login: "test" }, name: "repo", private: false },
      sender: {
        login: "alice",
        id: 1001,
        avatar_url: "https://avatars.githubusercontent.com/u/1001",
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();
    const controlPlaneFetch = vi.mocked(env.CONTROL_PLANE.fetch);
    controlPlaneFetch.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/integration-settings/github/resolved/")) {
        return new Response(JSON.stringify({ config: null }));
      }
      if (requestUrl.endsWith("/metadata")) {
        return new Response(JSON.stringify({ repo: "test/repo", metadata: null }));
      }
      if (requestUrl === "https://internal/sessions") {
        return new Response(JSON.stringify({ sessionId: "session-123", status: "created" }));
      }
      if (requestUrl.endsWith("/prompt")) {
        return new Response(JSON.stringify({ messageId: "message-123" }));
      }
      return new Response(null, { status: 204 });
    });

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": "delivery-reaction",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    const rootTask = ctx.waitUntil.mock.calls[0][0] as Promise<void>;
    let rootSettled = false;
    void rootTask.finally(() => {
      rootSettled = true;
    });
    await vi.waitFor(() =>
      expect(controlPlaneFetch).toHaveBeenCalledWith(
        "https://internal/sessions/session-123/prompt",
        expect.any(Object)
      )
    );
    expect(rootSettled).toBe(false);

    finishReaction(true);
    await rootTask;
    expect(rootSettled).toBe(true);
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
      repository: { owner: { login: "test" }, name: "repo" },
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
    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of controlPlaneFetch.mock.calls) {
      expect(url).toBe("https://internal/internal/github-event");
      expect(JSON.parse(init.body as string)).toMatchObject({
        eventType: "pull_request.opened",
        repoOwner: "test",
        repoName: "repo",
        pullRequest: { number: 42 },
      });
    }
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

  it("forwards closed pull request lifecycle fields to the control plane", async () => {
    const body = JSON.stringify({
      action: "closed",
      repository: { owner: { login: "test" }, name: "repo" },
      sender: { login: "alice" },
      pull_request: {
        number: 42,
        title: "Ship lifecycle updates",
        body: null,
        state: "closed",
        draft: false,
        merged: true,
        html_url: "https://github.com/test/repo/pull/42",
        created_at: "2026-07-10T10:00:00Z",
        updated_at: "2026-07-14T11:00:00Z",
        merged_at: "2026-07-14T10:59:00Z",
        closed_at: "2026-07-14T11:00:00Z",
        user: { login: "alice" },
        labels: [{ name: "ready" }],
        head: { ref: "feature/lifecycle", sha: "abc123", repo: { id: 99 } },
        base: { ref: "main", repo: { id: 99 } },
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "pull_request",
        },
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await flushWaitUntil(ctx);

    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-event");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "pull_request.closed",
      repoOwner: "test",
      repoName: "repo",
      branch: "feature/lifecycle",
      targetBranch: "main",
      labels: ["ready"],
      pullRequest: {
        number: 42,
        state: "closed",
        draft: false,
        merged: true,
        headSha: "abc123",
        isCrossRepository: false,
        url: "https://github.com/test/repo/pull/42",
        repositoryExternalId: "99",
        providerCreatedAt: Date.parse("2026-07-10T10:00:00Z"),
        providerUpdatedAt: Date.parse("2026-07-14T11:00:00Z"),
        mergedAt: Date.parse("2026-07-14T10:59:00Z"),
        closedAt: Date.parse("2026-07-14T11:00:00Z"),
      },
    });
  });

  it("forwards a completed workflow run", async () => {
    const body = JSON.stringify({
      action: "completed",
      repository: { owner: { login: "acme-org" }, name: "my-app" },
      sender: { login: "github-actions[bot]" },
      workflow_run: {
        id: 123456789,
        run_attempt: 1,
        name: "CI",
        conclusion: "failure",
        head_branch: "main",
        head_sha: "abc1234def5678",
        path: ".github/workflows/ci.yml",
        html_url: "https://github.com/acme-org/my-app/actions/runs/123456789",
      },
    });
    const signature = await sign(SECRET, body);
    const ctx = makeCtx();
    const env = makeEnv();

    const response = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": signature,
          "X-GitHub-Event": "workflow_run",
          "X-GitHub-Delivery": "delivery-workflow-run-123456789",
        },
      }),
      env,
      ctx
    );

    expect(response.status).toBe(200);
    await flushWaitUntil(ctx);

    const controlPlaneFetch = (env.CONTROL_PLANE as unknown as { fetch: ReturnType<typeof vi.fn> })
      .fetch;
    expect(controlPlaneFetch).toHaveBeenCalledOnce();
    const [url, init] = controlPlaneFetch.mock.calls[0];
    expect(url).toBe("https://internal/internal/github-event");
    expect(JSON.parse(init.body as string)).toMatchObject({
      eventType: "workflow_run.completed",
      repoOwner: "acme-org",
      repoName: "my-app",
      workflowName: "CI",
      conclusion: "failure",
      triggerKey: "workflow_run:123456789:1",
    });
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
