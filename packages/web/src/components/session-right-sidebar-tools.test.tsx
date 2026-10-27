// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ComponentProps, ReactNode } from "react";
import { cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { SessionRightSidebar } from "./session-right-sidebar";
import { SessionScopeProvider } from "./session-scope-provider";
import { useSessionInspectorTab } from "@/hooks/use-session-inspector-tab";
import type { SessionCapabilities } from "@/lib/session-capabilities";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/hooks/use-teams", () => ({
  useTeam: () => ({ team: { name: "Design", slug: "design" } }),
  useTeamMembers: () => ({ members: [{ userId: "user_owner" }], loading: false, error: undefined }),
}));
vi.mock("@/hooks/use-session-collaborator-candidates", () => ({
  useSessionCollaboratorCandidates: () => ({ candidates: [], loading: false, error: undefined }),
}));
vi.mock("swr", () => ({
  default: () => ({ data: undefined }),
  useSWRConfig: () => ({
    fetcher: undefined,
    mutate: vi.fn().mockResolvedValue(undefined),
    cache: new Map(),
  }),
}));

function render(ui: ReactNode) {
  return renderView(ui, { wrapper: SessionScopeProvider });
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  // The inspector remembers the last tab; start every case on the default.
  localStorage.clear();
  vi.restoreAllMocks();
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

// The session page owns the inspector tab; this stands in for it.
function Sidebar(props: SidebarProps) {
  const { tab, selectTab } = useSessionInspectorTab();
  return <SessionRightSidebar {...props} activeTab={tab} onTabChange={selectTab} />;
}

// Radix tabs activate on mousedown (or focus), not on click.
function selectTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

const SESSION: SessionState = {
  id: "session-1",
  title: "Review session",
  repoOwner: "acme",
  repoName: "web",
  baseBranch: "main",
  branchName: null,
  status: "active",
  sandboxStatus: "ready",
  harness: "opencode",
  messageCount: 0,
  createdAt: 1,
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
      capabilities={FULL_CAPABILITIES}
      {...overrides}
    />
  );
}

describe("SessionRightSidebar workspace tools", () => {
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

  it("asks before loading sandbox credentials, keeping preview links available", () => {
    const onConnectSandbox = vi.fn();
    const sessionState: SessionState = {
      ...SESSION,
      codeServerUrl: "https://code.example",
      vncUrl: "https://vnc.example",
      ttydUrl: "https://terminal.example",
      tunnelUrls: { "3000": "https://app.example" },
    };
    const { rerender } = render(
      inspector({ sessionState, sandboxConnectRequired: true, onConnectSandbox })
    );
    selectTab("Tools");
    expect(screen.queryByText("Open Editor")).not.toBeInTheDocument();
    expect(screen.queryByText("Open Desktop")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Port 3000" })).toHaveAttribute(
      "href",
      "https://app.example/"
    );
    expect(
      screen.getByText(/stops the agent from searching their personal memories/)
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open terminal, editor and desktop" }));
    expect(onConnectSandbox).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      inspector({
        sessionState,
        sandboxConnectRequired: true,
        sandboxConnecting: true,
        onConnectSandbox,
      })
    );
    expect(
      screen.getByRole("button", { name: "Opening terminal, editor and desktop…" })
    ).toBeDisabled();

    rerender(
      inspector({
        sessionState,
        sandboxConnectRequired: true,
        sandboxConnectFailed: true,
        onConnectSandbox,
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't open the sandbox tools.");

    rerender(
      inspector({
        sessionState: { ...sessionState, ttydToken: "token", codeServerPassword: "secret" },
        sandboxConnectRequired: false,
        onConnectSandbox,
      })
    );
    expect(screen.getByText("Open Editor")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open terminal, editor and desktop" })
    ).not.toBeInTheDocument();
  });
});
