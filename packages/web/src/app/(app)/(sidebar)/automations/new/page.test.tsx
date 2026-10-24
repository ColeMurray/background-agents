// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import { MAX_AUTOMATION_NAME_LENGTH } from "@open-inspect/shared/types/automations";
import NewAutomationPage from "./page";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { invalidateAutomationCache } from "@/lib/automation-cache";

expect.extend(matchers);
afterEach(cleanup);

// Mutable per-test inputs (vi.mock factories are hoisted, so they close over these).
let search = "";
let enabledModelsValue: string[] = [DEFAULT_MODEL, "anthropic/claude-opus-4-8", "openai/gpt-5.5"];
let canCreate = true;
let sourceAutomation: Record<string, unknown> | null = null;
let sourcesById: Record<string, Record<string, unknown>> = {};
let sourceLoading = false;
let environmentsValue: Array<{
  id: string;
  name: string;
  repositories: Array<{ repoOwner: string; repoName: string }>;
  capabilities?: { canUse: boolean };
}> = [];
let environmentsError: unknown = undefined;
let reposError: unknown = undefined;
let teamsError: unknown = null;
/** Suspends search-param reads, as Next.js does before the params resolve. */
let suspendSearchParams = false;
const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (suspendSearchParams) throw new Promise(() => {});
    return new URLSearchParams(search);
  },
  useRouter: () => ({ push, replace }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/automation-cache", () => ({ invalidateAutomationCache: vi.fn() }));
vi.mock("@/components/automations/webhook-config", () => ({
  WebhookConfig: () => <div>Webhook configuration</div>,
}));

vi.mock("@/hooks/use-teams", () => ({
  useMeTeams: () => ({
    teams: [{ id: "team-1" }, { id: "team-2" }, { id: "team/one" }],
    loading: false,
    error: undefined,
  }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      canCreate && (permission === "automations.create" || permission === "sessions.create"),
    loading: false,
  }),
}));

vi.mock("@/hooks/use-automations", () => ({
  useAutomation: (id: string | undefined) => ({
    automation: id ? (sourcesById[id] ?? sourceAutomation) : null,
    loading: id ? sourceLoading : false,
    mutate: vi.fn(),
  }),
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: false, toggle: vi.fn() }),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: (enabled = true) => ({
    repos:
      !enabled || reposError
        ? []
        : [{ id: 1, owner: "acme", name: "api", fullName: "acme/api", defaultBranch: "main" }],
    loading: false,
    error: enabled ? reposError : undefined,
  }),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: (_scope: unknown, enabled = true) => ({
    environments: !enabled || environmentsError ? [] : environmentsValue,
    loading: false,
    error: enabled ? environmentsError : undefined,
  }),
}));
vi.mock("@/hooks/use-resource-teams", () => ({
  useResourceTeams: () => ({
    teams: teamsError
      ? []
      : [
          { id: "team-1", name: "Engineering" },
          { id: "team-2", name: "Design" },
        ],
    allTeams: [
      { id: "team-1", name: "Engineering" },
      { id: "team-2", name: "Design" },
    ],
    loading: false,
    error: teamsError,
    allowWorkspace: true,
  }),
}));
vi.mock("@/hooks/use-provider-accounts", () => ({
  useProviderAccounts: () => ({ accounts: [], defaults: [], loading: false }),
}));

vi.mock("@/hooks/use-branches", () => ({
  useBranches: () => ({ branches: [], loading: false }),
}));

vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({
    enabledModels: enabledModelsValue,
    enabledModelOptions: [
      {
        category: "Anthropic",
        models: [{ id: DEFAULT_MODEL, name: "Claude Sonnet 4.6", description: "" }],
      },
    ],
    loading: false,
  }),
}));

// Mirror the form's own test: render the combobox trigger contents so we can
// read the displayed repository / model without driving the dropdown.
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  search = "";
  enabledModelsValue = [DEFAULT_MODEL, "anthropic/claude-opus-4-8", "openai/gpt-5.5"];
  canCreate = true;
  sourceAutomation = null;
  sourcesById = {};
  sourceLoading = false;
  environmentsValue = [];
  environmentsError = undefined;
  reposError = undefined;
  teamsError = null;
  suspendSearchParams = false;
  replace.mockReset();
  push.mockReset();
  vi.mocked(invalidateAutomationCache).mockReset().mockResolvedValue(undefined);
  vi.mocked(browserApiFetch).mockReset();
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ automation: { id: "new-auto" } }));
});

beforeAll(() => {
  // Radix Select uses pointer capture, which jsdom lacks.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = vi.fn();
});

async function chooseTeam(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Team" }));
  await user.click(await screen.findByRole("option", { name }));
}

describe("NewAutomationPage loading", () => {
  it("shows the form skeleton while search params suspend", () => {
    suspendSearchParams = true;
    render(<NewAutomationPage />);

    expect(screen.getByRole("status", { name: "Loading automation form" })).toBeInTheDocument();
    // The collapsed-sidebar header stays up so the layout doesn't shift on load.
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Create Automation" })).not.toBeInTheDocument();
  });
});

describe("NewAutomationPage template pre-fill", () => {
  it("requires an explicit team for the auto-review replacement even when workspace creation is allowed", async () => {
    search = "template=review-new-prs&requireTeam=true";
    const user = userEvent.setup();
    const { container } = render(<NewAutomationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Repository Configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "acme/api" }));

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Select a team");
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form")!);
    expect(browserApiFetch).not.toHaveBeenCalled();

    await chooseTeam(user, "Engineering");
    fireEvent.click(screen.getByRole("button", { name: "Repository Configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "acme/api" }));
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeEnabled();
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/new-auto"));
    expect(JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body))).toMatchObject({
      teamId: "team-1",
      repositories: [{ repoOwner: "acme", repoName: "api", baseBranch: "main" }],
    });
  });

  it("prefills the replacement's scoped team without offering workspace ownership", async () => {
    search = "template=review-new-prs&teamId=team-1&requireTeam=true";
    const user = userEvent.setup();
    render(<NewAutomationPage />);

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    expect(screen.queryByRole("option", { name: "Workspace (no team)" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Design" })).toBeInTheDocument();
  });

  it("keeps ordinary review-template creation workspace-owned when the replacement flag is absent", async () => {
    search = "template=review-new-prs";
    const { container } = render(<NewAutomationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Repository Configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "acme/api" }));

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Workspace (no team)");
    expect(screen.getByRole("button", { name: "Create Automation" })).toBeEnabled();
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/new-auto"));
    expect(JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body)).teamId).toBeNull();
  });

  it.each([undefined, "team-1"])(
    "keeps navigation scope %s when the selected creation owner changes",
    async (teamId) => {
      search = `template=find-bugs${teamId ? `&teamId=${teamId}` : ""}`;
      const user = userEvent.setup();
      const { container } = render(<NewAutomationPage />);
      expect(screen.getByDisplayValue("Find bugs")).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent(
        teamId ? "Engineering" : "Workspace (no team)"
      );
      await chooseTeam(user, teamId ? "Workspace (no team)" : "Engineering");
      const scopeQuery = teamId ? "?teamId=team-1" : "";
      expect(screen.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
        "href",
        `/automations${scopeQuery}`
      );
      fireEvent.submit(container.querySelector("form")!);
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/automations/new-auto${scopeQuery}`));
      const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
      expect(body.teamId).toBe(teamId ? null : "team-1");
      expect(vi.mocked(browserApiFetch).mock.calls[0][1]?.method).toBe("POST");
      expect(invalidateAutomationCache).toHaveBeenCalledWith(expect.anything());
    }
  );

  it("follows an in-place change of the query-selected team", () => {
    search = "teamId=team-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
    search = "teamId=team-2";
    view.rerender(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Design");
    expect(screen.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
      "href",
      "/automations?teamId=team-2"
    );
  });

  it("treats the API's workspace filter sentinel as no team scope", () => {
    search = "teamId=null";
    render(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Workspace (no team)");
    expect(screen.getByRole("link", { name: "Back to automations" })).toHaveAttribute(
      "href",
      "/automations"
    );
  });

  it("preserves scope after webhook creation while allowing a different owner", async () => {
    search = "template=find-bugs&teamId=team-1";
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ automation: { id: "new-auto" }, webhookApiKey: "secret" })
    );
    const user = userEvent.setup();
    const { container } = render(<NewAutomationPage />);
    await chooseTeam(user, "Workspace (no team)");
    fireEvent.submit(container.querySelector("form")!);
    expect(await screen.findByRole("link", { name: "Go to Automation" })).toHaveAttribute(
      "href",
      "/automations/new-auto?teamId=team-1"
    );
    expect(JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body)).teamId).toBe(null);
    expect(push).not.toHaveBeenCalled();
  });

  it.each(["", "?teamId=team%2Fone"])("redirects a denied create link with scope %s", (query) => {
    search = query.slice(1);
    canCreate = false;
    render(<NewAutomationPage />);

    expect(replace).toHaveBeenCalledWith(`/automations${query}`);
    expect(screen.queryByRole("heading", { name: "Create Automation" })).not.toBeInTheDocument();
  });

  it("redirects a team-scoped create link for a team the user does not belong to", () => {
    search = "teamId=team-3";
    render(<NewAutomationPage />);

    expect(replace).toHaveBeenCalledWith("/automations?teamId=team-3");
    expect(screen.queryByRole("heading", { name: "Create Automation" })).not.toBeInTheDocument();
  });

  it("pre-fills the form from a known template and leaves the repository empty", () => {
    search = "template=find-bugs";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Find bugs")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Review the most recent commits/)).toBeInTheDocument();
    // Repository is intentionally not pre-filled.
    expect(screen.getByText("No repository")).toBeInTheDocument();
    // A hint tells the user the form was prefilled from a template.
    expect(screen.getByText(/prefilled from/i)).toBeInTheDocument();
  });

  it("renders the blank create form for an unknown template id", () => {
    search = "template=does-not-exist";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe("");
    expect(screen.queryByDisplayValue("Find bugs")).not.toBeInTheDocument();
    expect(screen.queryByText(/prefilled from/i)).not.toBeInTheDocument();
  });

  it("renders the blank create form when no template param is present", () => {
    search = "";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });

  it("coerces an unenabled suggested model to an enabled one", () => {
    // scan-vulnerabilities suggests anthropic/claude-opus-4-8; exclude it.
    enabledModelsValue = [DEFAULT_MODEL];
    search = "template=scan-vulnerabilities";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Scan codebase for vulnerabilities")).toBeInTheDocument();
    // Falls back to the enabled default model rather than the unenabled suggestion.
    expect(screen.getByText("claude sonnet 4.6")).toBeInTheDocument();
    expect(screen.queryByText("claude opus 4.8")).not.toBeInTheDocument();
  });
});

describe("NewAutomationPage duplicate", () => {
  const source = {
    id: "auto-1",
    name: "Nightly review",
    instructions: "Review yesterday's commits",
    harness: "opencode",
    triggerType: "schedule",
    scheduleCron: "30 6 * * 1",
    scheduleTz: "UTC",
    model: "openai/gpt-5.5",
    reasoningEffort: null,
    eventType: null,
    triggerConfig: null,
    repositories: [],
    environmentIds: [],
    providerSelections: {},
  };

  it("pre-fills the form from the source automation with a copy name", () => {
    sourceAutomation = source;
    search = "from=auto-1";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Nightly review (copy)")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Review yesterday's commits")).toBeInTheDocument();
    expect(screen.getByText("gpt 5.5")).toBeInTheDocument();
    expect(screen.getByText(/duplicating/i)).toBeInTheDocument();
  });

  it("keeps the source automation's owning team rather than the entry scope", () => {
    sourceAutomation = {
      ...source,
      ownerTeamId: "team-2",
      repositories: [{ repoOwner: "acme", repoName: "api", baseBranch: null }],
    };
    search = "from=auto-1&teamId=team-1";
    render(<NewAutomationPage />);

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Design");
    expect(screen.getByText("acme/api")).toBeInTheDocument();
  });

  it("trims a long source name so the copy name fits the limit", () => {
    sourceAutomation = { ...source, name: "a".repeat(MAX_AUTOMATION_NAME_LENGTH) };
    search = "from=auto-1";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toHaveLength(MAX_AUTOMATION_NAME_LENGTH);
    expect(nameInput.value.endsWith(" (copy)")).toBe(true);
  });

  it("drops half of a surrogate pair cut by the name trim", () => {
    const kept = "a".repeat(MAX_AUTOMATION_NAME_LENGTH - " (copy)".length - 1);
    sourceAutomation = { ...source, name: `${kept}\u{1F600}tail` };
    search = "from=auto-1";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe(`${kept} (copy)`);
  });

  it("keeps whole graphemes when the name trim lands inside a joined emoji", () => {
    const kept = "a".repeat(MAX_AUTOMATION_NAME_LENGTH - " (copy)".length - 2);
    sourceAutomation = { ...source, name: `${kept}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}` };
    search = "from=auto-1";
    render(<NewAutomationPage />);

    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe(`${kept} (copy)`);
  });

  it("doesn't stack copy suffixes when duplicating a copy", () => {
    sourceAutomation = { ...source, name: "Nightly review (copy)" };
    search = "from=auto-1";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Nightly review (copy)")).toBeInTheDocument();
  });

  it("starts in the entry scope without targets when the source's team isn't selectable", () => {
    sourceAutomation = {
      ...source,
      ownerTeamId: "team-archived",
      repositories: [{ repoOwner: "acme", repoName: "api", baseBranch: null }],
    };
    search = "from=auto-1&teamId=team-1";
    render(<NewAutomationPage />);

    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
    expect(screen.getByText(/can't create automations in its team/i)).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
  });

  it("follows an in-place change of the entry scope for a reset team", () => {
    sourceAutomation = { ...source, ownerTeamId: "team-archived" };
    search = "from=auto-1&teamId=team-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");

    search = "from=auto-1&teamId=team-2";
    view.rerender(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Design");
  });

  it("doesn't need the repository catalog to copy a repo-less source", () => {
    reposError = new Error("403");
    sourceAutomation = source;
    search = "from=auto-1";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Nightly review (copy)")).toBeInTheDocument();
    expect(screen.queryByText(/retrying/i)).not.toBeInTheDocument();
  });

  it("drops the source team's Slack channels when the copy changes owner", async () => {
    sourceAutomation = {
      ...source,
      ownerTeamId: "team-archived",
      triggerType: "slack_event",
      scheduleCron: null,
      triggerConfig: {
        conditions: [{ type: "slack_channel", operator: "any_of", value: ["C-team-a"] }],
      },
    };
    search = "from=auto-1&teamId=team-1";
    const { container } = render(<NewAutomationPage />);

    fireEvent.submit(container.querySelector("form")!);
    expect(screen.getByText(/require at least one Slack Channel/)).toBeInTheDocument();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("reseeds a workspace-owned copy when the URL starts requiring a team", () => {
    sourceAutomation = source;
    search = "from=auto-1&teamId=team-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Workspace");

    search = "from=auto-1&teamId=team-1&requireTeam=true";
    view.rerender(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
  });

  it("copies only the repositories the viewer can pick", async () => {
    sourceAutomation = {
      ...source,
      repositories: [
        { repoOwner: "acme", repoName: "secret", baseBranch: null },
        { repoOwner: "Acme", repoName: "API", baseBranch: null },
      ],
    };
    search = "from=auto-1";
    const { container } = render(<NewAutomationPage />);

    expect(screen.getByText(/repositories or environments you can't use/i)).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalled());
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.repositories).toEqual([{ repoOwner: "acme", repoName: "api" }]);
  });

  it("waits out a failed environment lookup instead of dropping environments", () => {
    environmentsValue = [
      { id: "env-1", name: "Usable", repositories: [], capabilities: { canUse: true } },
    ];
    environmentsError = new Error("503");
    sourceAutomation = { ...source, environmentIds: ["env-1"] };
    search = "from=auto-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/retrying/i);
    expect(screen.queryByRole("heading", { name: "Create Automation" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start from a blank form" })).toHaveAttribute(
      "href",
      "/automations/new"
    );
    expect(screen.getByRole("link", { name: "Back to automations" })).toBeInTheDocument();

    environmentsError = undefined;
    view.rerender(<NewAutomationPage />);
    expect(screen.getByDisplayValue("Nightly review (copy)")).toBeInTheDocument();
    expect(screen.queryByText(/weren't copied/i)).not.toBeInTheDocument();
  });

  it("waits out a failed team lookup before deciding whether to reset the team", () => {
    teamsError = new Error("503");
    sourceAutomation = { ...source, ownerTeamId: "team-archived" };
    search = "from=auto-1&teamId=team-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/retrying/i);

    teamsError = null;
    view.rerender(<NewAutomationPage />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Engineering");
    expect(screen.getByText(/can't create automations in its team/i)).toBeInTheDocument();
  });

  it("copies only the environments the viewer can use", async () => {
    environmentsValue = [
      { id: "env-1", name: "Usable", repositories: [], capabilities: { canUse: true } },
      { id: "env-2", name: "Locked", repositories: [], capabilities: { canUse: false } },
    ];
    sourceAutomation = { ...source, environmentIds: ["env-1", "env-2", "env-deleted"] };
    search = "from=auto-1";
    const { container } = render(<NewAutomationPage />);

    expect(screen.getByText(/repositories or environments you can't use/i)).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalled());
    const body = JSON.parse(String(vi.mocked(browserApiFetch).mock.calls[0][1]?.body));
    expect(body.environmentIds).toEqual(["env-1"]);
  });

  it("refills the form when navigation switches to another cached source", () => {
    sourcesById = {
      first: { ...source, id: "first", name: "First" },
      second: { ...source, id: "second", name: "Second" },
    };
    search = "from=first";
    const view = render(<NewAutomationPage />);
    expect(screen.getByDisplayValue("First (copy)")).toBeInTheDocument();

    search = "from=second";
    view.rerender(<NewAutomationPage />);
    expect(screen.getByDisplayValue("Second (copy)")).toBeInTheDocument();
  });

  it("keeps the user's edits when the loaded source later disappears", () => {
    sourceAutomation = source;
    search = "from=auto-1";
    const view = render(<NewAutomationPage />);
    fireEvent.change(screen.getByDisplayValue("Nightly review (copy)"), {
      target: { value: "Edited copy" },
    });

    // A focus revalidation that 404s drops the cached source.
    sourceAutomation = null;
    view.rerender(<NewAutomationPage />);
    expect(screen.getByDisplayValue("Edited copy")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the fallback form through retries and a late successful load", () => {
    search = "from=auto-1";
    const view = render(<NewAutomationPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load/i);
    fireEvent.change(screen.getByPlaceholderText("Daily code review"), {
      target: { value: "Typed by hand" },
    });

    sourceLoading = true;
    view.rerender(<NewAutomationPage />);
    sourceLoading = false;
    sourceAutomation = source;
    view.rerender(<NewAutomationPage />);
    expect(screen.getByDisplayValue("Typed by hand")).toBeInTheDocument();
  });

  it("prefers the source automation over a template", () => {
    sourceAutomation = source;
    search = "from=auto-1&template=find-bugs";
    render(<NewAutomationPage />);

    expect(screen.getByDisplayValue("Nightly review (copy)")).toBeInTheDocument();
    expect(screen.queryByText(/prefilled from/i)).not.toBeInTheDocument();
  });

  it("waits for the source before mounting the form", () => {
    sourceLoading = true;
    search = "from=auto-1";
    render(<NewAutomationPage />);

    expect(screen.queryByRole("heading", { name: "Create Automation" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading automation form" })).toBeInTheDocument();
  });

  it("falls back to a blank form when the source cannot be loaded", () => {
    search = "from=missing&template=find-bugs";
    render(<NewAutomationPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(/couldn.t load/i);
    const nameInput = screen.getByPlaceholderText("Daily code review") as HTMLInputElement;
    expect(nameInput.value).toBe("");
  });
});
