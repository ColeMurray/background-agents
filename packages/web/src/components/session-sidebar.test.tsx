// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionSidebar } from "./session-sidebar";

expect.extend(matchers);

const { mockHook, authorization } = vi.hoisted(() => ({
  mockHook: vi.fn(),
  authorization: { permissions: null as Set<string> | null },
}));

vi.mock("@/hooks/use-sidebar-sessions", () => ({ useSidebarSessions: mockHook }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { name: "Test User", email: "test@example.com" } } }),
  signOut: vi.fn(),
}));
vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      authorization.permissions === null || authorization.permissions.has(permission),
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

function session(id: string, title: string, parentSessionId: string | null = null) {
  return {
    id,
    title,
    repoOwner: "open-inspect",
    repoName: "open-inspect",
    model: "test-model",
    reasoningEffort: null,
    baseBranch: "main",
    status: "active" as const,
    parentSessionId,
    spawnSource: parentSessionId ? ("agent" as const) : ("user" as const),
    spawnDepth: parentSessionId ? 1 : 0,
    automationId: null,
    automationRunId: null,
    scmLogin: "octocat",
    userId: "user_test",
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
    readState: { latestMessageId: null, version: 0, unread: false } as const,
    createdAt: 1,
    updatedAt: 2,
  };
}

const noPagination = {
  hasMore: false,
  loadingMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(async () => undefined),
};

beforeEach(() => {
  authorization.permissions = null;
  const attention = session("attention", "Needs review");
  const running = session("running", "Implementing inbox");
  const child = session("child", "Checking tests", running.id);
  const recent = { ...session("recent", "Finished work"), status: "completed" as const };
  mockHook.mockReturnValue({
    needsAttention: [attention],
    inProgress: [running],
    finished: [recent],
    childrenMap: new Map([[running.id, [child]]]),
    loading: false,
    sessionsError: undefined,
    refreshSnapshot: vi.fn(async () => undefined),
    sectionPagination: {
      needsAttention: noPagination,
      inProgress: noPagination,
      finished: noPagination,
    },
    sessionCreatorFilter: "all",
    setSessionCreatorFilter: vi.fn(),
    handleSessionArchived: vi.fn(),
    handleMarkLatestMessageRead: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionSidebar", () => {
  it("renders the shared application destinations", () => {
    render(<SessionSidebar />);

    expect(screen.getByTitle("Settings")).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: "Automations" })).toHaveAttribute(
      "href",
      "/automations"
    );
    expect(screen.getByRole("link", { name: "Analytics" })).toHaveAttribute("href", "/analytics");
  });

  it("hides application destinations without their canonical read permission", () => {
    authorization.permissions = new Set(["automations.read"]);

    render(<SessionSidebar />);

    expect(screen.getByRole("link", { name: "Automations" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Analytics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New session/ })).not.toBeInTheDocument();
  });

  it("renders server-classified sections and nested descendants", () => {
    render(<SessionSidebar />);

    expect(screen.getByRole("heading", { name: "Needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
    expect(screen.getByText("Checking tests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Signed in as Test User" })).toBeInTheDocument();
  });

  it("loads more only in the requested section", () => {
    const value = mockHook();
    const loadMoreRunning = vi.fn();
    mockHook.mockReturnValue({
      ...value,
      sectionPagination: {
        ...value.sectionPagination,
        inProgress: { hasMore: true, loadingMore: false, loadMore: loadMoreRunning },
      },
    });
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Load more in progress" }));
    expect(loadMoreRunning).toHaveBeenCalledOnce();
  });

  it("keeps archived sessions accessible", () => {
    render(<SessionSidebar />);
    expect(screen.getByRole("link", { name: /Archived/ })).toHaveAttribute(
      "href",
      "/settings?tab=data-controls"
    );
  });

  it("shows a retry action when one category fails", () => {
    const value = mockHook();
    const retry = vi.fn(async () => undefined);
    mockHook.mockReturnValue({
      ...value,
      sessionsError: new Error("attention unavailable"),
      sectionPagination: {
        ...value.sectionPagination,
        needsAttention: { ...noPagination, error: new Error("attention unavailable"), retry },
      },
    });
    render(<SessionSidebar />);

    expect(screen.getByText("Unable to load needs attention")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeInTheDocument();
  });

  it("surfaces a retryable error when the initial snapshot fails", () => {
    const value = mockHook();
    const refreshSnapshot = vi.fn(async () => undefined);
    mockHook.mockReturnValue({
      ...value,
      needsAttention: [],
      inProgress: [],
      finished: [],
      childrenMap: new Map(),
      sessionsError: new Error("snapshot unavailable"),
      refreshSnapshot,
    });
    render(<SessionSidebar />);

    expect(screen.getByText("Unable to load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshSnapshot).toHaveBeenCalledOnce();
  });
});
