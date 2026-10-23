// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComponentProps, ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SessionSnapshot, SessionState } from "@open-inspect/shared/types/server-messages";
import type { SessionDiffState } from "@open-inspect/shared/types/session-diffs";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { SessionDetailsOverlay } from "./session-details-overlay";
import { SessionRightSidebar } from "./session-right-sidebar";
import { SessionScopeProvider } from "./session-scope-provider";
import { useSessionInspectorTab } from "@/hooks/use-session-inspector-tab";
import { resolveSessionCapabilities, type SessionCapabilities } from "@/lib/session-capabilities";
import type { SessionScopeControls } from "@/lib/session-scope";
import {
  SessionSnapshotProvider,
  useRefreshSessionSnapshot,
  useSessionSnapshot,
} from "@/app/(app)/(sidebar)/session/[id]/session-snapshot-provider";

function render(ui: ReactNode) {
  return renderView(ui, { wrapper: SessionScopeProvider });
}

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/hooks/use-teams", () => ({
  useTeam: () => ({ team: { name: "Design", slug: "design" } }),
  useTeamMembers: () => ({ members: [{ userId: "user_owner" }], loading: false, error: undefined }),
}));
vi.mock("@/hooks/use-session-collaborator-candidates", () => ({
  useSessionCollaboratorCandidates: () => ({
    candidates: [
      { userId: "user_added", displayName: "New collaborator", email: null, avatarUrl: null },
    ],
    loading: false,
    error: undefined,
  }),
}));

vi.mock("swr", () => ({
  default: () => ({ data: undefined }),
  useSWRConfig: () => ({
    fetcher: undefined,
    mutate: vi.fn().mockResolvedValue(undefined),
    cache: new Map(),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(browserApiFetch).mockReset();
  vi.stubGlobal(
    "URL",
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn(() => "blob:session-trace"),
      revokeObjectURL: vi.fn(),
    })
  );
});

afterEach(() => {
  cleanup();
  // The inspector remembers the last tab; start every case on the default.
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
  exportTrace: true,
  delete: true,
  manageCollaborators: false,
  changeVisibility: false,
};

type SidebarProps = Omit<ComponentProps<typeof SessionRightSidebar>, "activeTab" | "onTabChange">;
type OverlayProps = Omit<ComponentProps<typeof SessionDetailsOverlay>, "activeTab" | "onTabChange">;

// The session page owns the inspector tab; these stand in for it.
function Sidebar(props: SidebarProps) {
  const { tab, selectTab } = useSessionInspectorTab();
  return <SessionRightSidebar {...props} activeTab={tab} onTabChange={selectTab} />;
}

function Overlay(props: OverlayProps) {
  const { tab, selectTab } = useSessionInspectorTab();
  return <SessionDetailsOverlay {...props} activeTab={tab} onTabChange={selectTab} />;
}

// Radix tabs activate on mousedown (or focus), not on click.
function selectTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

const SESSION: SessionState = {
  id: "session-1",
  title: "Review session",
  repoOwner: "northstar/developer-platform/documentation",
  repoName: "internal-developer-portal",
  baseBranch: "main",
  branchName: null,
  status: "active",
  sandboxStatus: "ready",
  harness: "opencode",
  messageCount: 0,
  createdAt: 1,
};
const EMPTY_DIFF: SessionDiffState = {
  version: 1,
  current: null,
  lastError: null,
  unavailableReason: null,
};
const READY_DIFF: SessionDiffState = {
  ...EMPTY_DIFF,
  current: {
    version: 1,
    revisionId: "revision-1",
    triggerMessageId: null,
    capturedAt: 1,
    repositories: [
      {
        position: 0,
        repoOwner: SESSION.repoOwner!,
        repoName: SESSION.repoName!,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        status: "ready",
        truncated: false,
        omittedFileCount: 0,
        files: [
          {
            id: "file-1",
            path: "src/components/navigation.tsx",
            status: "modified",
            additions: 2,
            deletions: 1,
            renderState: "renderable",
          },
        ],
      },
    ],
  },
};

function inspector(overrides: Partial<SidebarProps> = {}) {
  return (
    <Sidebar
      sessionId="session-1"
      sessionState={SESSION}
      participants={[]}
      presenceSynced
      events={[]}
      artifacts={[]}
      onOpenMedia={vi.fn()}
      onOpenDiff={vi.fn()}
      diffState={EMPTY_DIFF}
      capabilities={FULL_CAPABILITIES}
      {...overrides}
    />
  );
}

describe("SessionRightSidebar", () => {
  const sessionState: SessionState = {
    id: "session-1",
    title: null,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    branchName: null,
    status: "active",
    sandboxStatus: "ready",
    harness: "opencode",
    messageCount: 0,
    createdAt: 1,
    totalCost: 3,
    maxSessionCostUsd: 10,
  };

  it("shows authoritative team and visibility in desktop and mobile details", () => {
    const scope: SessionScopeControls = {
      ownerTeamId: "team_design",
      ownerUserId: "user_owner",
      visibility: "private",
      collaborators: ["user_collaborator"],
      onUpdated: vi.fn().mockResolvedValue(undefined),
    };
    const props = {
      sessionId: "session-1",
      sessionState,
      participants: [],
      presenceSynced: false,
      events: [],
      artifacts: [],
      onOpenMedia: vi.fn(),
      scope,
      capabilities: { ...FULL_CAPABILITIES, changeVisibility: true, manageCollaborators: true },
    };
    const { rerender } = render(<Sidebar {...props} />);
    selectTab("Info");
    expect(screen.getByRole("link", { name: "Design" })).toHaveAttribute("href", "/teams/design");
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Visibility" })).toBeInTheDocument();
    expect(screen.getByText("Unnamed user \u00b7 orator")).toBeInTheDocument();
    expect(screen.queryByText("user_collaborator")).not.toBeInTheDocument();
    rerender(<Overlay {...props} open isPhone onOpenChange={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Design" })).toBeInTheDocument();
    expect(screen.getByText("Unnamed user \u00b7 orator")).toBeInTheDocument();
    rerender(
      <Overlay {...props} capabilities={FULL_CAPABILITIES} open isPhone onOpenChange={vi.fn()} />
    );
    expect(screen.queryByRole("combobox", { name: "Visibility" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unnamed user \u00b7 orator")).not.toBeInTheDocument();
  });

  it.each(["visibility", "collaborator add", "collaborator remove"])(
    "preserves acknowledged %s recovery when desktop details remount as mobile",
    async (operation) => {
      const user = userEvent.setup();
      const initial: SessionSnapshot = {
        session: {
          ...SESSION,
          ownerTeamId: "team_design",
          ownerUserId: "user_owner",
          visibility: "private",
          collaborators: ["user_collaborator"],
          capabilities: {
            canRead: true,
            canCollaborate: true,
            canManageLifecycle: true,
            canDelete: true,
            canSandbox: true,
            canManageCollaborators: true,
            canChangeVisibility: true,
          },
        },
        artifacts: [],
        timeline: { events: [], hasMore: false, cursor: null },
        promptQueue: [],
      };
      vi.mocked(browserApiFetch)
        .mockResolvedValueOnce(Response.json({ ok: true }))
        .mockRejectedValueOnce(new Error("Snapshot offline"))
        .mockResolvedValueOnce(
          Response.json({
            ...initial,
            session: {
              ...initial.session,
              visibility: operation === "visibility" ? "workspace" : "private",
              collaborators:
                operation === "collaborator add"
                  ? ["user_collaborator", "user_added"]
                  : operation === "collaborator remove"
                    ? []
                    : initial.session.collaborators,
            },
          })
        );

      function Details({ mobile }: { mobile: boolean }) {
        const current = useSessionSnapshot();
        const refresh = useRefreshSessionSnapshot();
        const props = {
          sessionId: current.session.id,
          sessionState: current.session,
          participants: [],
          presenceSynced: false,
          events: [],
          artifacts: [],
          onOpenMedia: vi.fn(),
          capabilities: resolveSessionCapabilities(current.session.capabilities),
          scope: {
            ownerTeamId: current.session.ownerTeamId ?? null,
            ownerUserId: current.session.ownerUserId ?? null,
            visibility: current.session.visibility!,
            collaborators: current.session.collaborators ?? [],
            onUpdated: refresh,
          },
        };
        return mobile ? (
          <Overlay {...props} open isPhone onOpenChange={vi.fn()} />
        ) : (
          <Sidebar {...props} />
        );
      }

      const { rerender } = render(
        <SessionSnapshotProvider snapshot={initial}>
          <Details mobile={false} />
        </SessionSnapshotProvider>
      );
      selectTab("Info");
      if (operation === "collaborator remove") {
        await user.click(screen.getByRole("button", { name: "Remove Unnamed user \u00b7 orator" }));
      } else {
        const trigger = screen.getByRole("combobox", {
          name: operation === "visibility" ? "Visibility" : "Add collaborator",
        });
        act(() => trigger.focus());
        await user.keyboard("{Enter}");
        await user.click(
          await screen.findByRole("option", {
            name: operation === "visibility" ? "Workspace" : "New collaborator",
          })
        );
        await user.click(
          screen.getByRole("button", {
            name: operation === "visibility" ? "Change visibility" : "Add",
          })
        );
      }
      expect(await screen.findByText(/change saved, but refreshing/i)).toBeInTheDocument();
      rerender(
        <SessionSnapshotProvider snapshot={initial}>
          <Details mobile />
        </SessionSnapshotProvider>
      );
      if (operation === "visibility") {
        expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent("Workspace");
        expect(screen.getByRole("combobox", { name: "Visibility" })).toBeDisabled();
      } else {
        expect(screen.queryByText("Collaborators")).toBeNull();
      }
      await user.click(screen.getByRole("button", { name: "Retry refresh" }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Retry refresh" })).toBeNull()
      );
      expect(screen.getByRole("combobox", { name: "Visibility" })).toHaveTextContent(
        operation === "visibility" ? "Workspace" : "Private"
      );
      expect(screen.getByRole("combobox", { name: "Visibility" })).toBeEnabled();
      if (operation === "collaborator add")
        expect(screen.getByText("New collaborator")).toBeInTheDocument();
      if (operation === "collaborator remove")
        expect(screen.queryByText("Unnamed user \u00b7 orator")).toBeNull();
      expect(browserApiFetch).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(browserApiFetch)
          .mock.calls.filter(([, init]) => init?.method === "PUT" || init?.method === "DELETE")
      ).toHaveLength(1);
    }
  );

  it.each([true, false])(
    "dismisses only the visibility dropdown on the first Escape (phone=%s)",
    async (isPhone) => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      const onReturnFocus = vi.fn();
      render(
        <Overlay
          open
          isPhone={isPhone}
          onOpenChange={onOpenChange}
          onReturnFocus={onReturnFocus}
          sessionId="session-1"
          sessionState={sessionState}
          participants={[]}
          presenceSynced
          events={[]}
          artifacts={[]}
          onOpenMedia={vi.fn()}
          capabilities={{ ...FULL_CAPABILITIES, changeVisibility: true }}
          scope={{
            ownerTeamId: "team_design",
            ownerUserId: "user_owner",
            visibility: "workspace",
            collaborators: [],
            onUpdated: vi.fn(),
          }}
        />
      );
      selectTab("Info");
      const trigger = screen.getByRole("combobox", { name: "Visibility" });
      act(() => trigger.focus());
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("listbox")).toBeVisible();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(onReturnFocus).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Session details" })).toBeVisible();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveTextContent("Workspace");
      expect(browserApiFetch).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onReturnFocus).toHaveBeenCalledOnce();
    }
  );

  it("never mounts private collaborator management on workspace-visible sessions", () => {
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={{ ...FULL_CAPABILITIES, manageCollaborators: true }}
        scope={{
          ownerTeamId: null,
          ownerUserId: "user_owner",
          visibility: "workspace",
          collaborators: ["user_secret"],
          onUpdated: vi.fn(),
        }}
      />
    );
    expect(screen.getByText("Workspace (no team)")).toBeInTheDocument();
    expect(screen.queryByText("user_secret")).not.toBeInTheDocument();
  });

  it("hides Download trace from viewers and offers it to exporters in desktop and mobile details", () => {
    const props = {
      sessionId: "session-1",
      sessionState,
      participants: [],
      presenceSynced: false,
      events: [],
      artifacts: [],
      onOpenMedia: vi.fn(),
      capabilities: FULL_CAPABILITIES,
    };
    const { rerender } = render(
      <Sidebar {...props} capabilities={{ ...FULL_CAPABILITIES, exportTrace: false }} />
    );
    selectTab("Info");
    expect(screen.queryByRole("button", { name: "Download trace" })).not.toBeInTheDocument();

    rerender(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "Download trace" })).toBeInTheDocument();

    rerender(<Overlay {...props} open isPhone onOpenChange={vi.fn()} />);
    selectTab("Info");
    expect(screen.getByRole("button", { name: "Download trace" })).toBeInTheDocument();
  });

  it("shows the denial reason when an allowed trace export receives 403", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden", reason_code: "session_read_only" }, { status: 403 })
    );
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={resolveSessionCapabilities({ canRead: true }, true)}
      />
    );

    selectTab("Info");
    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to download trace (session_read_only)")
    );
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session-1/export", {
      signal: expect.any(AbortSignal),
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads a successful trace with the session filename", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      new Response('{"type":"session"}\n', { headers: { "Content-Type": "application/x-ndjson" } })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    selectTab("Info");
    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(click.mock.instances[0]).toHaveProperty("download", "session-session-1.ndjson");
    expect(click.mock.instances[0]).toHaveProperty("href", "blob:session-trace");
  });

  it.each([
    ["session_error record", '{"schemaVersion":1,"type":"session_error"}\n'],
    ["error record", '{"schemaVersion":1,"type":"error"}\n'],
    ["number record", "42\n"],
    ["boolean record", "false\n"],
    ["string record", '"not an object"\n'],
    ["array record", "[]\n"],
  ])("reports a %s as a failed download", async (_name, body) => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      })
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    selectTab("Info");
    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to download trace"));
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("aborts a trace body that stalls after headers and re-enables the download button", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(browserApiFetch).mockImplementationOnce(async (_path, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            fetchSignal?.addEventListener("abort", () => controller.error(fetchSignal?.reason), {
              once: true,
            });
          },
        }),
        { headers: { "Content-Type": "application/x-ndjson" } }
      );
    });
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    selectTab("Info");
    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchSignal?.aborted).toBe(true);
    expect(toast.error).toHaveBeenCalledWith("Failed to download trace");
    expect(screen.getByRole("button", { name: "Download trace" })).not.toBeDisabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("clears the trace deadline after a successful body read", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    vi.mocked(browserApiFetch).mockImplementationOnce(async (_path, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Response('{"type":"session"}\n');
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    selectTab("Info");
    fireEvent.click(screen.getByRole("button", { name: "Download trace" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(click).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchSignal?.aborted).toBe(false);
  });

  it("hides sandbox access controls when the capability is denied", () => {
    const sandboxSessionState: SessionState = {
      id: "session-1",
      title: "Viewer session",
      repoOwner: "acme",
      repoName: "web",
      baseBranch: "main",
      branchName: "viewer",
      status: "active",
      sandboxStatus: "ready",
      harness: "opencode",
      messageCount: 0,
      createdAt: 1,
      codeServerUrl: "https://code.example",
      vncUrl: "https://vnc.example",
      ttydUrl: "https://terminal.example",
      ttydToken: "secret",
      tunnelUrls: { app: "https://app.example" },
    };

    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sandboxSessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={{ ...FULL_CAPABILITIES, sandboxAccess: false }}
      />
    );

    selectTab("Tools");
    expect(screen.queryByText("Open Editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("Port app")).not.toBeInTheDocument();
    expect(
      screen.getByText("Sandbox access is not available with your permissions.")
    ).toBeVisible();
    selectTab("Info");
    expect(screen.getByText("main")).toBeVisible();
  });

  it("keeps its ARIA target mounted when closed", () => {
    render(
      <Sidebar
        isOpen={false}
        sessionId="session-1"
        sessionState={null}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    const sidebar = document.getElementById("session-details-sidebar");
    expect(sidebar).toBeInTheDocument();
    expect(sidebar).toHaveClass("hidden");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("details")).not.toBeInTheDocument();
  });

  it("forwards budget management to the desktop sidebar", () => {
    render(
      <Sidebar
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    selectTab("Info");
    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });

  it("does not render budget spacing when the budget section is hidden", () => {
    const { container } = render(
      <Sidebar
        sessionId="session-1"
        sessionState={{ ...sessionState, totalCost: 0, maxSessionCostUsd: null }}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
      />
    );

    selectTab("Info");
    expect(screen.queryByRole("term", { name: "Cost" })).not.toBeInTheDocument();
    expect(screen.queryByText("Cost", { exact: true })).not.toBeInTheDocument();
    expect(container.querySelector(".mt-4")).not.toBeInTheDocument();
  });

  it("forwards budget management to the mobile overlay", () => {
    render(
      <Overlay
        open
        isPhone
        onOpenChange={vi.fn()}
        sessionId="session-1"
        sessionState={sessionState}
        participants={[]}
        presenceSynced={false}
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        capabilities={FULL_CAPABILITIES}
        canManageBudget
      />
    );

    selectTab("Info");
    expect(screen.getByRole("button", { name: "Edit limit" })).toBeInTheDocument();
  });

  it("uses linked, keyboard-accessible tabs with one visible panel", async () => {
    const user = userEvent.setup();
    render(inspector());
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent?.trim());
    expect(tabs).toEqual(["Info", "Changes", "Tasks", "Tools"]);
    const info = screen.getByRole("tab", { name: "Info" });
    expect(info).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByText("Run information")).toBeVisible();

    await user.click(info);
    await user.keyboard("{ArrowRight}");
    const changes = screen.getByRole("tab", { name: "Changes" });
    await waitFor(() => expect(changes).toHaveFocus());
    expect(changes).toHaveAttribute("aria-selected", "true");
    expect(info).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Changes" })).toHaveAttribute(
      "id",
      changes.getAttribute("aria-controls")
    );

    const tools = screen.getByRole("tab", { name: "Tools" });
    await user.keyboard("{End}");
    await waitFor(() => expect(tools).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(info).toHaveFocus());
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(tools).toHaveFocus());
    await user.keyboard("{Home}");
    await waitFor(() => expect(info).toHaveFocus());
  });

  it("preserves the file filter when switching panels and passes canonical selection", async () => {
    const user = userEvent.setup();
    const onOpenDiff = vi.fn();
    render(inspector({ diffState: READY_DIFF, onOpenDiff }));
    selectTab("Changes 1");
    const filter = screen.getByRole("searchbox", { name: "Filter changed files" });
    await user.type(filter, "navigation");
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(filter).not.toBeVisible();
    expect(screen.getByTitle(`${SESSION.repoOwner}/${SESSION.repoName}`)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Changes 1" }));
    expect(filter).toHaveValue("navigation");
    const file = screen.getByRole("button", { name: /navigation.tsx modified/ });
    expect(file).toHaveAttribute("data-diff-path", "src/components/navigation.tsx");
    await user.click(file);
    expect(onOpenDiff).toHaveBeenCalledWith(
      READY_DIFF.current!.repositories[0],
      READY_DIFF.current!.repositories[0].files[0]
    );
  });

  it("totals the latest changes in the Changes header", () => {
    render(inspector({ diffState: READY_DIFF }));
    selectTab("Changes 1");

    const panel = screen.getByRole("tabpanel", { name: "Changes 1" });
    expect(panel).toHaveTextContent("+2");
    expect(panel).toHaveTextContent("−1");
    expect(panel).toHaveTextContent("across 1 file");
  });

  it.each([
    [{ sessionState: null }, "Loading session information…"],
    [
      { sessionState: { ...SESSION, repoOwner: null, repoName: null } },
      "No repository is attached to this session.",
    ],
    [{ diffLoading: true }, "Loading changes…"],
    [{ diffState: null }, "Unable to load changes."],
    [
      { diffState: { ...EMPTY_DIFF, unavailableReason: "Checkout unavailable" } },
      "Checkout unavailable",
    ],
    [{}, "Changes will be available after the first execution."],
    [
      { sessionState: { ...SESSION, isProcessing: true } },
      "Changes will be available after this execution.",
    ],
    [
      { sessionState: { ...SESSION, isProcessing: true }, diffState: READY_DIFF },
      "Agent working — showing the previous changes.",
    ],
    [
      { diffState: { ...EMPTY_DIFF, current: { ...READY_DIFF.current!, repositories: [] } } },
      "No file changes in the latest diff.",
    ],
    [
      { diffState: { ...EMPTY_DIFF, lastError: { message: "Capture failed", occurredAt: 1 } } },
      "Capture failed",
    ],
  ] satisfies [Partial<SidebarProps>, string][])(
    "preserves diff lifecycle state %#",
    (props, message) => {
      render(inspector(props));
      selectTab(/^Changes/);
      expect(screen.getByRole("tabpanel", { name: /^Changes/ })).toHaveTextContent(message);
    }
  );

  it("preserves retry permission checks", () => {
    render(
      inspector({
        diffState: { ...EMPTY_DIFF, lastError: { message: "Capture failed", occurredAt: 1 } },
        capabilities: { ...FULL_CAPABILITIES, lifecycle: false },
      })
    );
    selectTab("Changes");
    expect(screen.getByText("Capture failed")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("lists captured media as collapsible artifacts in Info", () => {
    render(
      inspector({
        artifacts: [
          {
            id: "shot-1",
            type: "screenshot",
            url: null,
            createdAt: 1,
            metadata: { caption: "Login page" },
          },
        ],
      })
    );

    const toggle = screen.getByRole("button", { name: "Artifacts (1)" });
    expect(screen.getByRole("tabpanel", { name: "Info" })).toContainElement(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Login page" })).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Login page" })).not.toBeInTheDocument();
  });

  it("shows honest task and tool empty states", () => {
    render(inspector());
    selectTab("Tasks");
    expect(screen.getByText("The agent hasn’t published a task list yet.")).toBeVisible();
    selectTab("Tools");
    expect(screen.getByText("Sandbox tools will appear here when available.")).toBeVisible();
  });

  it("shows checklist counts and completion from the current task events", () => {
    render(
      inspector({
        events: [
          {
            type: "tool_call",
            sandboxId: "sandbox-1",
            messageId: "message-1",
            timestamp: 1,
            tool: "TodoWrite",
            callId: "call-1",
            args: {
              todos: [
                { content: "Read the code", status: "completed" },
                { content: "Update the UI", status: "in_progress" },
              ],
            },
          },
        ],
      })
    );
    selectTab("Tasks 2");
    expect(screen.getByText("1 / 2 complete")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Completed tasks" })).toHaveAttribute(
      "value",
      "1"
    );
    expect(screen.getByText("Update the UI")).toBeVisible();
  });

  it("preserves authorized terminal controls and does not leak them into Info", () => {
    const onToggleTerminal = vi.fn();
    render(
      inspector({
        sessionState: { ...SESSION, ttydUrl: "https://terminal.example", ttydToken: "token" },
        onToggleTerminal,
      })
    );
    expect(screen.queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
    selectTab("Tools");
    expect(screen.getByRole("link", { name: "Open in new tab" })).toHaveAttribute(
      "href",
      "https://terminal.example/?token=token"
    );
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(onToggleTerminal).toHaveBeenCalledOnce();
  });

  it("scrolls each tab panel on its own", () => {
    render(inspector({ diffState: READY_DIFF }));
    selectTab("Info");
    const info = screen.getByRole("tabpanel", { name: "Info" });
    info.scrollTop = 400;

    selectTab("Changes 1");
    const changes = screen.getByRole("tabpanel", { name: "Changes 1" });
    expect(changes).not.toBe(info);
    expect(changes).toHaveClass("overflow-y-auto");
    expect(info).toHaveClass("overflow-y-auto");
    expect(changes.scrollTop).toBe(0);
    expect(document.getElementById("session-details-sidebar")).not.toHaveClass("overflow-y-auto");
  });

  it("shows the tab its owner chooses and reports the viewer's choices", () => {
    const onTabChange = vi.fn();
    render(
      <SessionRightSidebar
        sessionId="session-1"
        sessionState={SESSION}
        participants={[]}
        presenceSynced
        events={[]}
        artifacts={[]}
        onOpenMedia={vi.fn()}
        diffState={READY_DIFF}
        capabilities={FULL_CAPABILITIES}
        activeTab="info"
        onTabChange={onTabChange}
      />
    );
    expect(screen.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");

    selectTab("Tasks");
    expect(onTabChange).toHaveBeenCalledWith("tasks");
    // The owner decides; until it updates the tab, Info stays selected.
    expect(screen.getByRole("tab", { name: "Info" })).toHaveAttribute("aria-selected", "true");
  });

  it("reopens on the tab the viewer chose last", async () => {
    const first = render(inspector());
    selectTab("Tasks");
    first.unmount();

    render(inspector());
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true")
    );
  });
});
