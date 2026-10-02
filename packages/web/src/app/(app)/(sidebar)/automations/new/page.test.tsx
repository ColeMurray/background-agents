// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReactNode } from "react";
import { DEFAULT_MODEL } from "@open-inspect/shared/models";
import NewAutomationPage from "./page";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { invalidateAutomationCache } from "@/lib/automation-cache";

expect.extend(matchers);
afterEach(cleanup);

// Mutable per-test inputs (vi.mock factories are hoisted, so they close over these).
let search = "";
let enabledModelsValue: string[] = [DEFAULT_MODEL, "anthropic/claude-opus-4-8", "openai/gpt-5.5"];
let canCreate = true;
const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push, replace }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/automation-cache", () => ({ invalidateAutomationCache: vi.fn() }));
vi.mock("@/components/automations/webhook-config", () => ({
  WebhookConfig: () => <div>Webhook configuration</div>,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => permission === "automations.create" && canCreate,
    loading: false,
  }),
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: false, toggle: vi.fn() }),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({ repos: [], loading: false }),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [], loading: false }),
}));
vi.mock("@/hooks/use-resource-teams", () => ({
  useResourceTeams: () => ({
    teams: [
      { id: "team-1", name: "Engineering" },
      { id: "team-2", name: "Design" },
    ],
    allTeams: [
      { id: "team-1", name: "Engineering" },
      { id: "team-2", name: "Design" },
    ],
    loading: false,
    error: null,
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

describe("NewAutomationPage template pre-fill", () => {
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
