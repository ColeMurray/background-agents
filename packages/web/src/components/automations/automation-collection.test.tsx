// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationListItem } from "@open-inspect/shared";
import { TeamAutomations } from "@/components/teams/team-automations";
import { AutomationCollection } from "./automation-collection";
import { browserApiFetch } from "@/lib/browser-api-fetch";

expect.extend(matchers);
afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  useAutomations: vi.fn(),
  canCreate: true,
  membership: {
    teams: [{ id: "team/one" }],
    loading: false,
    error: undefined as Error | undefined,
  },
  invalidate: vi.fn(),
}));
vi.mock("@/hooks/use-automations", () => ({ useAutomations: mocks.useAutomations }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => mocks.canCreate }),
}));
vi.mock("@/hooks/use-teams", () => ({ useMeTeams: () => mocks.membership }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/automation-cache", () => ({ invalidateAutomationCache: mocks.invalidate }));
vi.mock("swr", () => ({ useSWRConfig: () => mocks }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

const automation: AutomationListItem = {
  id: "auto-1",
  name: "Nightly review",
  instructions: "Review",
  harness: "opencode",
  triggerType: "schedule",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "openai/gpt-5.4",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdBy: "user-1",
  userId: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
  repositories: [],
  environmentIds: [],
  providerSelections: {},
  recentExecutions: [],
  capabilities: { canRead: true, canManage: true, canTrigger: true },
};
const list = {
  automations: [automation],
  loading: false,
  loadingMore: false,
  error: undefined as Error | undefined,
  hasMore: false,
  loadMore: vi.fn(),
  mutate: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canCreate = true;
  mocks.membership = { teams: [{ id: "team/one" }], loading: false, error: undefined };
  mocks.useAutomations.mockReturnValue(list);
  mocks.invalidate.mockResolvedValue(undefined);
  vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}));
});

describe("automation collection", () => {
  it("scopes the team tab's request and row navigation", () => {
    render(<TeamAutomations teamId="team/one" />);
    expect(screen.getByRole("link", { name: "Nightly review" })).toHaveAttribute(
      "href",
      "/automations/auto-1?teamId=team%2Fone"
    );
    expect(mocks.useAutomations).toHaveBeenCalledWith("", "team/one");
  });

  it("does not show an empty-state creation prompt after a failed initial load", () => {
    mocks.useAutomations.mockReturnValue({ ...list, automations: [], error: new Error("failed") });
    render(<TeamAutomations teamId="team/one" />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No automations yet.")).not.toBeInTheDocument();
  });

  it.each(["permission", "nonmember", "loading", "error"])(
    "gates both team creation entry points on %s",
    (failure) => {
      mocks.useAutomations.mockReturnValue({ ...list, automations: [] });
      if (failure === "permission") mocks.canCreate = false;
      if (failure === "nonmember") mocks.membership.teams = [];
      if (failure === "loading") mocks.membership.loading = true;
      if (failure === "error") mocks.membership.error = new Error("failed");
      render(<TeamAutomations teamId="team/one" />);
      expect(screen.queryByRole("link", { name: "Create Automation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start from a template" })).not.toBeInTheDocument();
    }
  );

  it("does not require team membership for the unscoped collection", () => {
    mocks.membership = { teams: [], loading: true, error: new Error("failed") };
    mocks.useAutomations.mockReturnValue({ ...list, automations: [] });
    render(<AutomationCollection>{() => null}</AutomationCollection>);
    expect(screen.getByRole("link", { name: "Create Automation" })).toHaveAttribute(
      "href",
      "/automations/new"
    );
  });

  it("keeps team creation and template links scoped in the empty state", () => {
    mocks.useAutomations.mockReturnValue({ ...list, automations: [] });
    render(<TeamAutomations teamId="team/one" />);
    for (const link of screen.getAllByRole("link", { name: "Create Automation" })) {
      expect(link).toHaveAttribute("href", "/automations/new?teamId=team%2Fone");
    }
    expect(screen.getByRole("link", { name: "Start from a template" })).toHaveAttribute(
      "href",
      "/automations/templates?teamId=team%2Fone"
    );
  });

  it.each([
    ["pause", "Pause", "/pause", "POST"],
    ["resume", "Resume", "/resume", "POST"],
    ["trigger", "Trigger", "/trigger", "POST"],
    ["delete", "Delete", "", "DELETE"],
  ])("dispatches %s and invalidates its resource", async (action, label, suffix, method) => {
    mocks.useAutomations.mockReturnValue({
      ...list,
      automations: [{ ...automation, enabled: action !== "resume" }],
    });
    render(<TeamAutomations teamId="team/one" />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    if (action === "delete") {
      expect(browserApiFetch).not.toHaveBeenCalled();
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" })
      );
    }
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledWith(mocks, "auto-1"));
    expect(browserApiFetch).toHaveBeenCalledWith(`/api/automations/auto-1${suffix}`, { method });
  });

  it("reports action failure and clears it on a successful retry", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({}, { status: 403 }));
    render(<TeamAutomations teamId="team/one" />);
    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to trigger automation");
    expect(mocks.invalidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledWith(mocks, "auto-1"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
