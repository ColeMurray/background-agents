// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { currentUserAuthorizationKey } from "./use-current-user-authorization";
import { ActiveTeamProvider, useActiveTeam } from "./use-active-team";

const USER_ID = "11111111111111111111111111111111";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: USER_ID } }, status: "authenticated" }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

let roleKey: string | null = "member";

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
  vi.mocked(browserApiFetch).mockImplementation(async (path) =>
    path === "/api/me/authorization" ? authorizationResponse() : membershipsResponse()
  );
});
afterEach(cleanup);

describe("active team context", () => {
  it.each(["member", "viewer", null])(
    "reconciles stored All teams to Workspace for role %s",
    async (role) => {
      roleKey = role;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(useActiveTeam, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.activeTeamId).toBeNull();
      expect(result.current.scope).toBe("workspace");
      expect(localStorage.getItem("open-inspect-active-team")).toBe("workspace");
      act(() => result.current.setActiveTeam("all-teams"));
      expect(result.current.scope).toBe("workspace");
      expect(localStorage.getItem("open-inspect-active-team")).toBe("workspace");
    }
  );

  it.each(["owner", "administrator"])("preserves All teams for role %s", async (role) => {
    roleKey = role;
    localStorage.setItem("open-inspect-active-team", "all-teams");
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope).toBe("all");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
  });

  it.each(["owner", "administrator"])(
    "reconciles All teams after a %s is demoted without restoring it on a later promotion",
    async (role) => {
      roleKey = role;
      localStorage.setItem("open-inspect-active-team", "all-teams");
      const { result } = renderHook(
        () => ({ context: useActiveTeam(), mutate: useSWRConfig().mutate }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.context.scope).toBe("all"));
      roleKey = "member";
      await act(async () => {
        await result.current.mutate(currentUserAuthorizationKey(USER_ID));
      });
      expect(result.current.context.scope).toBe("workspace");
      expect(localStorage.getItem("open-inspect-active-team")).toBe("workspace");

      roleKey = role;
      await act(async () => {
        await result.current.mutate(currentUserAuthorizationKey(USER_ID));
      });
      expect(result.current.context.scope).toBe("workspace");
      expect(localStorage.getItem("open-inspect-active-team")).toBe("workspace");
      act(() => result.current.context.setActiveTeam("all-teams"));
      expect(result.current.context.scope).toBe("all");
    }
  );

  it("waits for authorization before reconciling a stored aggregate scope", async () => {
    roleKey = "owner";
    localStorage.setItem("open-inspect-active-team", "all-teams");
    let resolveAuthorization: ((response: Response) => void) | undefined;
    const pendingAuthorization = new Promise<Response>((resolve) => {
      resolveAuthorization = resolve;
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/authorization" ? pendingAuthorization : membershipsResponse()
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.teams).toHaveLength(2));
    expect(result.current.loading).toBe(true);
    expect(result.current.scope).toBe("workspace");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");

    await act(async () => {
      resolveAuthorization?.(authorizationResponse());
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scope).toBe("all");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
  });

  it("blocks context readiness when authorization fails without discarding the preference", async () => {
    localStorage.setItem("open-inspect-active-team", "all-teams");
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/me/authorization"
        ? Response.json({ error: "Unavailable" }, { status: 503 })
        : membershipsResponse()
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.scope).toBe("workspace");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("all-teams");
  });

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

  it.each(["team_unknown", "team_old"])("falls back to Workspace for %s", async (id) => {
    localStorage.setItem("open-inspect-active-team", id);
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeTeamId).toBeNull();
    expect(result.current.scope).toBe("workspace");
    expect(localStorage.getItem("open-inspect-active-team")).toBe("workspace");
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

  it("does not become ready when the membership request fails", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );
    const { result } = renderHook(useActiveTeam, { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.teams).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
