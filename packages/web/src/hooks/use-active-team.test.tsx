// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ActiveTeamProvider, useActiveTeam } from "./use-active-team";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } }, status: "authenticated" }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

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
  vi.mocked(browserApiFetch).mockResolvedValue(
    Response.json({
      teams: [team("team_alpha"), team("team_beta"), team("team_old", 1)],
      requireTeamOnCreate: true,
    })
  );
});
afterEach(cleanup);

describe("active team context", () => {
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
