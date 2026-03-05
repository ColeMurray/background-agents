/**
 * Integration tests for the Linear bot webhook endpoint.
 * Exercises the full HTTP path: POST /webhook → signature check → handleAgentSessionEvent (with mocked deps).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { app } from "./index";
import { computeHmacHex } from "./utils/crypto";

vi.mock("./kv-store", () => ({
  lookupIssueSession: vi.fn(() => Promise.resolve(null)),
  storeIssueSession: vi.fn(() => Promise.resolve()),
  getProjectRepoMapping: vi.fn(() => ({})),
  getTeamRepoMapping: vi.fn(() => ({})),
  getUserPreferences: vi.fn(() => ({})),
  getTriggerConfig: vi.fn(() => ({ triggerLabel: "", autoTriggerOnCreate: false })),
  isDuplicateEvent: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("./utils/linear-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getLinearClient: vi.fn(() => Promise.resolve({ accessToken: "test-token" })),
    emitAgentActivity: vi.fn(() => Promise.resolve()),
    fetchIssueDetails: vi.fn(() =>
      Promise.resolve({
        id: "issue-1",
        identifier: "ENG-1",
        title: "Test issue",
        url: "https://linear.app/issue/ENG-1",
        state: { name: "Todo" },
        labels: [],
        comments: [],
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      })
    ),
    updateAgentSession: vi.fn(() => Promise.resolve()),
    getRepoSuggestions: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock("./utils/integration-config", () => ({
  getLinearConfig: vi.fn(() =>
    Promise.resolve({
      enabledRepos: null,
      model: null,
      reasoningEffort: null,
      allowUserPreferenceOverride: true,
      allowLabelModelOverride: true,
      emitToolProgressActivities: true,
    })
  ),
}));

vi.mock("./classifier", () => ({
  classifyRepo: vi.fn(() =>
    Promise.resolve({
      repo: { owner: "org", name: "repo", fullName: "org/repo" },
      confidence: 1,
      reasoning: "LLM classification",
      needsClarification: false,
      alternatives: [],
    })
  ),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn(() => Promise.resolve([])),
}));

// Real verifyLinearWebhook is used (via importOriginal in mock) so signature verification is tested.
const WEBHOOK_SECRET = "test-webhook-secret";

function buildAgentSessionEventPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    organizationId: "org-1",
    appUserId: "user-1",
    agentSession: {
      id: "agent-session-1",
      issue: {
        id: "issue-1",
        identifier: "ENG-1",
        title: "Test issue",
        description: "Do something",
        url: "https://linear.app/issue/ENG-1",
        priority: 0,
        priorityLabel: "None",
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      },
    },
    ...overrides,
  };
}

describe("POST /webhook integration", () => {
  let controlPlaneFetch: ReturnType<typeof vi.fn>;
  let waitUntilPromise: Promise<void>;
  let resolveWaitUntil: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilPromise = new Promise<void>((resolve) => {
      resolveWaitUntil = resolve;
    });
    controlPlaneFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://internal/sessions" && init?.method === "POST") {
        return new Response(JSON.stringify({ sessionId: "sess-123" }), { status: 201 });
      }
      if (url.includes("/sessions/") && url.includes("/prompt") && init?.method === "POST") {
        return new Response(undefined, { status: 200 });
      }
      if (url.includes("/integration-settings/")) {
        return new Response(
          JSON.stringify({
            config: {
              model: null,
              reasoningEffort: null,
              allowUserPreferenceOverride: true,
              allowLabelModelOverride: true,
              emitToolProgressActivities: true,
              enabledRepos: null,
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
  });

  function createEnv() {
    return {
      LINEAR_KV: {} as KVNamespace,
      CONTROL_PLANE: { fetch: controlPlaneFetch } as Fetcher,
      DEPLOYMENT_NAME: "test",
      CONTROL_PLANE_URL: "https://control.test",
      WEB_APP_URL: "https://web.test",
      DEFAULT_MODEL: "claude-sonnet-4-6",
      LINEAR_CLIENT_ID: "client-id",
      LINEAR_CLIENT_SECRET: "secret",
      WORKER_URL: "https://linear-bot.test",
      LINEAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
      INTERNAL_CALLBACK_SECRET: "internal-secret",
    };
  }

  function executionCtx() {
    return {
      waitUntil: (p: Promise<unknown>) => {
        void p.then(resolveWaitUntil);
      },
    };
  }

  it("returns 401 when linear-signature is missing", async () => {
    const body = JSON.stringify(buildAgentSessionEventPayload());
    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      createEnv(),
      executionCtx()
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid signature" });
  });

  it("returns 401 when linear-signature is wrong", async () => {
    const body = JSON.stringify(buildAgentSessionEventPayload());
    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data).toEqual({ error: "Invalid signature" });
  });

  it("returns 200 and calls control plane to create session and send prompt when signature is valid", async () => {
    const payload = buildAgentSessionEventPayload();
    const body = JSON.stringify(payload);
    const signature = await computeHmacHex(body, WEBHOOK_SECRET);

    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true });

    // Wait for waitUntil(handleAgentSessionEvent) to finish
    await waitUntilPromise;

    expect(controlPlaneFetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: expect.stringMatching(/^Bearer \d+\.[0-9a-f]+$/),
        }),
        body: expect.stringContaining("org"),
      })
    );

    const sessionCreateCall = (controlPlaneFetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: [string, RequestInit]) => c[0] === "https://internal/sessions" && c[1]?.method === "POST"
    );
    expect(sessionCreateCall).toBeDefined();
    const createBody = JSON.parse((sessionCreateCall![1] as RequestInit).body as string);
    expect(createBody.repoOwner).toBe("org");
    expect(createBody.repoName).toBe("repo");

    const promptCalls = (controlPlaneFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: [string, RequestInit]) => c[0].includes("/prompt") && c[1]?.method === "POST"
    );
    expect(promptCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 200 and skipped for non-AgentSessionEvent type", async () => {
    const payload = { type: "Issue", action: "create", organizationId: "org-1" };
    const body = JSON.stringify(payload);
    const signature = await computeHmacHex(body, WEBHOOK_SECRET);

    const res = await app.fetch(
      new Request("https://test/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "linear-signature": signature,
        },
        body,
      }),
      createEnv(),
      executionCtx()
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.reason).toContain("unhandled event type");
    expect(controlPlaneFetch).not.toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.anything()
    );
  });
});
