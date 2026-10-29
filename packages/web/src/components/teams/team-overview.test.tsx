// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { markSessionInboxRead } from "@/lib/session-read-state";
import { useAuthSession } from "@/lib/auth-session";
import { isSessionScopeCacheKey } from "@/lib/session-scope";
import { TeamOverview, useTeamSessionBucket } from "./team-overview";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

function item(id: string, ownerTeamId = "team_one") {
  return {
    rootSession: {
      id,
      title: id,
      repoOwner: "owner",
      repoName: "repo",
      baseBranch: "main",
      status: "active",
      parentSessionId: null,
      spawnSource: "user",
      environmentId: null,
      createdAt: 1,
      updatedAt: 1,
      ownerTeamId,
      visibility: "team",
      capabilities: {
        canRead: true,
        canCollaborate: false,
        canManageLifecycle: false,
        canDelete: false,
        canSandbox: false,
        canManageCollaborators: false,
        canChangeVisibility: false,
      },
      readState: { latestMessageId: null, unread: false, version: 0 },
    },
    descendantSessions: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue({
    data: { user: { id: "user_one", name: "Viewer", email: "viewer@example.com", image: null } },
    status: "authenticated",
  });
});
afterEach(cleanup);

function unreadHierarchy(id: string) {
  const unread = { latestMessageId: "message", unread: true, version: 1 };
  const root = item(id);
  const child = item(`${id}-child`).rootSession;
  return {
    rootSession: { ...root.rootSession, readState: unread },
    descendantSessions: [{ ...child, parentSessionId: id, readState: unread }],
  };
}

describe("team session buckets", () => {
  it("keeps two teams distinct and refreshes both after a visibility change", async () => {
    let visibilityChanged = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path) => {
      const source = path.includes("team_one");
      return Response.json({
        items:
          source && visibilityChanged
            ? []
            : [item(source ? "session_one" : "session_two", source ? "team_one" : "team_two")],
        hasMore: false,
        nextCursor: null,
      });
    });
    const { result } = renderHook(
      () => {
        const { mutate } = useSWRConfig();
        return {
          one: useTeamSessionBucket("team_one", "needs_attention"),
          two: useTeamSessionBucket("team_two", "needs_attention"),
          refreshAfterVisibilityChange: () => mutate(isSessionScopeCacheKey),
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.one.items[0]?.rootSession.id).toBe("session_one");
      expect(result.current.two.items[0]?.rootSession.id).toBe("session_two");
    });
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/teams/team_one/sessions?bucket=needs_attention"
    );
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/teams/team_two/sessions?bucket=needs_attention"
    );
    visibilityChanged = true;
    await act(async () => {
      await result.current.refreshAfterVisibilityChange();
    });
    expect(result.current.one.items).toEqual([]);
    expect(result.current.two.items[0]?.rootSession.id).toBe("session_two");
  });

  it("forwards an opaque cursor and validates inbox pages", async () => {
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(
        Response.json({ items: [item("one")], hasMore: true, nextCursor: "opaque/+ cursor" })
      )
      .mockResolvedValueOnce(
        Response.json({ items: [item("two")], hasMore: false, nextCursor: null })
      );
    const { result } = renderHook(() => useTeamSessionBucket("team_one", "in_progress"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("two"));
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/teams/team_one/sessions?bucket=in_progress&cursor=opaque%2F%2B+cursor"
    );
  });

  it("resets pagination when switching team scope", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({ items: [item("one")], hasMore: true, nextCursor: "page_two" })
    );
    const { result, rerender } = renderHook(
      ({ teamId }) => useTeamSessionBucket(teamId, "needs_attention"),
      { wrapper, initialProps: { teamId: "team_one" } }
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.page).toBe(2));
    rerender({ teamId: "team_two" });
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/teams/team_two/sessions?bucket=needs_attention"
      )
    );
    expect(result.current.page).toBe(1);
    expect(browserApiFetch).not.toHaveBeenCalledWith(
      "/api/teams/team_two/sessions?bucket=needs_attention&cursor=page_two"
    );
  });

  it("isolates cached rows and resets cursors when the viewer changes in the same provider", async () => {
    let userId = "user_one";
    vi.mocked(useAuthSession).mockImplementation(() => ({
      data: { user: { id: userId, name: "Viewer", email: "viewer@example.com", image: null } },
      status: "authenticated",
    }));
    let resolveNewUser!: (response: Response) => void;
    const newUserResponse = new Promise<Response>((resolve) => {
      resolveNewUser = resolve;
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) => {
      if (userId === "user_two") return newUserResponse;
      return Response.json({
        items: [item(path.includes("cursor=") ? "user_one_page_two" : "user_one_page_one")],
        hasMore: true,
        nextCursor: "user_one_cursor",
      });
    });
    const { result, rerender } = renderHook(
      () => useTeamSessionBucket("team_one", "needs_attention"),
      { wrapper }
    );
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("user_one_page_one"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("user_one_page_two"));

    vi.mocked(browserApiFetch).mockClear();
    userId = "user_two";
    rerender();
    expect(result.current.items).toEqual([]);
    expect(result.current.page).toBe(1);
    expect(result.current.hasPrevious).toBe(false);
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/teams/team_one/sessions?bucket=needs_attention"
      )
    );
    expect(browserApiFetch).not.toHaveBeenCalledWith(expect.stringContaining("cursor="));
    await act(async () => {
      resolveNewUser(
        Response.json({ items: [item("user_two_row")], hasMore: false, nextCursor: null })
      );
    });
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("user_two_row"));

    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    vi.mocked(browserApiFetch).mockClear();
    rerender();
    expect(result.current.items).toEqual([]);
    expect(result.current.page).toBe(1);
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])(
    "withholds cached sessions on access denial but retains them on transient failure (%s)",
    async (failureStatus) => {
      let status = 200;
      vi.mocked(browserApiFetch).mockImplementation(async () =>
        Response.json(
          status === 200
            ? { items: [item("cached")], hasMore: true, nextCursor: "next_page" }
            : { error: "failed" },
          { status }
        )
      );
      const { result } = renderHook(() => useTeamSessionBucket("team_one", "needs_attention"), {
        wrapper,
      });
      await waitFor(() => expect(result.current.items).toHaveLength(1));
      status = failureStatus;
      await act(async () => {
        await result.current.refresh();
      });
      await waitFor(() => expect(result.current.error).toMatchObject({ status: failureStatus }));
      expect(result.current.items.map(({ rootSession }) => rootSession.id)).toEqual(
        failureStatus === 500 ? ["cached"] : []
      );
      expect(result.current.hasMore).toBe(failureStatus === 500);
    }
  );

  it("rejects a session page missing server capabilities", async () => {
    const rootSession = { ...item("untrusted").rootSession, capabilities: undefined };
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        items: [{ rootSession, descendantSessions: [] }],
        hasMore: false,
        nextCursor: null,
      })
    );
    const { result } = renderHook(() => useTeamSessionBucket("team_one", "needs_attention"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.items).toEqual([]);
  });

  it("does not derive a session link from team membership when the server denies canRead", async () => {
    const row = item("read_denied");
    row.rootSession.capabilities.canRead = false;
    vi.mocked(browserApiFetch).mockImplementation(async () =>
      Response.json({ items: [row], hasMore: false, nextCursor: null })
    );
    render(<TeamOverview teamId="team_one" />, { wrapper });
    await waitFor(() => expect(screen.getAllByText("read_denied")).toHaveLength(2));
    expect(screen.queryByRole("link", { name: "read_denied" })).toBeNull();
  });

  it("marks the team's attention sessions read after confirmation and refetches", async () => {
    let markedRead = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path) => {
      if (path === "/api/sessions/inbox/read-state") {
        markedRead = true;
        return Response.json({ markedCount: 1 });
      }
      const attention = path.includes("bucket=needs_attention");
      return Response.json({
        items: attention ? (markedRead ? [] : [unreadHierarchy("waiting")]) : [item("running")],
        hasMore: false,
        nextCursor: null,
      });
    });
    render(<TeamOverview teamId="team_one" />, { wrapper });
    const attention = await screen.findByRole("region", { name: "Needs attention" });
    await within(attention).findByText("waiting");
    expect(
      within(screen.getByRole("region", { name: "In progress" })).queryByRole("button", {
        name: "Mark all as read",
      })
    ).toBeNull();

    fireEvent.click(within(attention).getByRole("button", { name: "Mark all as read" }));
    // The root and its unread child are both marked.
    expect(await screen.findByText("Mark 2 sessions as read?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() => expect(within(attention).queryByText("waiting")).toBeNull());
    expect(browserApiFetch).toHaveBeenCalledWith("/api/sessions/inbox/read-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamIds: ["team_one"] }),
    });
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("returns to a freshly fetched first page after a bulk read from a later page", async () => {
    let markedRead = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path) => {
      if (path === "/api/sessions/inbox/read-state") {
        markedRead = true;
        return Response.json({ markedCount: 2 });
      }
      if (path.includes("cursor=")) {
        return Response.json({ items: [item("second")], hasMore: false, nextCursor: null });
      }
      return Response.json(
        markedRead
          ? { items: [], hasMore: false, nextCursor: null }
          : { items: [item("first")], hasMore: true, nextCursor: "page-2" }
      );
    });
    // Production deduping would otherwise reuse the head request made moments ago.
    const { result } = renderHook(() => useTeamSessionBucket("team_one", "needs_attention"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2_000 }}>
          {children}
        </SWRConfig>
      ),
    });
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("first"));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.items[0]?.rootSession.id).toBe("second"));

    await act(async () => {
      await markSessionInboxRead({ teamIds: ["team_one"] });
    });

    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(result.current.page).toBe(1);
    const paths = vi.mocked(browserApiFetch).mock.calls.map(([path]) => path);
    const headPath = "/api/teams/team_one/sessions?bucket=needs_attention";
    expect(paths.slice(paths.indexOf("/api/sessions/inbox/read-state"))).toContain(headPath);
  });
});
