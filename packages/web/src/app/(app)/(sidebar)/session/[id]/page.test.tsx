// @vitest-environment jsdom

import { Component, type PropsWithChildren, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { resolveSessionCapabilities } from "@/lib/session-capabilities";
import SessionPage from "./page";

const mocks = vi.hoisted(() => ({
  socket: vi.fn(),
  prompt: vi.fn(),
  refreshSnapshot: vi.fn(),
  actionBar: vi.fn(),
  header: vi.fn(),
  sidebar: vi.fn(),
  overlay: vi.fn(),
  composer: vi.fn(),
  snapshot: null as SessionSnapshot | null,
  mobile: false,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./session-snapshot-provider", () => ({
  useSessionSnapshot: () => mocks.snapshot,
  useRefreshSessionSnapshot: () => mocks.refreshSnapshot,
}));
vi.mock("@/hooks/use-session-socket", () => ({ useSessionSocket: mocks.socket }));
vi.mock("@/hooks/use-prompt-input", () => ({ usePromptInput: mocks.prompt }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts: {} }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));
vi.mock("@/hooks/use-mark-session-read", () => ({ useMarkSessionRead: vi.fn() }));
vi.mock("@/hooks/use-session-participant-profiles", () => ({
  useSessionParticipantProfiles: () => ({ profiles: new Map(), participants: [] }),
}));
vi.mock("@/hooks/use-session-skills", () => ({
  useSessionSkills: () => ({ suggestions: [] }),
}));
vi.mock("@/hooks/use-session-rename", () => ({
  useSessionRename: () => ({ optimisticTitle: null, renameSession: vi.fn() }),
}));
vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({ enabledModels: [], enabledModelOptions: [], loading: false }),
}));
vi.mock("@/hooks/use-session-diffs", () => ({
  useSessionDiffs: () => ({ state: null, isLoading: false }),
}));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => mocks.mobile }));
vi.mock("@/hooks/use-session-details-sidebar", () => ({
  useSessionDetailsSidebar: () => ({ isOpen: true, toggle: vi.fn() }),
}));
vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Panel: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Separator: () => null,
}));
vi.mock("@/components/action-bar", () => ({ ActionBar: mocks.actionBar }));
vi.mock("@/components/session-header", () => ({ SessionHeader: mocks.header }));
vi.mock("@/components/session-right-sidebar", () => ({ SessionRightSidebar: mocks.sidebar }));
vi.mock("@/components/session-details-overlay", () => ({ SessionDetailsOverlay: mocks.overlay }));
vi.mock("@/components/session-prompt-composer", () => ({ SessionPromptComposer: mocks.composer }));
vi.mock("@/components/session-timeline", () => ({ SessionTimeline: () => null }));
vi.mock("@/components/media-lightbox", () => ({ MediaLightbox: () => null }));
vi.mock("@/components/queued-prompt-stack", () => ({ QueuedPromptStack: () => null }));
vi.mock("@/components/session-desktop-layout", () => ({
  SessionDesktopLayout: ({ workspace, sidebar }: { workspace: ReactNode; sidebar: ReactNode }) => (
    <>
      {workspace}
      {sidebar}
    </>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.snapshot = {
    session: {
      id: "session-1",
      title: "Cached secret",
      harness: "opencode",
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      branchName: null,
      status: "active",
      sandboxStatus: "ready",
      messageCount: 0,
      createdAt: 1,
      ownerTeamId: "team_design",
      ownerUserId: "user_owner",
      visibility: "private",
      collaborators: ["user_collaborator"],
      capabilities: {
        canRead: true,
        canCollaborate: false,
        canManageLifecycle: false,
        canDelete: false,
        canMove: true,
        canManageCollaborators: true,
        canChangeVisibility: true,
        canSandbox: false,
      },
    },
    artifacts: [],
    timeline: { events: [], hasMore: false, cursor: null },
    promptQueue: [],
  };
  mocks.socket.mockReturnValue({
    sessionGone: false,
    sessionState: mocks.snapshot.session,
    capabilities: resolveSessionCapabilities(mocks.snapshot.session.capabilities, true),
    events: [],
    participants: [],
    artifacts: [],
    promptQueue: [],
    canManageBudget: false,
  });
  mocks.prompt.mockReturnValue({
    sessionAttachments: { isUploading: false, attachments: [] },
    inputRef: { current: null },
  });
  mocks.refreshSnapshot.mockResolvedValue(undefined);
  for (const component of [
    mocks.actionBar,
    mocks.header,
    mocks.sidebar,
    mocks.overlay,
    mocks.composer,
  ]) {
    component.mockReturnValue(null);
  }
});

class NotFoundBoundary extends Component<PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error?.message === "NEXT_NOT_FOUND") return <p>404 Not Found</p>;
    if (this.state.error) return <p>Generic unavailable</p>;
    return this.props.children;
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders the existing not-found path before cached session content or action hooks", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.socket.mockReturnValue({ sessionGone: true });
  render(
    <NotFoundBoundary>
      <SessionPage />
    </NotFoundBoundary>
  );
  expect(screen.queryByText("404 Not Found")).not.toBeNull();
  expect(screen.queryByText("Cached secret")).toBeNull();
  expect(screen.queryByText("Generic unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  expect(mocks.prompt).not.toHaveBeenCalled();
});

it("keeps desktop actions available to a mover without collaboration and forwards refreshed scope everywhere", () => {
  const { rerender } = render(<SessionPage />);
  expect(mocks.composer).not.toHaveBeenCalled();
  expect(mocks.actionBar.mock.lastCall?.[0]).toMatchObject({
    capabilities: { move: true, collaborate: false },
    scope: {
      ownerTeamId: "team_design",
      visibility: "private",
      collaborators: ["user_collaborator"],
      onUpdated: mocks.refreshSnapshot,
    },
  });
  expect(mocks.header.mock.lastCall?.[0].actions.scope.onUpdated).toBe(mocks.refreshSnapshot);
  expect(mocks.sidebar.mock.lastCall?.[0].scope.ownerTeamId).toBe("team_design");

  mocks.snapshot = {
    ...mocks.snapshot!,
    session: {
      ...mocks.snapshot!.session,
      ownerTeamId: "team_new",
      visibility: "team",
      collaborators: [],
    },
  };
  mocks.mobile = true;
  rerender(<SessionPage />);
  for (const scope of [
    mocks.actionBar.mock.lastCall?.[0].scope,
    mocks.header.mock.lastCall?.[0].actions.scope,
    mocks.sidebar.mock.lastCall?.[0].scope,
    mocks.overlay.mock.lastCall?.[0].scope,
  ]) {
    expect(scope).toMatchObject({
      ownerTeamId: "team_new",
      visibility: "team",
      collaborators: [],
      onUpdated: mocks.refreshSnapshot,
    });
  }
});
