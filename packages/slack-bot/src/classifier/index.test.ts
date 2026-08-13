import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";

const {
  mockFetch,
  mockGetAvailableRepos,
  mockBuildRepoDescriptions,
  mockGetRoutingRules,
  mockGetAvailableEnvironments,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAvailableRepos: vi.fn(),
  mockBuildRepoDescriptions: vi.fn(),
  mockGetRoutingRules: vi.fn(),
  mockGetAvailableEnvironments: vi.fn(),
}));

vi.stubGlobal("fetch", mockFetch);

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

import { CLASSIFICATION_REQUEST_TIMEOUT_MS, RepoClassifier } from "./index";

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
  OPENAI_API_KEY: "test-api-key",
  CLASSIFICATION_MODEL: "gpt-5.4-mini",
} as Env;

/** The classified repo's fullName, or undefined for null/environment targets. */
function classifiedRepoFullName(result: {
  target: { kind: string; repo?: { fullName: string } } | null;
}): string | undefined {
  return result.target?.kind === "repository" ? result.target.repo?.fullName : undefined;
}

/** A successful OpenAI chat-completions response carrying structured JSON content. */
function openAIResponse(input: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(input) } }],
    }),
  } as Response;
}

interface SentOpenAIRequestBody {
  model: string;
  temperature: number;
  max_completion_tokens: number;
  messages: Array<{ role: string; content: string }>;
  response_format: {
    type: string;
    json_schema: {
      name: string;
      strict: boolean;
      schema: {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: Record<string, { type?: unknown; enum?: unknown; items: { type?: unknown } }>;
      };
    };
  };
}

/** The parsed JSON body of the most recent request sent to `fetch`. */
function sentRequestBody(): SentOpenAIRequestBody {
  // Test-only reflection of the request we ourselves serialized above; not
  // externally-controlled input, so an unchecked cast is the right tool.
  const call = mockFetch.mock.calls[0] as [string, { body: string }];
  return JSON.parse(call[1].body) as SentOpenAIRequestBody;
}

describe("RepoClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableRepos.mockResolvedValue(TEST_REPOS);
    mockGetRoutingRules.mockResolvedValue([]);
    mockGetAvailableEnvironments.mockResolvedValue([]);
    mockBuildRepoDescriptions.mockResolvedValue("- acme/prod\n- acme/web");
  });

  it("uses model output when provider returns valid structured classification", async () => {
    mockFetch.mockResolvedValue(
      openAIResponse({
        targetId: "acme/prod",
        confidence: "high",
        reasoning: "The message explicitly mentions prod.",
        alternatives: [],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts", undefined, "trace-1");

    expect(classifiedRepoFullName(result)).toBe("acme/prod");
    expect(result.confidence).toBe("high");
    expect(result.needsClarification).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("sends the verified OpenAI structured-output request contract", async () => {
    mockFetch.mockResolvedValue(
      openAIResponse({
        targetId: "acme/prod",
        confidence: "high",
        reasoning: "The message explicitly mentions prod.",
        alternatives: [],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    await classifier.classify("please fix prod slack alerts");

    const body = sentRequestBody();
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(2000);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.name).toBe("classify_target");

    // Strict mode rejects a schema that omits additionalProperties:false or
    // leaves any property out of `required`, and the nullable targetId is what
    // lets the model say "unclear" instead of inventing a target. Assert the
    // shape, not just the strict flag, so a schema regression can't stay green.
    const schema = body.response_format.json_schema.schema;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["targetId", "confidence", "reasoning", "alternatives"])
    );
    expect(schema.required).toHaveLength(4);
    expect(schema.properties.targetId.type).toEqual(["string", "null"]);
    expect(schema.properties.confidence.enum).toEqual(["high", "medium", "low"]);
    expect(schema.properties.alternatives.type).toBe("array");
    expect(schema.properties.alternatives.items.type).toBe("string");
  });

  it("degrades to the clarification picker when OpenAI returns a non-2xx response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal server error",
    } as Response);

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts");

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("bounds the classification request and degrades when it times out", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    mockFetch.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please fix prod slack alerts");

    // A stalled or queued provider request must not hold the Slack thread open;
    // the picker is the cheap, correct outcome.
    expect(result.needsClarification).toBe(true);
    expect(result.target).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFICATION_REQUEST_TIMEOUT_MS);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    // Identity, not just shape: some other signal would leave the fetch unbounded.
    expect(init?.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  it("asks for clarification when structured output is invalid", async () => {
    mockFetch.mockResolvedValue(
      openAIResponse({
        targetId: "acme/prod",
        confidence: "certain",
        reasoning: "Totally sure",
        alternatives: [],
      })
    );

    const classifier = new RepoClassifier(TEST_ENV);
    const result = await classifier.classify("please update prod deployment config");

    expect(result.target).toBeNull();
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("structured model output");
    expect(result.alternatives).toBeUndefined();
  });

  it("asks for clarification when response content is missing", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    } as Response);

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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips a rule whose target is not accessible and falls through to the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/ghost" }]);
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions frontend.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("frontend issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("falls through to the LLM when no rule keyword is present", async () => {
      mockGetRoutingRules.mockResolvedValue([{ keyword: "frontend", target: "acme/web" }]);
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "acme/prod",
          confidence: "high",
          reasoning: "Mentions prod.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("update the deployment config");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(mockFetch).toHaveBeenCalledOnce();
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips a rule whose environment no longer exists and falls through to the LLM", async () => {
      mockGetRoutingRules.mockResolvedValue([
        { keyword: "fullstack", target: "env_deleted", targetType: "environment" },
      ]);
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("fullstack web app issue");

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("routes to the environment associated with the channel", async () => {
      const environment = { ...TEST_ENVIRONMENT, channelAssociations: ["C123"] };
      mockGetAvailableEnvironments.mockResolvedValue([environment]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything", { channelId: "C123" });

      expect(result.target).toEqual({ kind: "environment", environment });
      expect(result.confidence).toBe("high");
      expect(result.reasoning).toContain("associated with environment full-stack");
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls through to the LLM when several repositories share the channel", async () => {
      // The LLM sees channel associations as a prompt signal and can arbitrate
      // between repositories — only environments force a clarification.
      mockGetAvailableRepos.mockResolvedValue(
        TEST_REPOS.map((repo) => ({ ...repo, channelAssociations: ["C123"] }))
      );
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("web app issue", { channelId: "C123" });

      expect(classifiedRepoFullName(result)).toBe("acme/web");
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe("LLM environment candidates", () => {
    it("offers environments to the LLM and resolves a returned environment id", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockFetch.mockResolvedValue(
        openAIResponse({
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
      const prompt = sentRequestBody().messages[0].content;
      expect(prompt).toContain("## Available Environments");
      expect(prompt).toContain("env_abc123");
      expect(prompt).toContain("full-stack");
    });

    it("omits the environments prompt section when none exist", async () => {
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "acme/web",
          confidence: "high",
          reasoning: "Mentions the web app.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      await classifier.classify("web app issue");

      const prompt = sentRequestBody().messages[0].content;
      expect(prompt).not.toContain("## Available Environments");
    });

    it("resolves an environment echoed by name instead of id", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockFetch.mockResolvedValue(
        openAIResponse({
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
      mockFetch.mockResolvedValue(
        openAIResponse({
          targetId: "env_abc123",
          confidence: "high",
          reasoning: "Spans several repositories.",
          alternatives: [],
        })
      );

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("touch everything");

      expect(result.target).toEqual({ kind: "environment", environment: TEST_ENVIRONMENT });
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("keeps the single-repo shortcut when no environments exist", async () => {
      mockGetAvailableRepos.mockResolvedValue([TEST_REPOS[0]]);

      const classifier = new RepoClassifier(TEST_ENV);
      const result = await classifier.classify("anything at all");

      expect(classifiedRepoFullName(result)).toBe("acme/prod");
      expect(result.reasoning).toBe("Only one repository is available.");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("resolves mixed alternatives, deduplicated and excluding the match", async () => {
      mockGetAvailableEnvironments.mockResolvedValue([TEST_ENVIRONMENT]);
      mockFetch.mockResolvedValue(
        openAIResponse({
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
      mockFetch.mockResolvedValue(
        openAIResponse({
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("escapes the LLM reasoning for mrkdwn rendering", async () => {
      mockFetch.mockResolvedValue(
        openAIResponse({
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
});
