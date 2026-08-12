import {
  TARGET_CLASSIFIER_SYSTEM_PROMPT,
  targetClassificationRequestSchema,
} from "@open-inspect/shared/types/target-classification";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenAITokenNotConfiguredError,
  OpenAITokenUnauthorizedError,
} from "../auth/openai-token-broker";
import type * as OpenAITokenBrokerModule from "../auth/openai-token-broker";
import { InvalidOpenAICodexResponseError, OpenAICodexUpstreamError } from "../openai/codex-errors";
import {
  createTargetClassification,
  InvalidTargetClassificationResponseError,
  OpenAIOAuthNotConfiguredError,
  OpenAIOAuthUnavailableError,
  TargetClassifierUpstreamUnavailableError,
} from "./service";

const mocks = vi.hoisted(() => ({ refreshGlobal: vi.fn(), requestFunction: vi.fn() }));

vi.mock("../auth/openai-token-broker", async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAITokenBrokerModule>();
  return {
    ...actual,
    OpenAITokenBroker: class {
      refreshGlobal = mocks.refreshGlobal;
    },
  };
});

vi.mock("../openai/codex-responses", () => ({
  requestOpenAICodexFunction: mocks.requestFunction,
}));

const request = targetClassificationRequestSchema.parse({
  message: "Fix the API endpoint",
  targets: [
    {
      kind: "repository",
      id: "acme/api",
      fullName: "acme/api",
      description: "Acme API",
      defaultBranch: "main",
      private: true,
    },
    {
      kind: "environment",
      id: "production",
      name: "Production",
      description: "Production workspace",
      repositories: ["acme/api"],
    },
  ],
});

const decision = {
  targetId: "acme/api",
  confidence: "high",
  reasoning: "The request names the API.",
  alternatives: [],
};

const egress = { fetch: vi.fn() } as never;
const context = {
  db: { prepare: vi.fn(), batch: vi.fn() } as never,
  encryptionKey: "encryption-key",
  egress,
  requestId: "request-123",
  traceId: "trace-123",
};

describe("createTargetClassification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshGlobal.mockResolvedValue({
      accessToken: "secret-access-token",
      accountId: "account-123",
      expiresIn: 1800,
    });
    mocks.requestFunction.mockResolvedValue(decision);
  });

  it("brokers the global token and forwards EGRESS to the forced-function request", async () => {
    await expect(createTargetClassification(request, context)).resolves.toEqual(decision);

    expect(mocks.refreshGlobal).toHaveBeenCalledOnce();
    expect(mocks.requestFunction).toHaveBeenCalledWith(
      {
        accessToken: "secret-access-token",
        accountId: "account-123",
        requestId: "request-123",
        traceId: "trace-123",
        model: "gpt-5.6-luna",
        systemPrompt: TARGET_CLASSIFIER_SYSTEM_PROMPT,
        prompt: expect.stringContaining("## User's Message\nFix the API endpoint"),
        tool: {
          name: "classify_target",
          description: "Select the best target for the Slack request.",
          parameters: expect.objectContaining({ type: "object", additionalProperties: false }),
        },
      },
      egress
    );
  });

  it("maps missing global OAuth without invoking Codex", async () => {
    mocks.refreshGlobal.mockRejectedValue(new OpenAITokenNotConfiguredError("secret"));
    await expect(createTargetClassification(request, context)).rejects.toBeInstanceOf(
      OpenAIOAuthNotConfiguredError
    );
    expect(mocks.requestFunction).not.toHaveBeenCalled();
  });

  it("maps broker authorization failures without invoking Codex", async () => {
    mocks.refreshGlobal.mockRejectedValue(new OpenAITokenUnauthorizedError("secret"));
    await expect(createTargetClassification(request, context)).rejects.toBeInstanceOf(
      OpenAIOAuthUnavailableError
    );
    expect(mocks.requestFunction).not.toHaveBeenCalled();
  });

  it.each([
    [new OpenAICodexUpstreamError("secret", 429), TargetClassifierUpstreamUnavailableError],
    [new InvalidOpenAICodexResponseError("secret"), InvalidTargetClassificationResponseError],
  ])("maps typed Codex failures", async (failure, expectedError) => {
    mocks.requestFunction.mockRejectedValue(failure);
    await expect(createTargetClassification(request, context)).rejects.toBeInstanceOf(
      expectedError
    );
  });

  it.each([
    ["schema-invalid output", { ...decision, confidence: "certain" }],
    ["unknown primary target", { ...decision, targetId: "acme/unknown" }],
    ["unknown alternative", { ...decision, alternatives: ["acme/unknown"] }],
  ])("rejects %s", async (_name, output) => {
    mocks.requestFunction.mockResolvedValue(output);
    await expect(createTargetClassification(request, context)).rejects.toBeInstanceOf(
      InvalidTargetClassificationResponseError
    );
  });

  it("accepts a null target with catalog-backed alternatives", async () => {
    const ambiguous = {
      targetId: null,
      confidence: "low",
      reasoning: "The request is ambiguous.",
      alternatives: ["acme/api", "production"],
    };
    mocks.requestFunction.mockResolvedValue(ambiguous);
    await expect(createTargetClassification(request, context)).resolves.toEqual(ambiguous);
  });

  it.each([
    ["broker", "refreshGlobal"],
    ["Codex client", "requestFunction"],
  ])("preserves unexpected %s failures", async (_name, mockName) => {
    const failure = new Error("unexpected internal failure");
    mocks[mockName as "refreshGlobal" | "requestFunction"].mockRejectedValue(failure);
    await expect(createTargetClassification(request, context)).rejects.toBe(failure);
  });
});
