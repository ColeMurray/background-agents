import { CLASSIFIER_PROMPT_MAX_CHARS, CLASSIFY_TARGET_TOOL_NAME } from "@open-inspect/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpenAITokenRefreshModule from "../session/openai-token-refresh-service";
import { handleRequest } from "../router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "../router.test-support";

const brokerState = vi.hoisted(() => ({
  refreshGlobal: vi.fn(),
}));

vi.mock("../session/openai-token-refresh-service", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAITokenRefreshModule>();
  return {
    ...actual,
    OpenAITokenBroker: class {
      refreshGlobal = brokerState.refreshGlobal;
    },
  };
});

const env = {
  ...TEST_SERVICE_SECRETS,
  REPO_SECRETS_ENCRYPTION_KEY: "encryption-key",
  SCM_PROVIDER: "github",
  DB: {
    prepare: vi.fn(),
    batch: vi.fn(),
  },
};

const decision = {
  targetId: "acme/api",
  confidence: "high",
  reasoning: "The request names the API.",
  alternatives: [],
};

function upstreamFunctionCall(argumentsValue = JSON.stringify(decision)): Response {
  return Response.json({
    output: [
      {
        type: "function_call",
        name: CLASSIFY_TARGET_TOOL_NAME,
        arguments: argumentsValue,
      },
    ],
  });
}

async function classifierRequest(
  body: unknown,
  service: "slack-bot" | "github-bot" = "slack-bot"
): Promise<Response> {
  const serialized = JSON.stringify(body);
  return handleRequest(
    await signedServiceRequest("https://internal/internal/classifier/infer", {
      method: "POST",
      body: serialized,
      service,
    }),
    env as never
  );
}

describe("POST /internal/classifier/infer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerState.refreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "secret-access-token",
      expiresIn: 1800,
      accountId: "account-123",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamFunctionCall()));
  });

  it("rejects requests without service authentication", async () => {
    const response = await handleRequest(
      new Request("https://internal/internal/classifier/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.6-luna", prompt: "route this" }),
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it("allows only the slack-bot service principal", async () => {
    const response = await classifierRequest(
      { model: "openai/gpt-5.6-luna", prompt: "route this" },
      "github-bot"
    );

    expect(response.status).toBe(403);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it.each([
    ["missing prompt", { model: "openai/gpt-5.6-luna" }],
    ["empty prompt", { model: "openai/gpt-5.6-luna", prompt: "" }],
    ["unknown field", { model: "openai/gpt-5.6-luna", prompt: "route", extra: true }],
    [
      "oversized prompt",
      { model: "openai/gpt-5.6-luna", prompt: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1) },
    ],
  ])("rejects invalid input: %s", async (_name, body) => {
    const response = await classifierRequest(body);

    expect(response.status).toBe(400);
    expect(brokerState.refreshGlobal).not.toHaveBeenCalled();
  });

  it("rejects classifier models other than OpenAI Luna", async () => {
    const response = await classifierRequest({
      model: "anthropic/claude-haiku-4-5",
      prompt: "route this",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Unsupported classifier model" });
  });

  it("returns 503 without configured global OAuth", async () => {
    brokerState.refreshGlobal.mockResolvedValue({
      ok: false,
      status: 404,
      error: "OPENAI_OAUTH_REFRESH_TOKEN not configured",
    });

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the forced strict function request to the Codex Responses endpoint", async () => {
    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this request",
    });

    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-access-token");
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-123");
    expect(headers.get("originator")).toBe("opencode");
    expect(headers.get("session_id")).toBeTruthy();
    expect(headers.get("Content-Type")).toBe("application/json");
    const upstreamBody = JSON.parse(String(init?.body));
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.6-luna",
      input: "route this request",
      tool_choice: { type: "function", name: CLASSIFY_TARGET_TOOL_NAME },
      parallel_tool_calls: false,
      store: false,
      stream: false,
    });
    expect(upstreamBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: CLASSIFY_TARGET_TOOL_NAME,
        strict: true,
        parameters: expect.objectContaining({ additionalProperties: false }),
      }),
    ]);
    await expect(response.json()).resolves.toEqual({ decision });
  });

  it("omits the account header when the token has no account id", async () => {
    brokerState.refreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "secret-access-token",
      expiresIn: 1800,
    });

    await classifierRequest({ model: "openai/gpt-5.6-luna", prompt: "route this" });

    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });

  it.each([
    ["refusal", Response.json({ output: [{ type: "message", status: "completed" }] })],
    ["malformed JSON arguments", upstreamFunctionCall("not-json")],
    [
      "invalid decision",
      upstreamFunctionCall(JSON.stringify({ ...decision, confidence: "certain" })),
    ],
    ["non-JSON response", new Response("not-json")],
  ])("returns 502 for %s", async (_name, upstreamResponse) => {
    vi.mocked(fetch).mockResolvedValueOnce(upstreamResponse);

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it("maps non-OK upstream responses without returning their body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("upstream secret details", { status: 429 })
    );

    const response = await classifierRequest({
      model: "openai/gpt-5.6-luna",
      prompt: "route this",
    });

    expect(response.status).toBe(502);
    const responseText = await response.text();
    expect(responseText).toBe(JSON.stringify({ error: "Classifier upstream unavailable" }));
    expect(responseText).not.toContain("secret-access-token");
    expect(responseText).not.toContain("upstream secret details");
  });
});
