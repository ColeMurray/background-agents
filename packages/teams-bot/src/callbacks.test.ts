import { describe, expect, it, vi, beforeEach } from "vitest";
import app from "./index";
import type { Env } from "./types";

const { mockExtractAgentResponse, mockSendReply, mockSendTypingIndicator } = vi.hoisted(() => ({
  mockExtractAgentResponse: vi.fn(),
  mockSendReply: vi.fn(),
  mockSendTypingIndicator: vi.fn(),
}));

vi.mock("./completion/extractor", () => ({
  extractAgentResponse: mockExtractAgentResponse,
  SUMMARY_TOOL_NAMES: ["Edit", "Write", "Bash", "Grep", "Read"],
}));

vi.mock("./utils/teams-client", () => ({
  sendReply: mockSendReply,
  sendTypingIndicator: mockSendTypingIndicator,
}));

// Mock JWT validator to skip auth for callback tests
vi.mock("./utils/jwt-validator", () => ({
  validateBotFrameworkToken: vi.fn().mockResolvedValue(true),
}));

async function signPayload(data: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(data));
  const sig = await crypto.subtle.sign("HMAC", key, signatureData);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const TEST_SECRET = "test-callback-secret";

function createMockEnv(): Env {
  return {
    TEAMS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    CONTROL_PLANE: { fetch: vi.fn().mockResolvedValue(new Response("{}")) },
    MICROSOFT_APP_ID: "test-app-id",
    MICROSOFT_APP_PASSWORD: "test-app-password",
    MICROSOFT_TENANT_ID: "test-tenant-id",
    INTERNAL_CALLBACK_SECRET: TEST_SECRET,
    WEB_APP_URL: "https://app.example.com",
    DEFAULT_MODEL: "claude-sonnet-4-6",
    CLASSIFICATION_MODEL: "claude-haiku-4-5",
    ANTHROPIC_API_KEY: "test-key",
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.example.com",
  } as unknown as Env;
}

/** Create a mock ExecutionContext for Hono's app.request() */
function createExecutionCtx(): ExecutionContext {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as ExecutionContext;
}

/** Helper to make a request with execution context */
async function appRequest(path: string, init: RequestInit, env: Env): Promise<Response> {
  return app.request(path, init, env, createExecutionCtx());
}

describe("POST /callbacks/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendReply.mockResolvedValue(undefined);
    mockSendTypingIndicator.mockResolvedValue(undefined);
    mockExtractAgentResponse.mockResolvedValue({
      textContent: "Done.",
      toolCalls: [],
      artifacts: [],
      success: true,
    });
  });

  it("rejects invalid payload with 400", async () => {
    const env = createMockEnv();
    const res = await appRequest(
      "/callbacks/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invalid: true }),
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it("rejects invalid signature with 401", async () => {
    const env = createMockEnv();
    const payload = {
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      signature: "invalid-signature",
      context: {
        source: "teams",
        conversationId: "conv-1",
        activityId: "act-1",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      },
    };

    const res = await appRequest(
      "/callbacks/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      env
    );

    expect(res.status).toBe(401);
  });

  it("accepts valid signed payload with 200", async () => {
    const env = createMockEnv();
    const data = {
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      context: {
        source: "teams",
        conversationId: "conv-1",
        activityId: "act-1",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
        repoFullName: "octocat/repo",
        model: "claude-sonnet-4-6",
      },
    };
    const signature = await signPayload(data, TEST_SECRET);

    const res = await appRequest(
      "/callbacks/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, signature }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 500 when secret is not configured", async () => {
    const env = createMockEnv();
    (env as Record<string, unknown>).INTERNAL_CALLBACK_SECRET = "";

    const payload = {
      sessionId: "session-1",
      messageId: "msg-1",
      success: true,
      timestamp: Date.now(),
      signature: "any",
      context: {
        source: "teams",
        conversationId: "conv-1",
        activityId: "act-1",
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      },
    };

    const res = await appRequest(
      "/callbacks/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      env
    );

    expect(res.status).toBe(500);
  });
});
