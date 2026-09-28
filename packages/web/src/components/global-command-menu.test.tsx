// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@/lib/session-list";
import { GlobalCommandMenu } from "./global-command-menu";

expect.extend(matchers);

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  repoImagesEnabled: true,
  allowedPermissions: null as Set<string> | null,
}));

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ labels: { "new-session": "Cmd/Ctrl+Shift+O" } }),
}));

vi.mock("@/lib/sandbox-provider", () => ({
  supportsRepoImages: () => mocks.repoImagesEnabled,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      mocks.allowedPermissions === null || mocks.allowedPermissions.has(permission),
  }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  mocks.repoImagesEnabled = true;
  mocks.allowedPermissions = null;
  vi.unstubAllGlobals();
});

function renderMenu(sessions: SessionListItem[] = []) {
  const onOpenChange = vi.fn();
  const onNavigate = vi.fn();
  const props = {
    onOpenChange,
    onNavigate,
    onNewSession: vi.fn(),
    sessions,
  };
  const view = render(<GlobalCommandMenu open {...props} />);
  return { ...view, onNavigate, onOpenChange, props };
}

describe("GlobalCommandMenu", () => {
  it("shows complete navigation with descriptions", () => {
    renderMenu();

    expect(screen.getByText("Start a coding session")).toBeInTheDocument();
    expect(
      screen.getByText("Ask a question or describe what you want to build")
    ).toBeInTheDocument();
    expect(screen.getByText("Configure Open Inspect")).toBeInTheDocument();
    expect(screen.getByText("Manage scheduled and event-triggered work")).toBeInTheDocument();
    expect(
      screen.getByText("View usage across sessions, repositories, and users")
    ).toBeInTheDocument();
  });

  it("omits session creation destinations without session creation permission", () => {
    mocks.allowedPermissions = new Set();

    renderMenu();

    expect(screen.queryByText("New session")).not.toBeInTheDocument();
    expect(screen.queryByText("Home")).not.toBeInTheDocument();
    expect(screen.queryByText("Start a coding session")).not.toBeInTheDocument();
  });

  it("omits application destinations without their read permissions", () => {
    mocks.allowedPermissions = new Set();

    renderMenu();

    expect(screen.queryByText("Automations")).not.toBeInTheDocument();
    expect(screen.queryByText("Analytics")).not.toBeInTheDocument();
    expect(screen.getByText("Configure Open Inspect")).toBeInTheDocument();
  });

  it("selects Analytics from the keyboard", async () => {
    const user = userEvent.setup();
    const { onNavigate, onOpenChange } = renderMenu();
    const input = screen.getByRole("combobox", {
      name: "Search commands, settings, and sessions",
    });

    await user.type(input, "analytics{Enter}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigate).toHaveBeenCalledWith("/analytics");
  });

  it("shows keyboard guidance and updates the result count", async () => {
    const user = userEvent.setup();
    renderMenu();
    const input = screen.getByRole("combobox", {
      name: "Search commands, settings, and sessions",
    });
    const count = screen.getByRole("status");

    // The "Search all sessions" handoff is an ordinary counted result.
    expect(screen.getByRole("option", { name: /Search all sessions/ })).toBeVisible();
    expect(count).toHaveTextContent(`${screen.getAllByRole("option").length} results`);
    expect(screen.getByText("Navigate")).toBeInTheDocument();
    expect(screen.getByText("Select")).toBeInTheDocument();
    expect(screen.getByText("Close")).toBeInTheDocument();

    await user.type(input, "no matching command destination");

    // Nothing recent matches, so the handoff is the one honest result: it is
    // counted, the empty state does not contradict it, and it is selected.
    await waitFor(() => expect(count).toHaveTextContent("1 result"));
    expect(screen.queryByText("No results found.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Search all sessions/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("reaches the exhaustive search from the keyboard when nothing recent matches", async () => {
    const user = userEvent.setup();
    const { onNavigate, onOpenChange } = renderMenu();
    const input = screen.getByRole("combobox", {
      name: "Search commands, settings, and sessions",
    });

    await user.type(input, "old archived work{Enter}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigate).toHaveBeenCalledWith("/sessions?q=old+archived+work");
  });

  it("keeps genuine matches ahead of the handoff in keyboard order", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderMenu();
    const input = screen.getByRole("combobox", {
      name: "Search commands, settings, and sessions",
    });

    await user.type(input, "sessions");

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Sessions");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options.at(-1)).toHaveTextContent("Search all sessions");

    await user.keyboard("{End}{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("/sessions?q=sessions");
  });

  it("navigates directly to a settings destination", async () => {
    const user = userEvent.setup();
    const { onNavigate, onOpenChange } = renderMenu();

    await user.click(screen.getByText("Appearance"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigate).toHaveBeenCalledWith("/settings?tab=appearance");
  });

  it("searches settings labels, descriptions, and keywords", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(
      screen.getByPlaceholderText("Quick search · recent sessions, settings, and commands"),
      "request source"
    );

    await waitFor(() => expect(screen.getByText("Source control")).toBeInTheDocument());
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
  });

  it("does not show unrelated fuzzy settings matches", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(
      screen.getByPlaceholderText("Quick search · recent sessions, settings, and commands"),
      "theme"
    );

    await waitFor(() => expect(screen.getByText("Appearance")).toBeInTheDocument());
    expect(screen.queryByText("Source control")).not.toBeInTheDocument();
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
  });

  it("clears settings filtering when the controlled dialog closes", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderMenu();
    await user.type(
      screen.getByPlaceholderText("Quick search · recent sessions, settings, and commands"),
      "theme"
    );
    expect(screen.queryByText("Source control")).not.toBeInTheDocument();

    rerender(<GlobalCommandMenu open={false} {...props} />);
    rerender(<GlobalCommandMenu open {...props} />);

    await waitFor(() => expect(screen.getByText("Source control")).toBeInTheDocument());
  });

  it("omits unavailable settings destinations", () => {
    mocks.repoImagesEnabled = false;
    renderMenu();

    expect(screen.queryByText("Images")).not.toBeInTheDocument();
  });

  it("omits settings destinations the user cannot view", () => {
    mocks.allowedPermissions = new Set(["models.preferences.manage"]);
    renderMenu();

    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.queryByText("Secrets")).not.toBeInTheDocument();
  });

  it("requires repository read access for the repository secrets destination", () => {
    mocks.allowedPermissions = new Set(["repositories.secrets.manage"]);
    const { rerender, props } = renderMenu();

    expect(screen.queryByText("Secrets")).not.toBeInTheDocument();

    mocks.allowedPermissions.add("repositories.read");
    rerender(<GlobalCommandMenu open {...props} />);

    expect(screen.getByText("Secrets")).toBeInTheDocument();
  });

  it("preserves order-independent session search", async () => {
    const user = userEvent.setup();
    renderMenu([
      {
        id: "session-1",
        title: "Investigate command search",
        repoOwner: "open-inspect",
        repoName: "background-agents",
        harness: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: "main",
        status: "active",
        parentSessionId: null,
        spawnSource: "user",
        spawnDepth: 0,
        automationId: null,
        automationRunId: null,
        scmLogin: null,
        userId: null,
        totalCost: 0,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
        environmentId: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    await user.type(
      screen.getByPlaceholderText("Quick search · recent sessions, settings, and commands"),
      "background investigate"
    );

    await waitFor(() => expect(screen.getByText("Investigate command search")).toBeInTheDocument());
  });
});

describe("GlobalCommandMenu search-all handoff", () => {
  it("labels the fetched set as recent and carries typed text to the Sessions page", async () => {
    const user = userEvent.setup();
    const { onNavigate, onOpenChange } = renderMenu([
      {
        id: "session-1",
        title: "Investigate command search",
        repoOwner: "open-inspect",
        repoName: "background-agents",
        harness: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: null,
        baseBranch: "main",
        status: "active",
        parentSessionId: null,
        spawnSource: "user",
        spawnDepth: 0,
        automationId: null,
        automationRunId: null,
        scmLogin: null,
        userId: null,
        totalCost: 0,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
        environmentId: null,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    expect(screen.getByText("Recent sessions")).toBeInTheDocument();
    expect(screen.getByText("Find past and current work across full history")).toBeInTheDocument();

    const input = screen.getByRole("combobox", {
      name: "Search commands, settings, and sessions",
    });
    await user.type(input, "old archived work");

    // The handoff survives a search that matches no recent session.
    await waitFor(() =>
      expect(screen.getByText('Search full history for "old archived work"')).toBeVisible()
    );
    expect(screen.getByText("Search all sessions")).toBeVisible();
    expect(screen.queryByText("Investigate command search")).not.toBeInTheDocument();

    await user.click(screen.getByText("Search all sessions"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onNavigate).toHaveBeenCalledWith("/sessions?q=old+archived+work");
  });

  it("omits the search-all handoff and Sessions destination without session read permission", () => {
    mocks.allowedPermissions = new Set(["sessions.create"]);

    renderMenu();

    expect(screen.queryByText("Search all sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
  });
});
