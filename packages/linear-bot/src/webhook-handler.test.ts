import { describe, expect, it, vi, beforeEach } from "vitest";
import { escapeHtml, handleAgentSessionEvent } from "./webhook-handler";
import { lookupIssueSession } from "./kv-store";
import { fetchIssueDetails } from "./utils/linear-client";

vi.mock("./kv-store", () => ({
  lookupIssueSession: vi.fn(),
  storeIssueSession: vi.fn(),
  getProjectRepoMapping: vi.fn(() => ({})),
  getTeamRepoMapping: vi.fn(() => ({})),
  getUserPreferences: vi.fn(() => ({})),
}));

vi.mock("./utils/linear-client", () => ({
  getLinearClient: vi.fn(() => ({ accessToken: "test-token" })),
  emitAgentActivity: vi.fn(),
  fetchIssueDetails: vi.fn(),
  updateAgentSession: vi.fn(),
  getRepoSuggestions: vi.fn(() => []),
}));

vi.mock("./utils/integration-config", () => ({
  getLinearConfig: vi.fn(() => ({
    enabledRepos: null,
    model: null,
    reasoningEffort: null,
    allowUserPreferenceOverride: true,
    allowLabelModelOverride: true,
  })),
}));

vi.mock("./classifier", () => ({
  classifyRepo: vi.fn(() => ({
    repo: { owner: "org", name: "repo", fullName: "org/repo" },
    confidence: 1,
    reasoning: "LLM classification",
  })),
}));

vi.mock("./classifier/repos", () => ({
  getAvailableRepos: vi.fn(() => []),
}));

describe("escapeHtml", () => {
  it("escapes & to &amp;", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes < to &lt;", () => {
    expect(escapeHtml("a<b")).toBe("a&lt;b");
  });

  it("escapes > to &gt;", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it('escapes " to &quot;', () => {
    expect(escapeHtml('a"b')).toBe("a&quot;b");
  });

  it("returns safe strings unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("returns empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe(
      "&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;"
    );
  });

  it("does not escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("does not double-escape & in existing entities", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("Sandbox Selection Logic", () => {
  const env = {
    LINEAR_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => ({
        ok: true,
        json: async () => ({ sessionId: "sess-123" }),
      })),
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.url",
    WEB_APP_URL: "https://web.app",
    DEFAULT_MODEL: "claude-sonnet-4-5",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (lookupIssueSession as any).mockResolvedValue(null);
  });

  it("selects helm and plan mode for triage status", async () => {
    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Triage" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"helm"'),
      })
    );
  });

  it("selects helm and plan mode for backlog status", async () => {
    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Backlog" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"helm"'),
      })
    );
  });

  it("selects ec2 and apply mode for other statuses (e.g., Todo)", async () => {
    const webhook = {
      action: "prompted",
      organizationId: "org-1",
      agentSession: {
        id: "as-1",
        issue: { id: "issue-1", identifier: "ENG-1", title: "Test issue", team: { id: "team-1" } },
      },
    } as any;

    (fetchIssueDetails as any).mockResolvedValue({
      id: "issue-1",
      identifier: "ENG-1",
      title: "Test issue",
      url: "https://linear.app/issue/ENG-1",
      state: { name: "Todo" },
      labels: [],
      comments: [],
      team: { id: "team-1" },
    });

    await handleAgentSessionEvent(webhook, env, "trace-1");

    expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledWith(
      "https://internal/sessions",
      expect.objectContaining({
        body: expect.stringContaining('"sandboxProvider":"ec2"'),
      })
    );
  });
});
