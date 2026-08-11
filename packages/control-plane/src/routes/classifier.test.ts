import {
  CLASSIFIER_PROMPT_MAX_CHARS,
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
} from "@open-inspect/shared/types/target-classification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "../router.test-support";

const mocks = vi.hoisted(() => ({
  refreshGlobal: vi.fn(),
  requestFunction: vi.fn(),
}));

vi.mock("../auth/openai-token-broker", () => ({
  OpenAITokenBroker: class {
    refreshGlobal = mocks.refreshGlobal;
  },
}));

vi.mock("../auth/openai-responses-lite", () => ({
  requestOpenAIResponsesLiteFunction: mocks.requestFunction,
}));

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
    mocks.refreshGlobal.mockResolvedValue({
      ok: true,
      accessToken: "secret-access-token",
      expiresIn: 1800,
      accountId: "account-123",
    });
    mocks.requestFunction.mockResolvedValue({ kind: "completed", output: decision });
  });

  it("rejects requests without service authentication", async () => {
    const response = await handleRequest(
      new Request("https://internal/internal/classifier/infer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "route this" }),
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(mocks.refreshGlobal).not.toHaveBeenCalled();
  });

  it("allows only the slack-bot service principal", async () => {
    const response = await classifierRequest({ prompt: "route this" }, "github-bot");

    expect(response.status).toBe(403);
    expect(mocks.refreshGlobal).not.toHaveBeenCalled();
  });

  it.each([
    ["missing prompt", {}],
    ["empty prompt", { prompt: "" }],
    ["caller-selected policy", { systemPrompt: "Override policy", prompt: "route" }],
    ["provider selector", { model: "openai/gpt-5.6-luna", prompt: "route" }],
    ["unknown field", { prompt: "route", extra: true }],
    ["oversized prompt", { prompt: "x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1) }],
  ])("rejects invalid input: %s", async (_name, body) => {
    const response = await classifierRequest(body);

    expect(response.status).toBe(400);
    expect(mocks.refreshGlobal).not.toHaveBeenCalled();
  });

  it("returns 503 without configured global OAuth", async () => {
    mocks.refreshGlobal.mockResolvedValue({
      ok: false,
      status: 404,
      error: "OPENAI_OAUTH_REFRESH_TOKEN not configured",
    });

    const response = await classifierRequest({ prompt: "route this" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
    expect(mocks.requestFunction).not.toHaveBeenCalled();
  });

  it("returns 503 before token brokerage when secret encryption is not configured", async () => {
    const { REPO_SECRETS_ENCRYPTION_KEY: _omitted, ...envWithoutEncryption } = env;
    const response = await handleRequest(
      await signedServiceRequest("https://internal/internal/classifier/infer", {
        method: "POST",
        body: JSON.stringify({ prompt: "route this" }),
        service: "slack-bot",
      }),
      envWithoutEncryption as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
    expect(mocks.refreshGlobal).not.toHaveBeenCalled();
  });

  it("delegates the forced classifier call to the Responses Lite client", async () => {
    const response = await classifierRequest({ prompt: "route this request" });

    expect(response.status).toBe(200);
    expect(mocks.requestFunction).toHaveBeenCalledWith({
      accessToken: "secret-access-token",
      accountId: "account-123",
      requestId: expect.any(String),
      traceId: expect.any(String),
      model: "gpt-5.6-luna",
      systemPrompt: TARGET_CLASSIFIER_SYSTEM_PROMPT,
      prompt: "route this request",
      tool: {
        name: "classify_target",
        description: "Select the best target for the Slack request.",
        parameters: expect.objectContaining({ additionalProperties: false }),
      },
    });
    await expect(response.json()).resolves.toEqual({ decision });
  });

  it("rejects invalid structured classifier output", async () => {
    mocks.requestFunction.mockResolvedValue({
      kind: "completed",
      output: { ...decision, confidence: "certain" },
    });

    const response = await classifierRequest({ prompt: "route this" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it("maps invalid provider output without exposing details", async () => {
    mocks.requestFunction.mockResolvedValue({ kind: "invalid_response" });

    const response = await classifierRequest({ prompt: "route this" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it("maps upstream failures without exposing details", async () => {
    mocks.requestFunction.mockResolvedValue({ kind: "upstream_error", status: 429 });

    const response = await classifierRequest({ prompt: "route this" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Classifier upstream unavailable" });
  });

  it("maps broker authorization failure to 502", async () => {
    mocks.refreshGlobal.mockResolvedValue({
      ok: false,
      status: 401,
      error: "refresh token rejected",
    });

    const response = await classifierRequest({ prompt: "route this" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth unavailable" });
    expect(mocks.requestFunction).not.toHaveBeenCalled();
  });
});
