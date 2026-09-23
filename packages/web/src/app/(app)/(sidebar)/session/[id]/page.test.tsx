// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { memo, useEffect, useRef, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { SafeMarkdown } from "@/components/safe-markdown";
import SessionPage from "./page";

const { mockUseMediaQuery } = vi.hoisted(() => ({ mockUseMediaQuery: vi.fn() }));

const manifest: SessionDiffManifest = {
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
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("./session-snapshot-provider", () => ({
  useSessionSnapshot: () => ({
    session: {
      id: "session-1",
      repoOwner: "acme",
      repoName: "web",
      title: "Session",
      harness: "opencode",
    },
  }),
}));

vi.mock("@/hooks/use-session-socket", () => ({
  useSessionSocket: () => ({
    connected: true,
    connecting: false,
    reconnecting: false,
    ready: true,
    presenceSynced: true,
    authError: null,
    connectionError: null,
    sessionState: null,
    sandboxError: null,
    boot: null,
    events: [],
    participants: [],
    artifacts: [],
    currentParticipantId: null,
    canManageBudget: false,
    isProcessing: false,
    promptQueue: [],
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    stopExecution: vi.fn(),
    recoverShutdown: vi.fn(),
    sendTyping: vi.fn(),
    reconnect: vi.fn(),
    loadOlderEvents: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts: {} }),
}));
vi.mock("@/hooks/use-mark-session-read", () => ({ useMarkSessionRead: vi.fn() }));
vi.mock("@/hooks/use-session-skills", () => ({
  useSessionSkills: () => ({ suggestions: [] }),
}));
vi.mock("@/hooks/use-session-participant-profiles", () => ({
  useSessionParticipantProfiles: () => ({ profiles: {}, participants: [] }),
}));
vi.mock("@/hooks/use-session-rename", () => ({
  useSessionRename: () => ({ optimisticTitle: null, renameSession: vi.fn() }),
}));
vi.mock("@/hooks/use-enabled-models", () => ({
  useEnabledModels: () => ({ enabledModels: [], enabledModelOptions: [], loading: false }),
}));
vi.mock("@/hooks/use-prompt-input", () => ({
  usePromptInput: () => ({
    prompt: "",
    sessionAttachments: {
      attachments: [],
      attachmentError: null,
      isUploading: false,
      addFiles: vi.fn(),
      removeAttachment: vi.fn(),
    },
    inputRef: { current: null },
    isSubmitting: false,
    submitError: null,
    setSubmitError: vi.fn(),
    handleSubmit: vi.fn(),
    handleInputValueChange: vi.fn(),
    handleKeyDown: vi.fn(),
    restorePrompt: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-session-diffs", () => ({
  useSessionDiffs: () => ({
    state: { version: 1, current: manifest, lastError: null, unavailableReason: null },
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: mockUseMediaQuery }));
vi.mock("@/hooks/use-session-details-sidebar", () => ({
  useSessionDetailsSidebar: () => ({ isOpen: true, toggle: vi.fn() }),
}));
vi.mock("@/hooks/use-browser-layout-storage", () => ({
  useBrowserLayoutStorage: () => ({ getItem: () => null, setItem: vi.fn() }),
}));

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));

// Memoized like the timeline's EventItem, so page re-renders keep the rendered link.
const AssistantMessage = memo(function AssistantMessage() {
  return <SafeMarkdown content="Updated [src/app.ts](src/app.ts)." linkRepositoryFiles />;
});

vi.mock("@/components/session-timeline", () => ({
  SessionTimeline: () => <AssistantMessage />,
}));

// Mirrors the changed-file rows the details sidebar keeps in the DOM.
vi.mock("@/components/session-right-sidebar", () => ({
  SessionRightSidebar: () => (
    <button type="button" data-diff-repository-position="0" data-diff-path="src/app.ts">
      Sidebar src/app.ts
    </button>
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

vi.mock("@/components/session-header", () => ({ SessionHeader: () => null }));
vi.mock("@/components/session-details-overlay", () => ({ SessionDetailsOverlay: () => null }));
vi.mock("@/components/session-prompt-composer", () => ({ SessionPromptComposer: () => null }));
vi.mock("@/components/queued-prompt-stack", () => ({ QueuedPromptStack: () => null }));
vi.mock("@/components/media-lightbox", () => ({ MediaLightbox: () => null }));
vi.mock("@/components/sandbox-shutdown-banner", () => ({ SandboxShutdownBanner: () => null }));
vi.mock("@/components/terminal-panel", () => ({ TerminalPanel: () => null }));

beforeEach(() => {
  mockUseMediaQuery.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionPage changed-file links", () => {
  it.each([
    ["the desktop changes panel", false],
    ["the mobile changes sheet", true],
  ])("returns focus to the timeline link after closing %s", async (_surface, isBelowLg) => {
    mockUseMediaQuery.mockReturnValue(isBelowLg);
    const user = userEvent.setup();
    render(<SessionPage />);

    const link = screen.getByRole("button", { name: "src/app.ts" });
    await user.click(link);
    await user.click(await screen.findByRole("button", { name: "Close changes" }));

    await waitFor(() => expect(link).toHaveFocus());
  });
});
