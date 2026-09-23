// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@/lib/session-list";
import SessionsPage from "./page";

expect.extend(matchers);

const { mockReplace, mockUseSessionDiscovery, mockSearchParamsState, mockPermissions } = vi.hoisted(
  () => ({
    mockReplace: vi.fn(),
    mockUseSessionDiscovery: vi.fn(),
    mockSearchParamsState: { value: new URLSearchParams() },
    mockPermissions: new Set<string>(),
  })
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParamsState.value,
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: Omit<React.ComponentProps<"a">, "href"> & {
    href: string | { pathname: string; query?: Record<string, string> };
  }) => {
    const resolved =
      typeof href === "string"
        ? href
        : `${href.pathname}${
            href.query && Object.keys(href.query).length > 0
              ? `?${new URLSearchParams(href.query).toString()}`
              : ""
          }`;
    return (
      <a href={resolved} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => <div data-testid="collapsed-controls" />,
  useSidebarContext: () => ({ isOpen: true }),
}));

vi.mock("@/hooks/use-session-discovery", () => ({
  useSessionDiscovery: mockUseSessionDiscovery,
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    loading: false,
    hasPermission: (permission: string) => mockPermissions.has(permission),
  }),
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    status: "authenticated",
    data: { user: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  }),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({
    environments: [{ id: "env-1", name: "Staging" }],
    loading: false,
    error: undefined,
  }),
}));

vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [
      { id: 1, fullName: "acme/web-app", owner: "acme", name: "web-app" },
      { id: 2, fullName: "acme/api", owner: "acme", name: "api" },
    ],
    loading: false,
    error: undefined,
  }),
}));

function session(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `Session ${id}`,
    repoOwner: "acme",
    repoName: "web-app",
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    automationId: null,
    automationRunId: null,
    scmLogin: "octocat",
    userId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
    createdAt: 1_000,
    updatedAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides,
  };
}

const defaultHookResult = {
  sessions: [session("one")],
  loading: false,
  loadingMore: false,
  error: undefined,
  hasMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(),
};

function lastQuery() {
  return mockUseSessionDiscovery.mock.calls.at(-1)?.[0];
}

function lastOptions() {
  return mockUseSessionDiscovery.mock.calls.at(-1)?.[1];
}

function typeSearch(value: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
}

describe("SessionsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReplace.mockReset();
    mockSearchParamsState.value = new URLSearchParams();
    mockPermissions.clear();
    mockPermissions.add("sessions.read");
    mockPermissions.add("sessions.create");
    mockPermissions.add("repositories.read");
    mockUseSessionDiscovery.mockReset();
    mockUseSessionDiscovery.mockReturnValue(defaultHookResult);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the header, search, filters, and result rows that open the session", () => {
    mockUseSessionDiscovery.mockReturnValue({
      ...defaultHookResult,
      sessions: [
        session("multi", {
          title: "Cross-repo refactor",
          status: "active",
          environmentId: "env-1",
          repositories: [
            { repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: "main" },
            { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
            { repoOwner: "partner", repoName: "sdk", repoId: 3, baseBranch: "main" },
          ],
        }),
        session("child", {
          title: null,
          parentSessionId: "multi",
          spawnSource: "agent",
          userId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          scmLogin: null,
        }),
      ],
      hasMore: true,
    });

    render(<SessionsPage />);

    expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New session" })).toHaveAttribute("href", "/");
    expect(
      screen.getByRole("searchbox", { name: "Search sessions by title, ID or repository" })
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Creator" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Lifecycle" })).toHaveValue("nonarchived");
    expect(screen.getByRole("combobox", { name: "Origin" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 sessions · More available");

    const rows = within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("link");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute(
      "href",
      "/session/multi?repoOwner=acme&repoName=web-app&title=Cross-repo+refactor"
    );
    expect(rows[0]).toHaveTextContent("Cross-repo refactor");
    expect(rows[0]).toHaveTextContent("Active");
    expect(rows[0]).toHaveTextContent("acme/web-app");
    expect(rows[0]).toHaveTextContent("acme/api");
    expect(within(rows[0]).getByTitle("partner/sdk")).toHaveTextContent("+1");
    expect(rows[0]).toHaveTextContent("Staging");
    expect(rows[0]).toHaveTextContent("by octocat");
    expect(rows[0]).toHaveTextContent("Started by a person");
    expect(rows[0]).toHaveTextContent("2h");

    expect(rows[1]).toHaveTextContent("Untitled session");
    expect(rows[1]).toHaveTextContent("by you");
    expect(rows[1]).toHaveTextContent("Agent sub-task");
    expect(within(rows[1]).getByTitle("Spawned from session multi")).toHaveTextContent("Sub-task");

    expect(screen.getByRole("button", { name: "Load more sessions" })).toBeInTheDocument();
    expect(lastQuery()).toEqual({
      q: "",
      creator: "all",
      repository: null,
      environmentId: null,
      lifecycle: "nonarchived",
      origin: null,
    });
  });

  it("restores every control from a shared URL and keeps unknown selections visible", () => {
    mockSearchParamsState.value = new URLSearchParams(
      "q=login&createdBy=me&repoOwner=partner&repoName=sdk&environmentId=env-gone&lifecycle=archived&origin=automation"
    );
    mockUseSessionDiscovery.mockReturnValue({
      ...defaultHookResult,
      sessions: [session("archived-one", { status: "archived" })],
    });

    render(<SessionsPage />);

    expect(screen.getByRole("searchbox")).toHaveValue("login");
    expect(screen.getByRole("radio", { name: "Mine" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveValue("partner/sdk");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("env-gone");
    expect(screen.getByRole("combobox", { name: "Lifecycle" })).toHaveValue("archived");
    expect(screen.getByRole("combobox", { name: "Origin" })).toHaveValue("automation");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage archived sessions" })).toHaveAttribute(
      "href",
      "/settings?tab=data-controls"
    );
    const rows = within(screen.getByRole("list", { name: "Sessions" })).getAllByRole("link");
    expect(rows[0]).toHaveTextContent("Archived");
    expect(lastQuery()).toEqual({
      q: "login",
      creator: "mine",
      repository: { repoOwner: "partner", repoName: "sdk" },
      environmentId: "env-gone",
      lifecycle: "archived",
      origin: "automation",
    });
  });

  it("debounces search text into the URL and writes filter changes immediately", () => {
    render(<SessionsPage />);

    typeSearch("  fix login ");
    expect(mockReplace).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?q=fix+login", { scroll: false });

    // Until that navigation lands, later control changes still carry it.
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), {
      target: { value: "acme/api" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/sessions?q=fix+login&repoOwner=acme&repoName=api",
      { scroll: false }
    );

    mockSearchParamsState.value = new URLSearchParams("q=fix login&repoOwner=acme&repoName=api");
    render(<SessionsPage />);
    mockReplace.mockReset();
    const [, page] = screen.getAllByRole("combobox", { name: "Lifecycle" });
    fireEvent.change(page, { target: { value: "all" } });
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/sessions?q=fix+login&repoOwner=acme&repoName=api&lifecycle=all",
      { scroll: false }
    );
    fireEvent.change(screen.getAllByRole("combobox", { name: "Origin" })[1], {
      target: { value: "github-bot" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/sessions?q=fix+login&repoOwner=acme&repoName=api&lifecycle=all&origin=github-bot",
      { scroll: false }
    );
    fireEvent.click(screen.getAllByRole("radio", { name: "Mine" })[1]);
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/sessions?q=fix+login&createdBy=me&repoOwner=acme&repoName=api&lifecycle=all&origin=github-bot",
      { scroll: false }
    );
  });

  it("sends a reversal made before the previous navigation lands", () => {
    render(<SessionsPage />);

    // The URL still shows the default view while the first replace is in flight.
    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle" }), {
      target: { value: "all" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?lifecycle=all", { scroll: false });
    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle" }), {
      target: { value: "nonarchived" },
    });
    expect(mockReplace).toHaveBeenCalledTimes(2);
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions", { scroll: false });

    // Re-selecting the state already written is not a navigation.
    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle" }), {
      target: { value: "nonarchived" },
    });
    expect(mockReplace).toHaveBeenCalledTimes(2);
  });

  it("follows URL changes from browser navigation", () => {
    const { rerender } = render(<SessionsPage />);

    mockSearchParamsState.value = new URLSearchParams("q=weekly&lifecycle=all");
    rerender(<SessionsPage />);

    expect(screen.getByRole("searchbox")).toHaveValue("weekly");
    expect(screen.getByRole("combobox", { name: "Lifecycle" })).toHaveValue("all");
    expect(lastQuery()).toMatchObject({ q: "weekly", lifecycle: "all" });
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("clears the search and every filter back to the default view", () => {
    mockSearchParamsState.value = new URLSearchParams("q=login&origin=automation");
    render(<SessionsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?origin=automation", {
      scroll: false,
    });
    expect(screen.getByRole("searchbox")).toHaveValue("");

    mockReplace.mockReset();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions", { scroll: false });
  });

  it("shows the loading, empty, no-match, and error states without hiding the controls", () => {
    mockUseSessionDiscovery.mockReturnValue({ ...defaultHookResult, sessions: [], loading: true });
    const { rerender } = render(<SessionsPage />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading sessions");
    expect(screen.getByRole("searchbox")).toBeInTheDocument();

    mockUseSessionDiscovery.mockReturnValue({ ...defaultHookResult, sessions: [] });
    rerender(<SessionsPage />);
    expect(status).toHaveTextContent("No sessions yet");
    expect(screen.getAllByText("No sessions yet")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "New session" })).toHaveLength(2);

    mockSearchParamsState.value = new URLSearchParams("q=nothing");
    rerender(<SessionsPage />);
    // The same live region announces the no-match state; it stays mounted.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("No sessions match these filters");
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Clear filters" })).toHaveLength(2);

    const retry = vi.fn();
    mockUseSessionDiscovery.mockReturnValue({
      ...defaultHookResult,
      sessions: [session("stale")],
      error: new Error("failed"),
      retry,
    });
    rerender(<SessionsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load sessions.");
    expect(screen.getByRole("searchbox")).toHaveValue("nothing");
    expect(screen.getByText("Session stale")).toBeInTheDocument();
    expect(status).toHaveTextContent("Showing 1 session");
    expect(screen.queryByText("No sessions match these filters")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });

  it("loads more from the paging control", () => {
    const loadMore = vi.fn();
    mockUseSessionDiscovery.mockReturnValue({ ...defaultHookResult, hasMore: true, loadMore });
    render(<SessionsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Load more sessions" }));
    expect(loadMore).toHaveBeenCalled();
  });

  it("hides the controls, explains, and requests nothing when the user cannot read sessions", () => {
    mockPermissions.clear();
    render(<SessionsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You do not have permission to view sessions."
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New session" })).not.toBeInTheDocument();
    expect(lastOptions()).toEqual({ enabled: false });
  });

  it("refuses a link with unsupported filters instead of showing a wider result set", () => {
    // `status` is a valid API filter the page has no control for; `origin` is
    // a value the API itself rejects. Both refuse rather than widen the view.
    mockSearchParamsState.value = new URLSearchParams("status=archived&origin=automations");
    render(<SessionsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This link has unsupported filters (status, origin), so no sessions are shown."
    );
    expect(lastOptions()).toEqual({ enabled: false });
    expect(screen.getByRole("status")).toHaveTextContent("No sessions shown");
    expect(screen.queryByRole("list", { name: "Sessions" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions", { scroll: false });
  });

  it("keeps typed text verbatim and composes with filter changes while a navigation is in flight", () => {
    render(<SessionsPage />);

    // A trailing space is committed trimmed but never stripped from the box.
    typeSearch("fix ");
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?q=fix", { scroll: false });
    mockSearchParamsState.value = new URLSearchParams("q=fix");
    // (rerender simulates the navigation landing)
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "fix " } });
    expect(screen.getByRole("searchbox")).toHaveValue("fix ");

    // Keystrokes typed before the last navigation lands are not thrown away.
    typeSearch("fix login");
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?q=fix+login", { scroll: false });
    typeSearch("fix login now");
    expect(screen.getByRole("searchbox")).toHaveValue("fix login now");
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?q=fix+login+now", {
      scroll: false,
    });

    // A filter change carries the pending search and the previous filter change.
    fireEvent.change(screen.getByRole("combobox", { name: "Lifecycle" }), {
      target: { value: "all" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions?q=fix+login+now&lifecycle=all", {
      scroll: false,
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Origin" }), {
      target: { value: "automation" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/sessions?q=fix+login+now&lifecycle=all&origin=automation",
      { scroll: false }
    );

    // Clearing never resurrects the old filters from a late timer.
    mockReplace.mockReset();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    act(() => vi.runOnlyPendingTimers());
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenLastCalledWith("/sessions", { scroll: false });
  });
});
