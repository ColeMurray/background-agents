// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { Component, type ReactNode } from "react";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  SessionSnapshotProvider,
  useSessionSnapshot,
  useRefreshSessionSnapshot,
} from "./session-snapshot-provider";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_actor" } } }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
}));

const snapshot: SessionSnapshot = {
  session: {
    id: "session-1",
    title: null,
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    branchName: null,
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    harness: "opencode",
    ownerTeamId: "team_old",
    visibility: "private",
    collaborators: [],
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

function Probe() {
  const current = useSessionSnapshot();
  const refresh = useRefreshSessionSnapshot();
  return (
    <>
      <p>
        {current.session.ownerTeamId} / {current.session.visibility}
      </p>
      <p>{current.session.collaborators?.join(",")}</p>
      <button disabled={!current.session.capabilities?.canChangeVisibility}>
        Change visibility
      </button>
      <button onClick={() => void refresh().catch(() => {})}>Refresh</button>
    </>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p>{this.state.error.message}</p> : this.props.children;
  }
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());

describe("SessionSnapshotProvider", () => {
  it("renders not-found instead of session content when a refreshed deep link is invisible", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ error: "Session not found" }, { status: 404 })
      );
      render(
        <Boundary>
          <SessionSnapshotProvider snapshot={snapshot}>
            <Probe />
          </SessionSnapshotProvider>
        </Boundary>
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(screen.getByText("NEXT_NOT_FOUND")).toBeInTheDocument());
      expect(screen.queryByText("team_old / private")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
  it("prefers a new SSR snapshot to previously refreshed data", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        ...snapshot,
        session: { ...snapshot.session, visibility: "team" },
      })
    );
    const { rerender } = render(
      <SessionSnapshotProvider snapshot={snapshot}>
        <Probe />
      </SessionSnapshotProvider>,
      {
        wrapper: ({ children }) => (
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        ),
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("team_old / team")).toBeInTheDocument());
    const incoming = {
      ...snapshot,
      session: { ...snapshot.session, visibility: "workspace" as const },
    };
    rerender(
      <SessionSnapshotProvider snapshot={incoming}>
        <Probe />
      </SessionSnapshotProvider>
    );
    expect(screen.getByText("team_old / workspace")).toBeInTheDocument();
  });
  it("renders the SSR snapshot without an extra initial request", () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SessionSnapshotProvider snapshot={snapshot}>
          <Probe />
        </SessionSnapshotProvider>
      </SWRConfig>
    );
    expect(screen.getByText("team_old / private")).toBeInTheDocument();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("refreshes scope, collaborators and capabilities even when the timestamp is unchanged", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        ...snapshot,
        session: {
          ...snapshot.session,
          visibility: "team",
          collaborators: ["user_added"],
          capabilities: { ...snapshot.session.capabilities, canChangeVisibility: false },
        },
      })
    );
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SessionSnapshotProvider snapshot={snapshot}>
          <Probe />
        </SessionSnapshotProvider>
      </SWRConfig>
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("team_old / team")).toBeInTheDocument());
    expect(screen.getByText("user_added")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change visibility" })).toBeDisabled();
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/session-1");
  });
});
