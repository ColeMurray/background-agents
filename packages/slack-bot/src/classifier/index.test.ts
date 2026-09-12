import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";
import {
  CLASSIFICATION_REQUEST_TIMEOUT_MS,
  OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS,
} from "@open-inspect/shared/classification";

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

vi.mock("./environments", async (importOriginal) => ({
  // Keep the pure exports (buildEnvironmentDescriptions) real; mock the fetchers.
  ...((await importOriginal()) as object),
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
    // buildRepoDescriptions is synchronous — a resolved-value mock would interpolate
    // "[object Promise]" into the prompt instead of the repository list.
    mockBuildRepoDescriptions.mockReturnValue("- acme/prod\n- acme/web");
  });

  it("uses tool output when provider returns valid structured classification", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_target",
          input: {
            targetId: "acme/prod",
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
          name: "classify_target",
        }),
        tools: [expect.objectContaining({ name: "classify_target" })],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const prompt = mockMessagesCreate.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("## Available Repositories\n- acme/prod\n- acme/web");
  });

  it("asks for clarification when tool payload is invalid", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "classify_target",
          input: {
            targetId: "acme/prod",
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
          text: '{"targetId":"acme/web","confidence":"high","reasoning":"Mentions frontend and UI.","alternatives":[]}',
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

  it("parses null targetId from structured model output", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_null",
          name: "classify_target",
          input: {
            targetId: null,
            confidence: "medium",
            reasoning: "The request could refer to either repo.",
            alternatives: ["acme/prod", "acme/web"],
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix the app");

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("medium");
    expect(result.needsClarification).toBe(true);
    expect(
      result.alternatives?.map((t) => (t.kind === "repository" ? t.repo.fullName : "")).sort()
    ).toEqual(["acme/prod", "acme/web"]);
  });

  it("rejects partial structured model output", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          id: "toolu_partial",
          name: "classify_target",
          input: {
            targetId: "acme/prod",
            confidence: "high",
            reasoning: "Mentions prod.",
          },
        },
      ],
    });

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod");

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
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
            name: "classify_target",
            input: {
              targetId: "acme/web",
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
            name: "classify_target",
            input: {
              targetId: "acme/prod",
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

    it("loads the target catalog exactly once per classification", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("frontend tweak");

      expect(mockGetAvailableRepos).toHaveBeenCalledOnce();
      expect(mockGetAvailableEnvironments).toHaveBeenCalledOnce();
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
            name: "classify_target",
            input: {
              targetId: "acme/web",
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
            name: "classify_target",
            input: {
              targetId: "acme/web",
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
  });

  describe("LLM environment candidates", () => {
    function llmResponse(input: Record<string, unknown>) {
      return {
        content: [{ type: "tool_use", id: "toolu_llm", name: "classify_target", input }],
      };
    }

    function sentPrompt(): string {
      return mockMessagesCreate.mock.calls[0][0].messages[0].content as string;
    }

    it("offers environments to the LLM and resolves a returned environment id", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "env_abc123",
          confidence: "high",
          reasoning: "Spans both repositories of the full-stack environment.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("update login across web and prod");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(result.needsClarification).toBe(false);
      expect(sentPrompt()).toContain("## Available Environments");
      expect(sentPrompt()).toContain("env_abc123");
      expect(sentPrompt()).toContain("full-stack");
    });

    it("omits the environments prompt section when none exist", async () => {
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("web app issue");

      expect(sentPrompt()).not.toContain("## Available Environments");
    });

    it("resolves an environment echoed by name instead of id", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "Full-Stack",
          confidence: "high",
          reasoning: "Names the environment.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("work on full-stack");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
    });

    it("suppresses the single-repo shortcut when environments exist", async () => {
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "env_abc123",
          confidence: "high",
          reasoning: "Spans several repositories.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("touch everything");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(mockMessagesCreate).toHaveBeenCalledOnce();
    });

    it("keeps the single-repo shortcut when no environments exist", async () => {
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything at all");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.reasoning).toBe("Only one repository is available.");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("resolves mixed alternatives, deduplicated and excluding the match", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "acme/prod",
          confidence: "medium",
          reasoning: "Probably prod, could be broader.",
          alternatives: ["env_abc123", "acme/web", "ACME/WEB", "acme/prod", "env_gone"],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("deploy the service");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.alternatives).toEqual([
        { kind: "environment", environment: TEST_ENVIRONMENT },
        { kind: "repository", repo: TEST_REPOS[1] },
      ]);
      expect(result.needsClarification).toBe(true);
    });

    it("still classifies into environments when the repo list is empty", async () => {
      // A degraded repo fetch (fail-open []) must not strand intact environments.
      mockGetAvailableRepos.mockResolvedValue([]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "env_abc123",
          confidence: "high",
          reasoning: "Names the environment.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("work on full-stack");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
    });

    it("asks for clarification when neither repos nor environments exist", async () => {
      mockGetAvailableRepos.mockResolvedValue([]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything");

      expect(result.target).toBeNull();
      expect(result.reasoning).toBe("No repositories or environments are currently available.");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it("escapes the LLM reasoning for mrkdwn rendering", async () => {
      mockMessagesCreate.mockResolvedValue(
        llmResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions <!channel> & the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("web app issue");

      expect(result.reasoning).toBe("Mentions &lt;!channel&gt; &amp; the web app.");
    });
  });

  describe("provider selection", () => {
    // These tests stub the global fetch; restore it so anything added after
    // this block doesn't inherit a stale stub.
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function openAiEnv(overrides: Partial<Env> = {}): Env {
      return {
        ...TEST_ENV,
        CLASSIFICATION_MODEL: "gpt-5.4-mini",
        OPENAI_API_KEY: "test-openai-key",
        ...overrides,
      } as Env;
    }

    function openAiFetchResponse(content: Record<string, unknown>, status = 200): Response {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
        { status }
      );
    }

    it("sends the OpenAI chat-completions contract for a gpt-* model", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        openAiFetchResponse({
          targetId: "acme/prod",
          confidence: "high",
          reasoning: "Mentions prod.",
          alternatives: [],
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const classifier = new RepoClassifier(openAiEnv());
      const result = await classifier.classify("please fix prod slack alerts");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer test-openai-key",
        "Content-Type": "application/json",
      });

      const body = JSON.parse(init.body as string);
      // The bare model id — no "openai/" prefix reaches the wire.
      expect(body.model).toBe("gpt-5.4-mini");
      // gpt-5-family models accept only the default temperature and reject an
      // explicit value with HTTP 400 `unsupported_value`.
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_completion_tokens).toBe(OPENAI_CLASSIFICATION_MAX_COMPLETION_TOKENS);
      // gpt-5.x rejects `max_tokens` outright ("Unsupported parameter").
      expect(body).not.toHaveProperty("max_tokens");

      const jsonSchema = body.response_format.json_schema;
      expect(jsonSchema.name).toBe("classify_target");
      expect(jsonSchema.strict).toBe(true);
      expect(jsonSchema.schema.additionalProperties).toBe(false);
      expect(jsonSchema.schema.required).toEqual([
        "targetId",
        "confidence",
        "reasoning",
        "alternatives",
      ]);
      expect(jsonSchema.schema.properties.targetId.type).toEqual(["string", "null"]);
    });

    it("degrades to the picker on a non-2xx OpenAI response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }))
      );

      const classifier = new RepoClassifier(openAiEnv());
      const result = await classifier.classify("please fix prod slack alerts");

      expect(result.target).toBeNull();
      expect(result.confidence).toBe("low");
      expect(result.needsClarification).toBe(true);
      expect(result.reasoning).toContain("structured model output");
    });

    it("bounds the Anthropic classification request with a timeout and degrades to the picker when it fires", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      mockMessagesCreate.mockRejectedValue(
        Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("please fix prod slack alerts");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.reasoning).toContain("structured model output");
      expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFICATION_REQUEST_TIMEOUT_MS);
      const [, options] = mockMessagesCreate.mock.calls[0] as [unknown, { signal?: unknown }];
      // Identity, not just shape: attaching some other signal would pass an
      // instanceof check while leaving the request effectively unbounded.
      expect(options?.signal).toBe(timeoutSpy.mock.results[0]?.value);
    });

    it("degrades to the picker for an unrecognized model prefix without calling either provider", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const classifier = new RepoClassifier({
        ...TEST_ENV,
        CLASSIFICATION_MODEL: "mistral-large-latest",
      } as Env);
      const result = await classifier.classify("please fix prod slack alerts");

      expect(result.target).toBeNull();
      expect(result.needsClarification).toBe(true);
      expect(result.reasoning).toContain("structured model output");
      expect(mockMessagesCreate).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      {
        binding: "OPENAI_API_KEY",
        model: "gpt-5.4-mini",
        overrides: { OPENAI_API_KEY: undefined },
      },
      {
        binding: "ANTHROPIC_API_KEY",
        model: "claude-haiku-4-5",
        overrides: { ANTHROPIC_API_KEY: undefined },
      },
    ])(
      "degrades to the picker without calling out when $model is selected but $binding is unbound",
      async ({ model, overrides }) => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const classifier = new RepoClassifier({
          ...TEST_ENV,
          CLASSIFICATION_MODEL: model,
          ...overrides,
        } as Env);
        const result = await classifier.classify("please fix prod slack alerts");

        expect(result.target).toBeNull();
        expect(result.needsClarification).toBe(true);
        expect(result.reasoning).toContain("structured model output");
        expect(mockMessagesCreate).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      }
    );
  });
});
