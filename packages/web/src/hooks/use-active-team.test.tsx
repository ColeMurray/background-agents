// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { meTeamsKey } from "@/lib/me-teams-cache";
import { ActiveTeamProvider, useActiveTeam } from "./use-active-team";
import { useSidebarSessions } from "./use-sidebar-sessions";
import { TeamSwitcher } from "@/components/team-switcher";

const USER_ID = "11111111111111111111111111111111";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: USER_ID } }, status: "authenticated" }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

let roleKey: string | null = "member";
let canListAllTeams: boolean | undefined = false;

function authorizationResponse() {
  return Response.json({
    userId: USER_ID,
    suspendedAt: null,
    role: {
      id: roleKey === null ? "role_custom" : `role_builtin_${roleKey}`,
      key: roleKey,
      name: roleKey ?? "Custom",
    },
    permissions: ["sessions.read", "sessions.create"],
  });
}

function membershipsResponse() {
  return Response.json({
    teams: [team("team_alpha"), team("team_beta"), team("team_old", 1)],
    requireTeamOnCreate: true,
    ...(canListAllTeams === undefined ? {} : { capabilities: { canListAllTeams } }),
  });
}

function team(id: string, archivedAt: number | null = null) {
  return {
    id,
    slug: id,
    name: id,
    description: null,
    joinPolicy: "invite_only",
    defaultVisibility: "team",
    defaultEnvironmentId: null,
    grantsVersion: 0,
    archivedAt,
    createdAt: 1,
    updatedAt: 1,
    memberCount: 1,
    role: "member",
  };
}

function inboxSnapshot() {
  return {
    categories: {
      needs_attention: { items: [], hasMore: false, nextCursor: null },
      in_progress: { items: [], hasMore: false, nextCursor: null },
      finished: {
        items: [
          {
            rootSession: {
              id: "team-session",
              title: "Team work",
              repoOwner: null,
              repoName: null,
              baseBranch: null,
              status: "active",
              parentSessionId: null,
              spawnSource: "user",
              environmentId: null,
              createdAt: 1,
              updatedAt: 1,
              ownerTeamId: "team_alpha",
              visibility: "team",
              readState: { latestMessageId: null, version: 0, unread: false },
            },
            descendantSessions: [],
          },
        ],
        hasMore: false,
        nextCursor: null,
      },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      <ActiveTeamProvider>{children}</ActiveTeamProvider>
    </SWRConfig>
  );
}

beforeEach(() => {
  localStorage.clear();
  roleKey = "member";
  canListAllTeams = false;
  vi.mocked(browserApiFetch).mockImplementation(async (path) =>
    path === "/api/me/authorization" ? authorizationResponse() : membershipsResponse()
  );
});
afterEach(cleanup);

describe("active team context", () => {
  it("defaults a single-team user to unfiltered lists and shows the selector", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/authorization"
        ? authorizationResponse()
        : Response.json({ teams: [team("team_alpha")], requireTeamOnCreate: true })
    );
    const fetcher = vi.fn(async () => inboxSnapshot());
    function SidebarProbe() {
      const sidebar = useSidebarSessions();
      return (
        <>
          <TeamSwitcher />
          {sidebar.finished.map((row) => (
            <p key={row.id}>{row.title}</p>
          ))}
        </>
      );
    }
    render(
      <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0 }}>
        <ActiveTeamProvider>
          <SidebarProbe />
        </ActiveTeamProvider>
      </SWRConfig>
    );
    await screen.findByText("Team work");
    expect(fetcher).toHaveBeenCalledWith("/api/sessions/inbox");
    expect(screen.getByRole("combobox", { name: "Active team" }).textContent).toBe("All my teams");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
  });

  it.each([503, 401, 403, 404, "network", "invalid-json", "invalid-schema"] as const)(
    "retains memberships and sidebar rows only for transient refresh failure %s",
    async (failure) => {
      localStorage.setItem("open-inspect-active-team", "team_alpha");
      const fetcher = vi.fn(async (_key: string) => inboxSnapshot());
      const { result } = renderHook(
        () => ({
          context: useActiveTeam(),
          sidebar: useSidebarSessions(),
          mutate: useSWRConfig().mutate,
        }),
        {
          wrapper: ({ children }) => (
            <SWRConfig
              value={{
                provider: () => new Map(),
                fetcher,
                dedupingInterval: 0,
                shouldRetryOnError: false,
              }}
            >
              <ActiveTeamProvider>{children}</ActiveTeamProvider>
            </SWRConfig>
          ),
        }
      );
      await waitFor(() => expect(result.current.sidebar.loading).toBe(false));
      vi.mocked(browserApiFetch).mockImplementation(async () => {
        if (failure === "network") throw new TypeError("Network unavailable");
        if (failure === "invalid-json") return new Response("Invalid JSON");
        if (failure === "invalid-schema") return Response.json({ teams: null });
        return Response.json({ error: "Unavailable" }, { status: failure });
      });
      await act(async () => {
        await result.current.mutate(meTeamsKey(USER_ID));
      });
      if (failure === 503 || failure === "network") {
        expect(result.current.context.error).toBeUndefined();
        expect(result.current.context.activeTeamId).toBe("team_alpha");
        expect(result.current.context.teams).toHaveLength(2);
        expect(result.current.context.requireTeamOnCreate).toBe(true);
        expect(result.current.sidebar.loading).toBe(false);
        expect(result.current.sidebar.finished.map((row) => row.id)).toEqual(["team-session"]);
      } else {
        expect(result.current.context.error).toBeInstanceOf(Error);
        expect(result.current.context.activeTeamId).toBeNull();
        expect(result.current.context.teams).toEqual([]);
        expect(result.current.context.requireTeamOnCreate).toBe(false);
        expect(result.current.sidebar.finished).toEqual([]);
        expect(result.current.sidebar.sessionsError).toBeInstanceOf(Error);
        expect(localStorage.getItem("open-inspect-active-team")).toBe("team_alpha");
      }
      expect(
        fetcher.mock.calls.every(([key]) => key === "/api/sessions/inbox?teamIds%5B%5D=team_alpha")
      ).toBe(true);
    }
  );

  it("accepts a cached empty membership response during a transient refresh failure", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/authorization"
        ? authorizationResponse()
        : Response.json({ teams: [], requireTeamOnCreate: true })
    );
    const { result } = renderHook(
      () => ({ context: useActiveTeam(), mutate: useSWRConfig().mutate }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.context.loading).toBe(false));
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );
    await act(async () => {
      await result.current.mutate(meTeamsKey(USER_ID));
    });
    expect(result.current.context.error).toBeUndefined();
    expect(result.current.context.teams).toEqual([]);
    expect(result.current.context.requireTeamOnCreate).toBe(true);
  });

  it("preserves a stored Workspace context for team members", async () => {
    localStorage.setItem("open-inspect-active-team", "workspace");
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope).toBe("workspace");
  });

  it("leaves lists unfiltered when the user has no active teams", async () => {
    localStorage.setItem("open-inspect-active-team", "workspace");
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/authorization"
        ? authorizationResponse()
        : Response.json({ teams: [team("team_old", 1)] })
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeTeamId).toBeNull();
    expect(result.current.scope).toBeUndefined();
  });

  it.each(["owner", "administrator", "member", "viewer", null])(
    "reconciles stored All teams when the server denies role %s",
    async (role) => {
      roleKey = role;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(useActiveTeam, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.activeTeamId).toBeNull();
      expect(result.current.scope).toBeUndefined();
      expect(result.current.canListAllTeams).toBe(false);
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
      act(() => result.current.setActiveTeam("all-teams"));
      expect(result.current.scope).toBeUndefined();
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
    }
  );

  it.each(["owner", "administrator", "member", "viewer", null])(
    "preserves server-granted All teams for role %s",
    async (role) => {
      roleKey = role;
      canListAllTeams = true;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(useActiveTeam, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.scope).toBe("all");
      expect(result.current.canListAllTeams).toBe(true);
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
    }
  );

  it("fails closed when workspace capabilities are missing even for an owner", async () => {
    roleKey = "owner";
    canListAllTeams = undefined;
    localStorage.setItem("open-inspect-active-team", "all-teams");
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope).toBeUndefined();
    expect(result.current.canListAllTeams).toBe(false);
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
  });

  it.each(["owner", "administrator"])(
    "reconciles All teams after server revocation for a %s without restoring it on a later grant",
    async (role) => {
      roleKey = role;
      canListAllTeams = true;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(
        () => ({ context: useActiveTeam(), mutate: useSWRConfig().mutate }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.context.scope).toBe("all"));
      canListAllTeams = false;
      await act(async () => {
        await result.current.mutate(meTeamsKey(USER_ID));
      });
      expect(result.current.context.scope).toBeUndefined();
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");

      canListAllTeams = true;
      await act(async () => {
        await result.current.mutate(meTeamsKey(USER_ID));
      });
      expect(result.current.context.scope).toBeUndefined();
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
      act(() => result.current.context.setActiveTeam("all-teams"));
      expect(result.current.context.scope).toBe("all");
    }
  );

  it("waits for workspace capabilities before reconciling a stored aggregate scope", async () => {
    roleKey = "owner";
    canListAllTeams = true;
    localStorage.setItem("open-inspect-active-team", "all-teams");
    let resolveMemberships: ((response: Response) => void) | undefined;
    const pendingMemberships = new Promise<Response>((resolve) => {
      resolveMemberships = resolve;
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/teams" ? pendingMemberships : authorizationResponse()
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    expect(result.current.loading).toBe(true);
    expect(result.current.scope).toBeUndefined();
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");

    await act(async () => {
      resolveMemberships?.(membershipsResponse());
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope).toBe("all");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
  });

  it("blocks context readiness when workspace capabilities fail without discarding the preference", async () => {
    localStorage.setItem("open-inspect-active-team", "all-teams");
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/teams"
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : authorizationResponse()
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.scope).toBeUndefined();
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
  });

  it.each([503, 401, 403, 404, "invalid-schema"] as const)(
    "trusts a cached All teams grant only for retryable refresh failure %s",
    async (failure) => {
      canListAllTeams = true;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(
        () => ({ context: useActiveTeam(), mutate: useSWRConfig().mutate }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.context.scope).toBe("all"));
      vi.mocked(browserApiFetch).mockResolvedValue(
        failure === "invalid-schema"
          ? Response.json({ teams: [], capabilities: { canListAllTeams: "true" } })
          : Response.json({ error: "Unavailable" }, { status: failure })
      );
      await act(async () => {
        await result.current.mutate(meTeamsKey(USER_ID));
      });
      const transient = failure === 503;
      expect(result.current.context.scope).toBe(transient ? "all" : undefined);
      expect(result.current.context.canListAllTeams).toBe(transient);
      expect(Boolean(result.current.context.error)).toBe(!transient);
      expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
    }
  );

  it("reconciles a stored team against active memberships and loads the creation setting", async () => {
    localStorage.setItem("open-inspect-active-team", "team_beta");
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeTeamId).toBe("team_beta");
    expect(result.current.scope).toBeUndefined();
    expect(result.current.teams.map(({ id }) => id)).toEqual(["team_alpha", "team_beta"]);
    expect(result.current.requireTeamOnCreate).toBe(true);
    expect(browserApiFetch).toHaveBeenCalledWith("/api/me/teams");
  });

  it.each(["team_unknown", "team_old"])("falls back to All my teams for %s", async (id) => {
    localStorage.setItem("open-inspect-active-team", id);
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeTeamId).toBeNull();
    expect(result.current.scope).toBeUndefined();
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-my-teams");
  });

  it("shares team changes between consumers and remembers aggregate scopes", async () => {
    const { result } = renderHook(() => ({ first: useActiveTeam(), second: useActiveTeam() }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.first.loading).toBe(false));
    act(() => result.current.first.setActiveTeam("team_alpha"));
    expect(result.current.second.activeTeamId).toBe("team_alpha");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("team_alpha");
    act(() => result.current.first.setActiveTeam("all-my-teams"));
    expect(result.current.second.activeTeamId).toBeNull();
    expect(result.current.second.scope).toBeUndefined();
    act(() => result.current.first.setActiveTeam(null));
    expect(result.current.second.scope).toBe("workspace");
  });

  it.each([503, 401, 403, "network", "invalid-json", "invalid-schema"] as const)(
    "blocks sidebar requests on first-load membership failure %s",
    async (failure) => {
      localStorage.setItem("open-inspect-active-team", "team_alpha");
      vi.mocked(browserApiFetch).mockImplementation(async (path) => {
        if (path === "/api/me/authorization") return authorizationResponse();
        if (failure === "network") throw new TypeError("Network unavailable");
        if (failure === "invalid-json") return new Response("Invalid JSON");
        if (failure === "invalid-schema") return Response.json({ teams: null });
        return Response.json({ error: "Unavailable" }, { status: failure });
      });
      const fetcher = vi.fn(async () => inboxSnapshot());
      const { result } = renderHook(
        () => ({ context: useActiveTeam(), sidebar: useSidebarSessions() }),
        {
          wrapper: ({ children }) => (
            <SWRConfig
              value={{
                provider: () => new Map(),
                fetcher,
                dedupingInterval: 0,
                shouldRetryOnError: false,
              }}
            >
              <ActiveTeamProvider>{children}</ActiveTeamProvider>
            </SWRConfig>
          ),
        }
      );
      await waitFor(() => expect(result.current.context.loading).toBe(false));
      expect(result.current.context.error).toBeInstanceOf(Error);
      expect(result.current.context.teams).toEqual([]);
      expect(result.current.context.activeTeamId).toBeNull();
      expect(result.current.context.scope).toBeUndefined();
      expect(result.current.sidebar.finished).toEqual([]);
      expect(result.current.sidebar.sessionsError).toBeInstanceOf(Error);
      expect(fetcher).not.toHaveBeenCalled();
      expect(localStorage.getItem("open-inspect-active-team")).toBe("team_alpha");
    }
  );
});
