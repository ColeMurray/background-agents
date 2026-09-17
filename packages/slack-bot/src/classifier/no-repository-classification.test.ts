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
        input: { alternatives: [], explicitNoRepositoryIntent: false, ...input },
      },
    ],
  };
}

function classifiedRepoFullName(result: {
  target: { kind: string; repo?: { fullName: string } } | null;
}): string | undefined {
  return result.target?.kind === "repository" ? result.target.repo?.fullName : undefined;
}

describe("RepoClassifier no-repository policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
  });

  it("bypasses the single-repo shortcut for explicit no-repository intent", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "The user explicitly requested an empty sandbox.",
        alternatives: ["acme/prod"],
        explicitNoRepositoryIntent: true,
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify(
      "Use no repository and research this topic"
    );

    expect(result.target).toEqual({ kind: "none" });
    expect(result.explicitNoRepositoryIntent).toBe(true);
    expect(result.needsClarification).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("clarifies an inferred no-repository target even at high confidence", async () => {
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "This research appears independent of the codebase.",
        alternatives: ["acme/web"],
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research deployment patterns");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.explicitNoRepositoryIntent).toBe(false);
    expect(result.needsClarification).toBe(true);
  });

  it("does not trust model-reported explicit intent without explicit user language", async () => {
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "The model overstates the user's intent.",
        explicitNoRepositoryIntent: true,
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.explicitNoRepositoryIntent).toBe(false);
    expect(result.reportedExplicitNoRepositoryIntent).toBe(true);
    expect(result.needsClarification).toBe(true);
  });

  it("clarifies explicit no-repository intent below high confidence", async () => {
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "medium",
        reasoning: "The wording may request an empty sandbox.",
        explicitNoRepositoryIntent: true,
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Use an empty sandbox");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(true);
  });

  it.each([true, false])(
    "clarifies a repository target that conflicts with explicit language (reported=%s)",
    async (reportedIntent) => {
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "acme/prod",
          confidence: "high",
          reasoning: "The model selected a repository.",
          explicitNoRepositoryIntent: reportedIntent,
        })
      );

      const result = await new RepoClassifier(TEST_ENV).classify("Use no repository");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.needsClarification).toBe(true);
    }
  );

  it("keeps the single-repo shortcut for negated no-repository intent", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);

    const result = await new RepoClassifier(TEST_ENV).classify("Do not work without a repository");

    expect(classifiedRepoFullName(result)).toBe("acme/prod");
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("classifies explicit no-repository intent with an empty catalog", async () => {
    mockGetAvailableRepos.mockResolvedValue([]);
    mockMessagesCreate.mockResolvedValue(
      llmResponse({
        targetId: "__no_repository__",
        confidence: "high",
        reasoning: "The user explicitly requested no repository.",
        explicitNoRepositoryIntent: true,
      })
    );

    const result = await new RepoClassifier(TEST_ENV).classify("Use no repository");

    expect(result.target).toEqual({ kind: "none" });
    expect(result.needsClarification).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
  });

  it("clarifies an empty catalog without calling the model", async () => {
    mockGetAvailableRepos.mockResolvedValue([]);

    const result = await new RepoClassifier(TEST_ENV).classify("Research authentication options");

    expect(result.target).toBeNull();
    expect(result.source).toBe("empty_catalog");
    expect(result.needsClarification).toBe(true);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
