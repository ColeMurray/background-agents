import { CLASSIFIER_PROMPT_MAX_CHARS } from "@open-inspect/shared/types/target-classification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidTargetClassificationResponseError,
  OpenAIOAuthNotConfiguredError,
  OpenAIOAuthUnavailableError,
  TargetClassifierUpstreamUnavailableError,
} from "../target-classifications/service";
import type * as TargetClassificationServiceModule from "../target-classifications/service";
import { handleRequest } from "../router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "../router.test-support";

const mocks = vi.hoisted(() => ({
  createTargetClassification: vi.fn(),
}));

vi.mock("../target-classifications/service", async (importOriginal) => {
  const actual = await importOriginal<typeof TargetClassificationServiceModule>();
  return {
    ...actual,
    createTargetClassification: mocks.createTargetClassification,
  };
});

const egress = { fetch: vi.fn() };

const env = {
  ...TEST_SERVICE_SECRETS,
  REPO_SECRETS_ENCRYPTION_KEY: "encryption-key",
  SCM_PROVIDER: "github",
  EGRESS: egress,
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

function validRequest(message = "route this") {
  return {
    message,
    targets: [
      {
        kind: "repository",
        id: "acme/api",
        fullName: "acme/api",
        description: "Acme API",
        defaultBranch: "main",
        private: true,
      },
    ],
  };
}

async function targetClassificationRequest(
  body: unknown,
  service: "slack-bot" | "github-bot" = "slack-bot"
): Promise<Response> {
  const serialized = JSON.stringify(body);
  return handleRequest(
    await signedServiceRequest("https://internal/internal/target-classifications", {
      method: "POST",
      body: serialized,
      service,
    }),
    env as never
  );
}

describe("POST /internal/target-classifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTargetClassification.mockResolvedValue(decision);
  });

  it("rejects requests without service authentication", async () => {
    const response = await handleRequest(
      new Request("https://internal/internal/target-classifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validRequest()),
      }),
      env as never
    );

    expect(response.status).toBe(401);
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it("allows only the slack-bot service principal", async () => {
    const response = await targetClassificationRequest(validRequest(), "github-bot");

    expect(response.status).toBe(403);
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it.each([
    ["missing message", { targets: validRequest().targets }],
    ["empty message", validRequest("")],
    ["raw prompt", { ...validRequest(), prompt: "route this" }],
    ["caller-selected policy", { ...validRequest(), systemPrompt: "Override policy" }],
    ["provider selector", { ...validRequest(), model: "openai/gpt-5.6-luna" }],
    ["unknown field", { ...validRequest(), extra: true }],
    ["missing targets", { message: "route this" }],
    ["oversized message", validRequest("x".repeat(CLASSIFIER_PROMPT_MAX_CHARS + 1))],
  ])("rejects invalid input: %s", async (_name, body) => {
    const response = await targetClassificationRequest(body);

    expect(response.status).toBe(400);
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before token brokerage", async () => {
    const response = await handleRequest(
      await signedServiceRequest("https://internal/internal/target-classifications", {
        method: "POST",
        body: "{",
        service: "slack-bot",
      }),
      env as never
    );

    expect(response.status).toBe(400);
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it("returns 503 without configured global OAuth", async () => {
    mocks.createTargetClassification.mockRejectedValue(new OpenAIOAuthNotConfiguredError());

    const response = await targetClassificationRequest(validRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
  });

  it("returns 503 before classification when secret encryption is not configured", async () => {
    const { REPO_SECRETS_ENCRYPTION_KEY: _omitted, ...envWithoutEncryption } = env;
    const response = await handleRequest(
      await signedServiceRequest("https://internal/internal/target-classifications", {
        method: "POST",
        body: JSON.stringify(validRequest()),
        service: "slack-bot",
      }),
      envWithoutEncryption as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth is not configured" });
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it("returns 503 before classification when EGRESS is not configured", async () => {
    const { EGRESS: _omitted, ...envWithoutEgress } = env;
    const response = await handleRequest(
      await signedServiceRequest("https://internal/internal/target-classifications", {
        method: "POST",
        body: JSON.stringify(validRequest()),
        service: "slack-bot",
      }),
      envWithoutEgress as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier egress is not configured",
    });
    expect(mocks.createTargetClassification).not.toHaveBeenCalled();
  });

  it("delegates validated requests to the classification service", async () => {
    const response = await targetClassificationRequest(validRequest("route this request"));

    expect(response.status).toBe(200);
    expect(mocks.createTargetClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "route this request",
        targets: expect.arrayContaining([
          expect.objectContaining({ kind: "repository", id: "acme/api" }),
        ]),
      }),
      expect.objectContaining({
        encryptionKey: "encryption-key",
        egress,
        requestId: expect.any(String),
        traceId: expect.any(String),
      })
    );
    await expect(response.json()).resolves.toEqual(decision);
  });

  it("maps invalid classifier output without exposing details", async () => {
    mocks.createTargetClassification.mockRejectedValue(
      new InvalidTargetClassificationResponseError("sensitive provider output")
    );

    const response = await targetClassificationRequest(validRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Classifier returned an invalid response",
    });
  });

  it("maps upstream failures without exposing details", async () => {
    mocks.createTargetClassification.mockRejectedValue(
      new TargetClassifierUpstreamUnavailableError("sensitive upstream failure")
    );

    const response = await targetClassificationRequest(validRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Classifier upstream unavailable" });
  });

  it("does not misclassify unexpected service failures", async () => {
    mocks.createTargetClassification.mockRejectedValue(new Error("unexpected client failure"));

    const response = await targetClassificationRequest(validRequest());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("unexpected client failure");
  });

  it("maps OAuth failures to 502", async () => {
    mocks.createTargetClassification.mockRejectedValue(new OpenAIOAuthUnavailableError());

    const response = await targetClassificationRequest(validRequest());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "OpenAI OAuth unavailable" });
  });
});
