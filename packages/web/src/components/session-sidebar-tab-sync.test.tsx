// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "./session-sidebar";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  handleSessionArchived: vi.fn(async () => undefined),
  handleSessionRenamed: vi.fn(),
  closeSession: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

const session = {
  id: "session-1",
  title: "Original title",
  repoOwner: "open-inspect",
  repoName: "background-agents",
};

vi.mock("next/navigation", () => ({ usePathname: () => "/session/session-1" }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { name: "Test User" } } }),
  signOut: vi.fn(),
}));
vi.mock("@/hooks/use-media-query", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/use-environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("@/hooks/use-sidebar-sessions", () => ({
  useSidebarSessions: () => ({
    sessions: [session],
    activeSessions: [session],
    inactiveSessions: [],
    childrenMap: new Map(),
    loading: false,
    loadingMore: false,
    sessionsError: null,
    sessionCreatorFilter: "all",
    setSessionCreatorFilter: vi.fn(),
    scrollContainerRef: { current: null },
    maybeLoadMoreSessions: vi.fn(),
    handleSessionArchived: mocks.handleSessionArchived,
    handleSessionRenamed: mocks.handleSessionRenamed,
  }),
}));
vi.mock("@/components/session-tabs", () => ({
  useSessionTabs: () => ({
    closeSession: mocks.closeSession,
    navigate: vi.fn(),
    updateSessionTitle: mocks.updateSessionTitle,
  }),
}));
vi.mock("@/components/session-with-children", () => ({
  SessionWithChildren: ({
    onArchive,
    onSessionRenamed,
  }: {
    onArchive: (sessionId: string) => Promise<void>;
    onSessionRenamed: (sessionId: string, title: string) => void;
  }) => (
    <>
      <button type="button" onClick={() => void onArchive("session-1")}>
        Archive test session
      </button>
      <button type="button" onClick={() => onSessionRenamed("session-1", "Updated title")}>
        Rename test session
      </button>
    </>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionSidebar tab synchronization", () => {
  it("updates the tab after a sidebar rename", () => {
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Rename test session" }));

    expect(mocks.handleSessionRenamed).toHaveBeenCalledWith("session-1", "Updated title");
    expect(mocks.updateSessionTitle).toHaveBeenCalledWith("session-1", "Updated title");
  });

  it("closes the tab after a sidebar archive", async () => {
    render(<SessionSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Archive test session" }));
    await vi.waitFor(() => expect(mocks.closeSession).toHaveBeenCalledWith("session-1"));
  });
});
