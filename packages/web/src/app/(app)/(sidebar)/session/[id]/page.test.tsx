// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Component, memo, useEffect, useRef, type PropsWithChildren, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import type { SessionDiffState } from "@open-inspect/shared/types/session-diffs";
import { SafeMarkdown } from "@/components/safe-markdown";
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
  timeline: vi.fn(),
  diffState: null as SessionDiffState | null,
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
  useSessionDiffs: () => ({ state: mocks.diffState, isLoading: false }),
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
vi.mock("@/components/session-timeline", () => ({ SessionTimeline: mocks.timeline }));
vi.mock("@/components/media-lightbox", () => ({ MediaLightbox: () => null }));
vi.mock("@/components/queued-prompt-stack", () => ({ QueuedPromptStack: () => null }));
vi.mock("@/components/session-desktop-layout", () => ({
  SessionDesktopLayout: ({
    workspace,
    sidebar,
    changes,
  }: {
    workspace: ReactNode;
    sidebar: ReactNode;
    changes: ReactNode;
  }) => (
    <>
      <div hidden={Boolean(changes)}>{workspace}</div>
      {changes}
      {sidebar}
    </>
  ),
}));
// Like the real panel, it takes focus when it opens.
vi.mock("@/components/session-changes-panel", () => ({
  SessionChangesPanel: function ChangesPanel({ onClose }: { onClose: () => void }) {
    const ref = useRef<HTMLElement>(null);
    useEffect(() => ref.current?.focus(), []);
    return (
      <section ref={ref} tabIndex={-1} aria-label="Session changes">
        <button type="button" onClick={onClose}>
          Close changes
        </button>
      </section>
    );
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.diffState = null;
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
    mocks.timeline,
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
  localStorage.clear();
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

it("opens phone media on Info without replacing the remembered inspector tab", async () => {
  localStorage.setItem("open-inspect-session-inspector-tab", "changes");
  mocks.mobile = true;
  render(<SessionPage />);
  await waitFor(() => expect(mocks.overlay.mock.lastCall?.[0].activeTab).toBe("changes"));
  expect(mocks.overlay.mock.lastCall?.[0].open).toBe(false);

  act(() => mocks.header.mock.lastCall?.[0].onOpenMobileMedia());

  expect(mocks.overlay.mock.lastCall?.[0]).toMatchObject({ open: true, activeTab: "info" });
  expect(localStorage.getItem("open-inspect-session-inspector-tab")).toBe("changes");
});

it("keeps desktop actions available without collaboration and refreshes sidebar and overlay scope", () => {
  const { rerender } = render(<SessionPage />);
  expect(mocks.composer).not.toHaveBeenCalled();
  expect(mocks.actionBar.mock.lastCall?.[0]).toMatchObject({
    capabilities: { collaborate: false, changeVisibility: true, manageCollaborators: true },
  });
  expect(mocks.sidebar.mock.lastCall?.[0].scope.ownerTeamId).toBe("team_design");

  mocks.snapshot = {
    ...mocks.snapshot!,
    session: {
      ...mocks.snapshot!.session,
      visibility: "team",
      collaborators: [],
    },
  };
  mocks.mobile = true;
  rerender(<SessionPage />);
  for (const scope of [
    mocks.sidebar.mock.lastCall?.[0].scope,
    mocks.overlay.mock.lastCall?.[0].scope,
  ]) {
    expect(scope).toMatchObject({
      ownerTeamId: "team_design",
      visibility: "team",
      collaborators: [],
      onUpdated: mocks.refreshSnapshot,
    });
  }
});

// Memoized like the timeline's EventItem, so page re-renders keep the rendered link.
const AssistantMessage = memo(function AssistantMessage() {
  return <SafeMarkdown content="Updated [src/app.ts](src/app.ts)." linkRepositoryFiles />;
});

it.each([
  ["the desktop changes panel", false],
  ["the mobile changes sheet", true],
])("returns focus to the timeline file link after closing %s", async (_surface, mobile) => {
  mocks.mobile = mobile;
  mocks.diffState = {
    version: 1,
    current: {
      version: 1,
      revisionId: "revision-1",
      capturedAt: 100,
      triggerMessageId: null,
      repositories: [
        {
          status: "ready",
          position: 0,
          repoOwner: "acme",
          repoName: "web",
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          truncated: false,
          omittedFileCount: 0,
          files: [
            {
              id: "file-1",
              path: "src/app.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              renderState: "renderable",
            },
          ],
        },
      ],
    },
    lastError: null,
    unavailableReason: null,
  };
  mocks.timeline.mockImplementation(() => <AssistantMessage />);
  // The details sidebar lists the same file; below lg it is not on screen.
  mocks.sidebar.mockImplementation(() => (
    <button
      type="button"
      hidden={mobile}
      data-diff-repository-position="0"
      data-diff-path="src/app.ts"
    >
      Sidebar src/app.ts
    </button>
  ));
  // jsdom has no layout, so offsetParent stands in for "rendered".
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.closest("[hidden]") ? null : document.body;
  });
  const user = userEvent.setup();
  render(<SessionPage />);

  const link = screen.getByRole("button", { name: "src/app.ts" });
  await user.click(link);
  await user.click(await screen.findByRole("button", { name: "Close changes" }));

  await waitFor(() => expect(link).toHaveFocus());
});
