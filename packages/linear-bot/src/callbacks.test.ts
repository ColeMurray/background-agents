import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbacksRouter } from "./callbacks";
import { getLinearAuthState } from "./kv-store";
import {
  createFakeKV,
  makeExecutionContext,
  makeLinearBotEnv,
  signCallbackPayload,
} from "./test-helpers";

describe("callbacksRouter auth health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records auth health when a tool-call callback cannot refresh Linear OAuth", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60 * 1000,
      }),
    });
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "callback-secret" });
    const ctx = makeExecutionContext();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Refresh token has expired.",
            })
          ),
      })
    );
    const payload = await signCallbackPayload(
      {
        sessionId: "session-1",
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        timestamp: Date.now(),
        context: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ORI-229",
          issueUrl: "https://linear.app/acme/issue/ORI-229/test",
          repoFullName: "ColeMurray/background-agents",
          model: "anthropic/claude-haiku-4-5",
          agentSessionId: "agent-session-1",
          organizationId: "org-1",
        },
      },
      "callback-secret"
    );

    const res = await callbacksRouter.fetch(
      new Request("http://localhost/tool_call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
      details: {
        oauthStatus: 400,
        oauthError: "invalid_grant",
        oauthErrorDescription: "Refresh token has expired.",
      },
    });
  });

  it("records auth health and fallback notification when completion callback cannot refresh OAuth", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - 60 * 1000,
      }),
    });
    const controlPlaneFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              events: [
                {
                  id: "event-1",
                  type: "token",
                  data: { content: "Agent finished." },
                  createdAt: 1,
                },
                {
                  id: "event-2",
                  type: "execution_complete",
                  data: { success: true },
                  createdAt: 2,
                },
              ],
              hasMore: false,
            }),
        };
      }
      if (url.includes("/artifacts")) {
        return {
          ok: true,
          json: () => Promise.resolve({ artifacts: [] }),
        };
      }
      throw new Error(`Unexpected control-plane fetch to ${url}`);
    });
    const env = makeLinearBotEnv(kv, {
      APP_NAME: "Acme Agent",
      CONTROL_PLANE: { fetch: controlPlaneFetch } as unknown as Fetcher,
      INTERNAL_CALLBACK_SECRET: "callback-secret",
      LINEAR_API_KEY: "linear-api-key",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        return {
          ok: false,
          status: 400,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "Refresh token has expired.",
              })
            ),
        };
      }
      if (url === "https://api.linear.app/graphql") {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { commentCreate: { success: true } } }),
        };
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeExecutionContext();
    const payload = await signCallbackPayload(
      {
        sessionId: "session-1",
        messageId: "message-1",
        success: true,
        timestamp: Date.now(),
        context: {
          source: "linear",
          issueId: "issue-1",
          issueIdentifier: "ORI-229",
          issueUrl: "https://linear.app/acme/issue/ORI-229/test",
          repoFullName: "ColeMurray/background-agents",
          model: "anthropic/claude-haiku-4-5",
          agentSessionId: "agent-session-1",
          organizationId: "org-1",
        },
      },
      "callback-secret"
    );

    const res = await callbacksRouter.fetch(
      new Request("http://localhost/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise));
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
      lastNotification: {
        issueId: "issue-1",
        issueIdentifier: "ORI-229",
        agentSessionId: "agent-session-1",
        outcome: "sent",
      },
    });
    const commentCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "https://api.linear.app/graphql"
    );
    expect(commentCall).toBeDefined();
    const commentBody = JSON.parse(String((commentCall?.[1] as RequestInit).body)) as {
      variables: { input: { body: string } };
    };
    expect(commentBody.variables.input.body).toContain("Acme Agent completed");
    expect(commentBody.variables.input.body).toContain(
      "Acme Agent could not update the Linear agent session"
    );
    expect(commentBody.variables.input.body).toContain(
      "Please re-authorize Acme Agent for this workspace"
    );
    expect(commentBody.variables.input.body).toContain(
      "https://linear-bot.example.test/oauth/authorize"
    );
    expect(commentBody.variables.input.body).not.toContain("Open-Inspect");
  });
});
