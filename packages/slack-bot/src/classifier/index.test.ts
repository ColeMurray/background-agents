import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RepoConfig } from "../types";

const {
  mockFetch,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetReposByChannel,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetReposByChannel: vi.fn(),
}));

vi.stubGlobal("fetch", mockFetch);

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
  AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
  AWS_REGION: "us-east-1",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
} as Env;

function mockBedrockResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetReposByChannel.mockResolvedValue([]);
    mockBuildRepoDescriptions.mockResolvedValue("- acme/prod\n- acme/web");
  });

  it("uses tool output when provider returns valid structured classification", async () => {
    mockFetch.mockResolvedValue(
      mockBedrockResponse({
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
            },
          },
        ],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts", undefined, "trace-1");

    expect(result.repo?.fullName).toBe("acme/prod");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("bedrock-runtime.us-east-1.amazonaws.com"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-bearer-token",
        }),
      })
    );
  });

  it("asks for clarification when tool payload is invalid", async () => {
    mockFetch.mockResolvedValue(
      mockBedrockResponse({
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
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please update prod deployment config");

    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toHaveLength(2);
  });

  it("asks for clarification when tool output is missing", async () => {
    mockFetch.mockResolvedValue(
      mockBedrockResponse({
        content: [
          {
            type: "text",
            text: '{"repoId":"acme/web","confidence":"high","reasoning":"Mentions frontend and UI.","alternatives":[]}',
          },
        ],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("frontend UI issue in web app");

    expect(result.repo).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toHaveLength(2);
  });
});
