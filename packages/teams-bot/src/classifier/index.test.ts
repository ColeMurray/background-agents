import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env, RepoConfig } from "../types";

const TEST_REPOS: RepoConfig[] = [
  {
    id: "octocat/hello-world",
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    displayName: "hello-world",
    description: "A greeting service",
    defaultBranch: "main",
    private: false,
    channelAssociations: ["channel-1"],
  },
  {
    id: "octocat/api-server",
    owner: "octocat",
    name: "api-server",
    fullName: "octocat/api-server",
    displayName: "api-server",
    description: "REST API backend",
    defaultBranch: "main",
    private: true,
  },
];

const { mockGetAvailableRepos, mockGetReposByChannel, mockMessagesCreate } = vi.hoisted(() => ({
  mockGetAvailableRepos: vi.fn(),
  mockGetReposByChannel: vi.fn(),
  mockMessagesCreate: vi.fn(),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  getReposByChannel: mockGetReposByChannel,
  buildRepoDescriptions: vi.fn().mockResolvedValue("repo descriptions"),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockMessagesCreate };
  },
}));

import { RepoClassifier } from "./index";

const TEST_ENV = {
  ANTHROPIC_API_KEY: "test-key",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
} as unknown as Env;

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetReposByChannel.mockResolvedValue([]);
  });

  it("returns needsClarification when no repos are available", async () => {
    mockGetAvailableRepos.mockResolvedValue([]);
    const classifier = new RepoClassifier(TEST_ENV);

    const result = await classifier.classify("fix the bug");

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
  });

  it("auto-selects the only available repo", async () => {
    mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
    const classifier = new RepoClassifier(TEST_ENV);

    const result = await classifier.classify("fix the bug");

    expect(result.repo).toEqual(TEST_REPOS[0]);
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    // Should not call the LLM
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("auto-selects when channel is associated with exactly one repo", async () => {
    mockGetReposByChannel.mockResolvedValue([TEST_REPOS[0]]);
    const classifier = new RepoClassifier(TEST_ENV);

    const result = await classifier.classify("fix the bug", { channelId: "channel-1" });

    expect(result.repo).toEqual(TEST_REPOS[0]);
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("classifies using LLM with high confidence", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: "octocat/hello-world",
            confidence: "high",
            reasoning: "Message mentions greeting service",
            alternatives: [],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("fix the greeting endpoint");

    expect(result.repo).toEqual(TEST_REPOS[0]);
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
  });

  it("needs clarification on low confidence", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: null,
            confidence: "low",
            reasoning: "Message is ambiguous",
            alternatives: ["octocat/hello-world", "octocat/api-server"],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("fix the bug");

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(result.alternatives).toHaveLength(2);
  });

  it("needs clarification on medium confidence with alternatives", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: "octocat/hello-world",
            confidence: "medium",
            reasoning: "Might be hello-world",
            alternatives: ["octocat/api-server"],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("update the service");

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toEqual(TEST_REPOS[0]);
    expect(result.alternatives).toHaveLength(1);
  });

  it("does not need clarification on medium confidence without alternatives", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: "octocat/hello-world",
            confidence: "medium",
            reasoning: "Probably hello-world",
            alternatives: [],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("update the greeting");

    expect(result.needsClarification).toBe(false);
    expect(result.repo).toEqual(TEST_REPOS[0]);
  });

  it("falls back gracefully when LLM throws", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("API error"));

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("fix the bug");

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.alternatives).toBeDefined();
  });

  it("handles LLM response without tool_use block", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot classify this." }],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("random text");

    expect(result.needsClarification).toBe(true);
    expect(result.repo).toBeNull();
  });

  it("matches repo by fullName case-insensitively", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: "Octocat/Hello-World",
            confidence: "high",
            reasoning: "Matches hello-world",
            alternatives: [],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("fix hello world");

    expect(result.repo).toEqual(TEST_REPOS[0]);
  });

  it("filters matched repo from alternatives list", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "classify_repository",
          input: {
            repoId: "octocat/hello-world",
            confidence: "medium",
            reasoning: "Might be this",
            alternatives: ["octocat/hello-world", "octocat/api-server"],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("update something");

    // The matched repo should not appear in alternatives
    expect(result.alternatives?.map((r) => r.id)).not.toContain("octocat/hello-world");
    expect(result.alternatives?.map((r) => r.id)).toContain("octocat/api-server");
  });
});
