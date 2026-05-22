import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RepoConfig } from "../types";

const {
  mockMessagesCreate,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetReposByChannel,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetReposByChannel: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  })),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
  getReposByChannel: mockGetReposByChannel,
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
    aliases: ["production"],
    keywords: ["worker", "slack"],
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
    aliases: ["frontend"],
    keywords: ["react", "ui"],
  },
];

const TEST_ENV = {
  ANTHROPIC_API_KEY: "test-api-key",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
} as Env;

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetReposByChannel.mockResolvedValue([]);
    mockBuildRepoDescriptions.mockResolvedValue("- acme/prod\n- acme/web");
  });

  it("uses tool output when provider returns valid structured classification", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_repository",
          input: {
            repoId: "acme/prod",
            confidence: "high",
            reasoning: "The message explicitly mentions prod.",
            alternatives: [],
            shouldPlan: false,
            planReasoning: "Small, well-scoped fix.",
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts", undefined, "trace-1");

    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        tool_choice: expect.objectContaining({
          type: "tool",
          name: "classify_repository",
        }),
        tools: [expect.objectContaining({ name: "classify_repository" })],
      })
    );
  });

  it("asks for clarification when tool payload is invalid", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "classify_repository",
          input: {
            repoId: "acme/prod",
            confidence: "certain",
            reasoning: "Totally sure",
            alternatives: [],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please update prod deployment config");

    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toHaveLength(2);
  });

  it("asks for clarification when tool output is missing", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"repoId":"acme/web","confidence":"high","reasoning":"Mentions frontend and UI.","alternatives":[]}',
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("frontend UI issue in web app");

    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toHaveLength(2);
  });

  // ─── Fast path: single repo available ──────────────────────────────────────
  // When only one repo is configured, the classifier skips the multi-repo LLM
  // decision but still makes a lightweight call (`classify_plan_intent`) so
  // the user benefits from smart plan-vs-build detection.

  it("single-repo fast path: surfaces shouldPlan + planReasoning from the plan-intent call", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_plan",
          name: "classify_plan_intent",
          input: { shouldPlan: true, planReasoning: "Multi-step refactor." },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("refactor the auth module to use the new pattern");

    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(result.shouldPlan).toBe(true);
    expect(result.planReasoning).toBe("Multi-step refactor.");
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: expect.objectContaining({ name: "classify_plan_intent" }),
      })
    );
  });

  it("single-repo fast path: defaults shouldPlan to false when the plan-intent call errors", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
    mockMessagesCreate.mockRejectedValue(new Error("API error"));

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("refactor the auth module");

    // Repo choice still works (it's the only one) even though plan detection failed.
    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.shouldPlan).toBe(false);
    expect(result.planReasoning).toBeUndefined();
  });

  // ─── Fast path: channel bound to a single repo ─────────────────────────────

  it("channel-bound fast path: surfaces shouldPlan + planReasoning from the plan-intent call", async () => {
    mockGetReposByChannel.mockResolvedValue([TEST_REPOS[1]]);
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_plan_channel",
          name: "classify_plan_intent",
          input: { shouldPlan: false, planReasoning: "Small typo fix." },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("fix the typo in the homepage hero", {
      channelId: "C123",
    });

    expect(result.repo?.fullName).toBe("acme/web");
    expect(result.reasoning).toContain("Channel is associated");
    expect(result.shouldPlan).toBe(false);
    expect(result.planReasoning).toBe("Small typo fix.");
  });
});
