import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "./types";
import type * as SlackClientModule from "./utils/slack-client";

const { mockVerifySlackSignature, mockPublishView, mockOpenView } = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockPublishView: vi.fn(),
  mockOpenView: vi.fn(),
}));

vi.mock("./utils/slack-client", async () => {
  const actual = await vi.importActual<typeof SlackClientModule>("./utils/slack-client");
  return {
    ...actual,
    verifySlackSignature: mockVerifySlackSignature,
    publishView: mockPublishView,
    openView: mockOpenView,
  };
});

import app from "./index";
import { clearLocalCache } from "./classifier/repos";

function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) {
        return null;
      }
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const prefix = options?.prefix ?? "";
      const keys = Array.from(store.keys())
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name }));
      return {
        keys,
        list_complete: true,
        cursor: "",
      };
    }),
  };
}

function makeEnv(): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    CONTROL_PLANE: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "signing-secret",
    ANTHROPIC_API_KEY: "test-key",
    LOG_LEVEL: "error",
  };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as any;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

describe("POST /interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockOpenView.mockResolvedValue({ ok: true });
  });

  it.each(["foo..bar", "release/", "-bad", "@", "foo/.bar", "foo.lock"])(
    "rejects invalid branch submission %s",
    async (branch) => {
      const payload = {
        type: "view_submission",
        user: { id: "U123" },
        view: {
          callback_id: "branch_preference_modal",
          state: {
            values: {
              branch_input: {
                branch_value: {
                  type: "plain_text_input",
                  value: branch,
                },
              },
            },
          },
        },
      };

      const request = new Request("http://localhost/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=test",
          "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
        },
        body: new URLSearchParams({ payload: JSON.stringify(payload) }),
      });

      const env = makeEnv();
      const ctx = makeCtx();
      const response = await app.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        response_action: "errors",
        errors: {
          branch_input: "Enter a valid Git branch name.",
        },
      });
      expect(ctx.waitUntil).not.toHaveBeenCalled();
      expect(
        (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put
      ).not.toHaveBeenCalled();
      expect(mockPublishView).not.toHaveBeenCalled();
    }
  );

  it("rejects invalid repo branch submission", async () => {
    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/app" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "feature..bad",
              },
            },
          },
        },
      },
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_action: "errors",
      errors: {
        branch_input: "Enter a valid Git branch name.",
      },
    });
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("acknowledges branch preference submissions before App Home publish completes", async () => {
    const publishDeferred = createDeferred<{ ok: boolean }>();
    mockPublishView.mockReturnValue(publishDeferred.promise);

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "branch_preference_modal",
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "main",
              },
            },
          },
        },
      },
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const ctx = makeCtx();
    const responsePromise = Promise.resolve(app.fetch(request, env, ctx));

    const outcome = await Promise.race([
      responsePromise.then(() => "response"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);

    expect(outcome).toBe("response");

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    const backgroundPromise = ctx.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    const backgroundOutcome = await Promise.race([
      backgroundPromise.then(() => "background-complete"),
      new Promise<string>((resolve) => setTimeout(() => resolve("background-pending"), 25)),
    ]);

    expect(backgroundOutcome).toBe("background-pending");

    publishDeferred.resolve({ ok: true });
    await flushWaitUntil(ctx);
    expect(mockPublishView).toHaveBeenCalledOnce();
  });

  it("persists global branch preference to KV", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "branch_preference_modal",
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "staging",
              },
            },
          },
        },
      },
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    const prefsCall = kvPut.mock.calls.find((args: unknown[]) => args[0] === "user_prefs:U123");
    expect(prefsCall).toBeTruthy();
    const saved = JSON.parse(prefsCall![1] as string) as { branch?: string };
    expect(saved.branch).toBe("staging");
  });

  it("stores repo-specific branch preference from repo branch modal", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/app" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "release/2026-03",
              },
            },
          },
        },
      },
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    expect(kvPut).toHaveBeenCalledWith("user_repo_branch:U123:acme/app", "release/2026-03");

    const publishCall = mockPublishView.mock.calls.at(-1);
    expect(publishCall?.[1]).toBe("U123");
    expect(JSON.stringify(publishCall?.[2])).toContain("acme/app");
    expect(JSON.stringify(publishCall?.[2])).toContain("release/2026-03");
  });

  it("ignores repo-specific branch submission for unknown repo", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "view_submission",
      user: { id: "U123" },
      view: {
        callback_id: "repo_branch_preference_modal",
        private_metadata: JSON.stringify({ userId: "U123", repoId: "acme/unknown" }),
        state: {
          values: {
            branch_input: {
              branch_value: {
                type: "plain_text_input",
                value: "release/2026-03",
              },
            },
          },
        },
      },
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvPut = (env.SLACK_KV as unknown as { put: ReturnType<typeof vi.fn> }).put;
    expect(kvPut).not.toHaveBeenCalledWith("user_repo_branch:U123:acme/unknown", "release/2026-03");
  });

  it("prefers repo branch over global branch when creating a session", async () => {
    const slackFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true, ts: "123.456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      channel: { id: "C123" },
      message: { ts: "111.222" },
      actions: [
        {
          action_id: "select_repo",
          selected_option: { value: "acme/app" },
        },
      ],
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "pending:C123:111.222",
      JSON.stringify({
        message: "Please handle this",
        userId: "U123",
      })
    );
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_preferences:U123",
      JSON.stringify({
        userId: "U123",
        model: "anthropic/claude-haiku-4-5",
        reasoningEffort: "medium",
        branch: "global-branch",
        updatedAt: Date.now(),
      })
    );
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_repo_branch:U123:acme/app",
      "repo-branch"
    );

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(
            JSON.stringify({
              repos: [
                {
                  id: "acme/app",
                  owner: "acme",
                  name: "app",
                  fullName: "acme/app",
                  defaultBranch: "main",
                  private: true,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ sessionId: "session-1", status: "running" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/prompt")) {
          return new Response(JSON.stringify({ messageId: "msg-1" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const sessionCall = (
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      return url.endsWith("/sessions");
    });

    expect(sessionCall).toBeTruthy();
    const init = sessionCall?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { branch?: string };
    expect(body.branch).toBe("repo-branch");

    slackFetch.mockRestore();
  });

  it("clears repo-specific branch override from App Home", async () => {
    mockPublishView.mockResolvedValue({ ok: true });

    const payload = {
      type: "block_actions",
      user: { id: "U123" },
      actions: [
        {
          action_id: "clear_repo_branch_override",
          value: "acme/app",
        },
      ],
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    await (env.SLACK_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(
      "user_repo_branch:U123:acme/app",
      "staging"
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(ctx.waitUntil).toHaveBeenCalledOnce();

    await flushWaitUntil(ctx);

    const kvDelete = (env.SLACK_KV as unknown as { delete: ReturnType<typeof vi.fn> }).delete;
    expect(kvDelete).toHaveBeenCalledWith("user_repo_branch:U123:acme/app");
    expect(mockPublishView).toHaveBeenCalled();
  });

  it("returns repo suggestions beyond 100 repos via search", async () => {
    const payload = {
      type: "block_suggestion",
      action_id: "select_repo_branch_override",
      user: { id: "U123" },
      value: "repo-150",
    };

    const request = new Request("http://localhost/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-slack-signature": "v0=test",
        "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
      },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });

    const env = makeEnv();
    const repos = Array.from({ length: 150 }, (_, idx) => {
      const number = String(idx + 1).padStart(3, "0");
      return {
        id: `acme/repo-${number}`,
        owner: "acme",
        name: `repo-${number}`,
        fullName: `acme/repo-${number}`,
        defaultBranch: "main",
        private: true,
      };
    });

    (env.CONTROL_PLANE.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/repos")) {
          return new Response(JSON.stringify({ repos }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ enabledModels: ["anthropic/claude-haiku-4-5"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    );

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();

    const body = (await response.json()) as {
      options: Array<{ text: { type: string; text: string }; value: string }>;
    };
    expect(body.options).toEqual([
      {
        text: { type: "plain_text", text: "acme/repo-150" },
        value: "acme/repo-150",
      },
    ]);
  });
});
