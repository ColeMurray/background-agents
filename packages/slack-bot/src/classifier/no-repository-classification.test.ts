import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";

const {
  mockMessagesCreate,
  mockGetAvailableRepos,
  mockGetRoutingRules,
  mockGetAvailableEnvironments,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockGetRoutingRules: vi.fn(),
  mockGetAvailableEnvironments: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockMessagesCreate } };
  }),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  getRoutingRules: mockGetRoutingRules,
  buildRepoDescriptions: vi.fn(() => "- acme/prod\n- acme/web"),
}));

vi.mock("./environments", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  getAvailableEnvironments: mockGetAvailableEnvironments,
  getEnvironmentById: vi.fn(),
}));

import { RepoClassifier } from "./index";

const TEST_REPOS: RepoConfig[] = [
  {
    id: "acme/prod",
    owner: "acme",
    name: "prod",
    fullName: "acme/prod",
    displayName: "prod",
    description: "Production worker",
    defaultBranch: "main",
    private: true,
  },
  {
    id: "acme/web",
    owner: "acme",
    name: "web",
    fullName: "acme/web",
    displayName: "web",
    description: "Web application",
    defaultBranch: "main",
    private: true,
  },
];

const TEST_ENV = {
  ANTHROPIC_API_KEY: "test-api-key",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
} as Env;

function llmResponse(input: Record<string, unknown>) {
  return {
    content: [
      {
        type: "tool_use",
        id: "toolu_no_repo",
        name: "classify_target",
        input,
      },
    ],
  };
}

describe("RepoClassifier no-repository policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
  });

  it("accepts a high-confidence inferred no-repository target", async () => {
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "This research does not require the codebase.",
        alternatives: ["acme/web"],
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research deployment patterns");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(false);
  });

  it("clarifies a low-confidence no-repository target", async () => {
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "low",
        reasoning: "The target is unclear.",
        alternatives: ["acme/web"],
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(true);
  });

  it("uses the classifier when only one repository is available", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "The task does not require the available repository.",
        alternatives: [],
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.target).toEqual({ kind: "none" });
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("uses the classifier when the target catalog is empty", async () => {
    mockGetAvailableRepos.mockResolvedValue([]);
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "The task can run in an empty sandbox.",
        alternatives: [],
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });
});
