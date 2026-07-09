import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Environment, RepoConfig } from "../types";

const {
  mockMessagesCreate,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetRoutingRules,
  mockGetAvailableEnvironments,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetRoutingRules: vi.fn(),
  mockGetAvailableEnvironments: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  // vitest 4 only treats `function`/`class` implementations as constructable;
  // an arrow function here throws "is not a constructor" on `new Anthropic()`.
  default: vi.fn().mockImplementation(function () {
    return {
      messages: {
        create: mockMessagesCreate,
      },
    };
  }),
}));

vi.mock("./repos", () => ({
  getAvailableRepos: mockGetAvailableRepos,
  buildRepoDescriptions: mockBuildRepoDescriptions,
  getRoutingRules: mockGetRoutingRules,
}));

vi.mock("./environments", () => ({
  getAvailableEnvironments: mockGetAvailableEnvironments,
  // Imported by targets.ts (via ../targets); unused in these tests.
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

const TEST_ENVIRONMENT: Environment = {
  id: "env_abc123",
  name: "full-stack",
  description: null,
  prebuildEnabled: false,
  createdAt: 1,
  updatedAt: 1,
  repositories: [
    { repoOwner: "acme", repoName: "prod", repoId: 1, baseBranch: "main" },
    { repoOwner: "acme", repoName: "web", repoId: 2, baseBranch: "main" },
  ],
};

const TEST_ENV = {
  ANTHROPIC_API_KEY: "test-api-key",
  CLASSIFICATION_MODEL: "claude-haiku-4-5",
} as Env;

/** The classified repo's fullName, or undefined for null/environment targets. */
function classifiedRepoFullName(result: {
  target: { kind: string; repo?: { fullName: string } } | null;
}): string | undefined {
  return result.target?.kind === "repository" ? result.target.repo?.fullName : undefined;
}

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
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
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts", undefined, "trace-1");

    expect(classifiedRepoFullName(result)).toBe("acme/prod");
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

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toBeUndefined();
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

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toBeUndefined();
  });

  describe("routing rules", () => {
    it("routes deterministically when a keyword matches, without calling the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("please fix the frontend nav bug", undefined, "t");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(result.confidence).toBe("high");
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).toContain("routing rule");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("asks for clarification when rules point at multiple distinct repos", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "prod", target: "acme/prod" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fix the frontend on prod");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(
        result.alternatives?.map((t) => (t.kind === "repository" ? t.repo.fullName : "")).sort()
      ).toEqual(["acme/prod", "acme/web"]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("routes once when multiple keywords map to the same repo", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "ui", target: "acme/web" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend ui cleanup");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(result.needsClarification).toBe(false);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("skips a rule whose target is not accessible and falls through to the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/ghost" }]);
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: "tool_use",
            id: "toolu_x",
            name: "classify_repository",
            input: {
              repoId: "acme/web",
              confidence: "high",
              reasoning: "Mentions frontend.",
              alternatives: [],
            },
          },
        ],
      });

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockMessagesCreate).toHaveBeenCalledOnce();
    });

    it("falls through to the LLM when no rule keyword is present", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: "tool_use",
            id: "toolu_y",
            name: "classify_repository",
            input: {
              repoId: "acme/prod",
              confidence: "high",
              reasoning: "Mentions prod.",
              alternatives: [],
            },
          },
        ],
      });

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("update the deployment config");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(mockMessagesCreate).toHaveBeenCalledOnce();
    });

    it("takes precedence over a channel association", async () => {
      // Channel maps to acme/prod, but an explicit keyword maps to acme/web.
      mockGetAvailableRepos.mockResolvedValue([
        { ...TEST_REPOS[0], channelAssociations: ["C123"] },
        TEST_REPOS[1],
      ]);
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend tweak", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("routes to an environment when an environment-targeted keyword matches", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack login flow", undefined, "t");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(result.confidence).toBe("high");
      expect(result.needsClarification).toBe(false);
      expect(result.reasoning).toContain("full-stack");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("escapes the environment name in the mrkdwn reasoning", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "deploy", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([
        { ...TEST_ENVIRONMENT, name: "<!channel> & co" },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("deploy the app");

      expect(result.reasoning).toContain("&lt;!channel&gt; &amp; co");
      expect(result.reasoning).not.toContain("<!channel>");
    });

    it("does not fetch environments when no matched rule targets one", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("frontend tweak");

      expect(mockGetAvailableEnvironments).not.toHaveBeenCalled();
    });

    it("routes an environment rule even when only one repository is available", async () => {
      // The single-repo shortcut must not shadow an explicit environment rule.
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack login flow");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("asks for clarification when rules resolve to a repo and an environment", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "frontend", target: "acme/web" },
        { keyword: "fullstack", target: "env_abc123", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend or fullstack?");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.alternatives).toEqual([
        { kind: "repository", repo: TEST_REPOS[1] },
        { kind: "environment", environment: TEST_ENVIRONMENT },
      ]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("skips a rule whose environment no longer exists and falls through to the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_deleted", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: "tool_use",
            id: "toolu_z",
            name: "classify_repository",
            input: {
              repoId: "acme/web",
              confidence: "high",
              reasoning: "Mentions the web app.",
              alternatives: [],
            },
          },
        ],
      });

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack web app issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockMessagesCreate).toHaveBeenCalledOnce();
    });
  });

  describe("channel associations", () => {
    it("routes to the repository associated with the channel, without the LLM", async () => {
      mockGetAvailableRepos.mockResolvedValue([
        { ...TEST_REPOS[0], channelAssociations: ["C123"] },
        TEST_REPOS[1],
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toContain("associated with repository acme/prod");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("routes to the environment associated with the channel", async () => {
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toContain("associated with environment full-stack");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("escapes the environment name in the mrkdwn reasoning", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([
        { ...TEST_ENVIRONMENT, name: "<!channel> & co", channelAssociations: ["C123"] },
      ]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.reasoning).toContain("&lt;!channel&gt; &amp; co");
      expect(result.reasoning).not.toContain("<!channel>");
    });

    it("routes an environment association even when only one repository is available", async () => {
      // The single-repo shortcut must not shadow the channel's environment.
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("asks for clarification when the channel maps to a repo and an environment", async () => {
      const associatedRepo = { ...TEST_REPOS[0], channelAssociations: ["C123"] };
      mockGetAvailableRepos.mockResolvedValue([associatedRepo, TEST_REPOS[1]]);
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.alternatives).toEqual([
        { kind: "environment", environment },
        { kind: "repository", repo: associatedRepo },
      ]);
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("falls through to the LLM when several repositories share the channel", async () => {
      // The LLM sees channel associations as a prompt signal and can arbitrate
      // between repositories — only environments force a clarification.
      mockGetAvailableRepos.mockResolvedValue(
        TEST_REPOS.map((repo) => ({ ...repo, channelAssociations: ["C123"] }))
      );
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: "tool_use",
            id: "toolu_c",
            name: "classify_repository",
            input: {
              repoId: "acme/web",
              confidence: "high",
              reasoning: "Mentions the web app.",
              alternatives: [],
            },
          },
        ],
      });

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("web app issue", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockMessagesCreate).toHaveBeenCalledOnce();
    });

    it("does not consult environments for messages outside a channel context", async () => {
      mockMessagesCreate.mockResolvedValue({
        content: [
          {
            type: "tool_use",
            id: "toolu_d",
            name: "classify_repository",
            input: {
              repoId: "acme/web",
              confidence: "high",
              reasoning: "Mentions the web app.",
              alternatives: [],
            },
          },
        ],
      });

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("web app issue");

      expect(mockGetAvailableEnvironments).not.toHaveBeenCalled();
    });
  });
});
