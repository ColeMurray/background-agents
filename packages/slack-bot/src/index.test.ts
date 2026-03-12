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
                  id: 1,
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
    mockVerifySlackSignature.mockResolvedValue(true);
    mockOpenView.mockResolvedValue({ ok: true });
  });

  it.each(["foo..bar", "release/", "-bad", "foo/.bar", "foo.lock"])(
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
  });
});
