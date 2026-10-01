// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import { useTeamCapabilities } from "./use-team-capabilities";
import { isRetryableTeamError, useMeTeams, useTeam, useTeamMembers, useTeams } from "./use-teams";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
    {children}
  </SWRConfig>
);

const membership = {
  id: "team_design",
  slug: "design",
  name: "Design",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  role: "member",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
});

describe("team hooks", () => {
  it.each([undefined, false, true])(
    "loads membership responses with requireTeamOnCreate=%s without a decoder error",
    async (requireTeamOnCreate) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({
          teams: [],
          ...(requireTeamOnCreate === undefined ? {} : { requireTeamOnCreate }),
        })
      );
      const { result } = renderHook(useMeTeams, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBeUndefined();
      expect(result.current.hasData).toBe(true);
      expect(result.current.teams).toEqual([]);
      expect(result.current.requireTeamOnCreate).toBe(requireTeamOnCreate ?? false);
    }
  );

  it.each([503, 401, 403, "network", "invalid-json", "invalid-schema"] as const)(
    "exposes successful cached memberships alongside refresh failure %s",
    async (failure) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], requireTeamOnCreate: true })
      );
      const { result } = renderHook(() => ({ mine: useMeTeams(), ...useSWRConfig() }), {
        wrapper,
      });
      expect(result.current.mine.hasData).toBe(false);
      await waitFor(() => expect(result.current.mine.hasData).toBe(true));
      const cachedTeams = result.current.mine.teams;
      const cachedData = result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data;
      expect(cachedData).toEqual({ teams: [membership], requireTeamOnCreate: true });
      expect(result.current.cache.get(ME_TEAMS_API_PATH)).toBeUndefined();
      expect(browserApiFetch).toHaveBeenCalledWith(ME_TEAMS_API_PATH);

      vi.mocked(browserApiFetch).mockImplementation(async () => {
        if (failure === "network") throw new TypeError("Network unavailable");
        if (failure === "invalid-json") return new Response("Invalid JSON");
        if (failure === "invalid-schema") return Response.json({ teams: null });
        return Response.json({ error: "Unavailable" }, { status: failure });
      });
      await act(async () => {
        await result.current.mutate(meTeamsKey("user_one"));
      });

      expect(result.current.mine.error).toBeInstanceOf(Error);
      expect(isRetryableTeamError(result.current.mine.error)).toBe(
        failure === 503 || failure === "network"
      );
      expect(result.current.mine.teams).toBe(cachedTeams);
      expect(result.current.mine.requireTeamOnCreate).toBe(true);
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.mine.loading).toBe(false);
      expect(result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data).toBe(
        cachedData
      );
    }
  );

  it.each([undefined, null, new Error("Unknown failure"), { retryable: true }])(
    "does not classify an unrecognized error %j as retryable",
    (error) => {
      expect(isRetryableTeamError(error)).toBe(false);
    }
  );

  it("isolates cached memberships and errors on account switch and signout", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ teams: [membership], requireTeamOnCreate: true })
    );
    const { result, rerender } = renderHook(
      () => ({ mine: useMeTeams(), mutate: useSWRConfig().mutate }),
      {
        wrapper: ({ children }) => (
          <SWRConfig
            value={{
              provider: () => new Map(),
              dedupingInterval: 0,
              shouldRetryOnError: false,
              keepPreviousData: true,
            }}
          >
            {children}
          </SWRConfig>
        ),
      }
    );
    await waitFor(() => expect(result.current.mine.hasData).toBe(true));
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );
    await act(async () => {
      await result.current.mutate(meTeamsKey("user_one"));
    });
    expect(result.current.mine.error).toBeInstanceOf(Error);

    let resolveMemberships: ((response: Response) => void) | undefined;
    vi.mocked(browserApiFetch).mockReturnValue(
      new Promise((resolve) => {
        resolveMemberships = resolve;
      })
    );
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_two", name: "Grace" } },
      status: "authenticated",
    });
    rerender();
    expect(result.current.mine).toMatchObject({
      teams: [],
      requireTeamOnCreate: false,
      loading: true,
      error: undefined,
      hasData: false,
    });
    await act(async () => {
      resolveMemberships?.(
        Response.json({ teams: [{ ...membership, id: "team_platform", name: "Platform" }] })
      );
    });
    await waitFor(() => expect(result.current.mine.hasData).toBe(true));
    expect(result.current.mine.teams.map((team) => team.id)).toEqual(["team_platform"]);
    expect(result.current.mine.requireTeamOnCreate).toBe(false);

    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();
    expect(result.current.mine).toMatchObject({
      teams: [],
      requireTeamOnCreate: false,
      loading: false,
      error: undefined,
      hasData: false,
    });
    expect(browserApiFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["account-switch", "signout"] as const)(
    "does not expose an old in-flight membership response after %s",
    async (transition) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      let resolveOldMemberships: ((response: Response) => void) | undefined;
      vi.mocked(browserApiFetch).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldMemberships = resolve;
        })
      );
      vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ teams: [] }));
      const { result, rerender } = renderHook(
        () => ({ mine: useMeTeams(), cache: useSWRConfig().cache }),
        { wrapper }
      );
      expect(result.current.mine.hasData).toBe(false);

      vi.mocked(useAuthSession).mockReturnValue(
        transition === "account-switch"
          ? { data: { user: { id: "user_two", name: "Grace" } }, status: "authenticated" }
          : { data: null, status: "unauthenticated" }
      );
      rerender();
      if (transition === "account-switch") {
        await waitFor(() => expect(result.current.mine.hasData).toBe(true));
      }
      await act(async () => {
        resolveOldMemberships?.(Response.json({ teams: [membership], requireTeamOnCreate: true }));
      });
      await waitFor(() =>
        expect(result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data).toEqual({
          teams: [membership],
          requireTeamOnCreate: true,
        })
      );
      expect(result.current.mine).toMatchObject({
        teams: [],
        requireTeamOnCreate: false,
        loading: false,
        error: undefined,
        hasData: transition === "account-switch",
      });
      expect(browserApiFetch).toHaveBeenCalledTimes(transition === "account-switch" ? 2 : 1);
    }
  );

  it("preserves slug_taken on create conflicts", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Team slug already exists", code: "slug_taken" }, { status: 409 })
    );
    const { result } = renderHook(useTeams, { wrapper });
    await expect(
      act(() => result.current.createTeam({ slug: "design", name: "Design" }))
    ).rejects.toThrow("Team slug already exists (slug_taken)");
  });

  it("preserves last_lead on removal conflicts", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json(
        { error: "The last team lead cannot be removed", code: "last_lead" },
        { status: 409 }
      )
    );
    const { result } = renderHook(() => useTeamMembers("team_design"), { wrapper });
    await expect(act(() => result.current.removeMember("user_one"))).rejects.toThrow("last_lead");
  });

  it("preserves a server join conflict without inferring joinability", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json(
        { error: "Team join is no longer available", code: "join_unavailable" },
        { status: 409 }
      )
    );
    const { result } = renderHook(useTeams, { wrapper });
    await expect(act(() => result.current.joinTeam("team/one"))).rejects.toThrow(
      "join_unavailable"
    );
    expect(browserApiFetch).toHaveBeenCalledWith("/api/teams/team%2Fone/join", { method: "POST" });
  });

  it("does not load memberships while disabled", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    const { result } = renderHook(() => useMeTeams(false), { wrapper });
    expect(browserApiFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.hasData).toBe(false);
  });

  it("does not load the team directory while disabled", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    renderHook(() => useTeams(false), { wrapper });
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("loads legacy memberships without capabilities while denying privileged team controls", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({
        requireTeamOnCreate: false,
        teams: [
          {
            id: "team_design",
            slug: "design",
            name: "Design",
            description: null,
            joinPolicy: "invite_only",
            defaultVisibility: "workspace",
            defaultEnvironmentId: null,
            grantsVersion: 0,
            archivedAt: null,
            createdAt: 1,
            updatedAt: 1,
            memberCount: 1,
            role: "lead",
          },
        ],
      })
    );
    const { result } = renderHook(useMeTeams, { wrapper });
    await waitFor(() => expect(result.current.teams).toHaveLength(1));
    const capabilities = renderHook(() => useTeamCapabilities(result.current.teams[0]));
    expect(capabilities.result.current).toMatchObject({
      canEditMetadata: false,
      canManageMembers: false,
      canArchive: false,
    });
  });

  it("refreshes all-team and membership lists and caches the server's joined team", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    let joined = false;
    const team = () => ({
      id: "team_design",
      slug: "design",
      name: "Design",
      description: null,
      joinPolicy: "open",
      defaultVisibility: "team",
      defaultEnvironmentId: null,
      grantsVersion: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
      memberCount: joined ? 2 : 1,
      capabilities: {
        canJoin: !joined,
        canLeave: joined,
        canEditMetadata: false,
        canManageMembers: false,
        canManageRepositories: false,
        canManageBindings: false,
        canManageAutomations: false,
        canManageSecrets: false,
        canArchive: false,
      },
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith("/join") && init?.method === "POST") {
        joined = true;
        return Response.json(team());
      }
      if (path === "/api/teams") return Response.json({ teams: [team()] });
      if (path === "/api/me/teams")
        return Response.json({ teams: joined ? [{ ...team(), role: "member" }] : [] });
      return Response.json(team());
    });
    const { result } = renderHook(
      () => ({ all: useTeams(), mine: useMeTeams(), detail: useTeam("team_design") }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.detail.team?.memberCount).toBe(1));
    expect(result.current.mine.teams).toEqual([]);
    await act(() => result.current.all.joinTeam("team_design"));
    expect(result.current.all.teams[0]?.memberCount).toBe(2);
    expect(result.current.mine.teams[0]?.role).toBe("member");
    expect(result.current.detail.team?.capabilities?.canJoin).toBe(false);
  });

  it.each(["create", "update", "archive", "restore", "set-member", "remove-member"] as const)(
    "refreshes the user-scoped membership cache after %s",
    async (operation) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      let written = false;
      const member = {
        teamId: membership.id,
        userId: "user_one",
        role: "member",
        source: "manual",
        createdAt: 1,
        displayName: "Ada",
        email: null,
        avatarUrl: null,
      };
      vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
        if (init?.method) {
          written = true;
          if (init.method === "DELETE") return new Response(null, { status: 204 });
          if (init.method === "PUT") return Response.json({ member });
          return Response.json(membership);
        }
        if (path === ME_TEAMS_API_PATH) {
          return Response.json({
            teams: written ? [{ ...membership, name: "Refreshed" }] : [membership],
          });
        }
        if (path === "/api/teams") return Response.json({ teams: [membership] });
        if (path.endsWith("/members")) return Response.json({ members: [member] });
        return Response.json(membership);
      });
      const { result } = renderHook(
        () => ({
          mine: useMeTeams(),
          all: useTeams(),
          detail: useTeam(membership.id),
          members: useTeamMembers(membership.id),
        }),
        { wrapper }
      );
      await waitFor(() => expect(result.current.mine.teams[0]?.name).toBe("Design"));
      await act(async () => {
        if (operation === "create") {
          await result.current.all.createTeam({ slug: "design", name: "Design" });
        } else if (operation === "update") {
          await result.current.detail.updateTeam({ name: "Refreshed" });
        } else if (operation === "archive" || operation === "restore") {
          await result.current.detail.changeArchive(operation === "archive");
        } else if (operation === "set-member") {
          await result.current.members.setMember("user_one", "member");
        } else {
          await result.current.members.removeMember("user_one");
        }
      });
      expect(result.current.mine.teams[0]?.name).toBe("Refreshed");
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.mine.error).toBeUndefined();
    }
  );

  it.each([undefined, { canJoin: true }, { canEditMetadata: true }])(
    "keeps a team visible with missing or incomplete capabilities %j but denies every action",
    async (capabilities) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({
          requireTeamOnCreate: true,
          teams: [
            {
              id: "team_design",
              slug: "design",
              name: "Design",
              description: null,
              joinPolicy: "invite_only",
              defaultVisibility: "workspace",
              defaultEnvironmentId: null,
              grantsVersion: 0,
              archivedAt: null,
              createdAt: 1,
              updatedAt: 1,
              memberCount: 1,
              role: "lead",
              capabilities,
            },
          ],
        })
      );
      const { result } = renderHook(useMeTeams, { wrapper });
      await waitFor(() => expect(result.current.teams).toHaveLength(1));
      expect(result.current.requireTeamOnCreate).toBe(true);
      const actions = renderHook(() => useTeamCapabilities(result.current.teams[0]));
      expect(actions.result.current).toMatchObject({
        canJoin: false,
        canEditMetadata: false,
        canManageMembers: false,
        canArchive: false,
      });
    }
  );

  it("loads a lead through the single settings list endpoint", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      path === "/api/teams"
        ? Response.json({
            teams: [
              {
                id: "team_design",
                slug: "design",
                name: "Design",
                description: null,
                joinPolicy: "invite_only",
                defaultVisibility: "workspace",
                defaultEnvironmentId: null,
                grantsVersion: 0,
                archivedAt: null,
                createdAt: 1,
                updatedAt: 1,
                memberCount: 1,
                role: "lead",
                capabilities: {
                  canJoin: false,
                  canLeave: false,
                  canEditMetadata: true,
                  canManageMembers: true,
                  canManageRepositories: true,
                  canManageBindings: true,
                  canManageAutomations: true,
                  canManageSecrets: true,
                  canArchive: true,
                },
              },
            ],
          })
        : Response.json({ error: "Forbidden" }, { status: 403 })
    );
    const { result } = renderHook(useTeams, { wrapper });
    await waitFor(() => expect(result.current.teams[0]?.name).toBe("Design"));
    expect(browserApiFetch).toHaveBeenCalledWith("/api/teams");
  });

  it("does not report a committed creation as failed when the list refresh fails", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    let loaded = false;
    const created = {
      id: "team_design",
      slug: "design",
      name: "Design",
      description: null,
      joinPolicy: "invite_only",
      defaultVisibility: "workspace",
      defaultEnvironmentId: null,
      grantsVersion: 0,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
      memberCount: 1,
      capabilities: {
        canJoin: false,
        canLeave: false,
        canEditMetadata: true,
        canManageMembers: true,
        canManageRepositories: true,
        canManageBindings: true,
        canManageAutomations: true,
        canManageSecrets: true,
        canArchive: true,
      },
    };
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "POST") return Response.json(created, { status: 201 });
      if (path === "/api/teams" && !loaded) {
        loaded = true;
        return Response.json({ teams: [] });
      }
      return Response.json({ error: "Unavailable" }, { status: 503 });
    });
    const { result } = renderHook(useTeams, { wrapper });
    await waitFor(() => expect(loaded).toBe(true));
    await expect(
      act(() => result.current.createTeam({ slug: "design", name: "Design" }))
    ).resolves.toMatchObject({ id: created.id });
    expect(result.current.teams).toEqual([expect.objectContaining({ id: created.id })]);
  });

  it("does not report a committed removal as failed when access to members disappears", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada", email: "ada@example.com", image: null } },
      status: "authenticated",
    });
    let loaded = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/api/teams/team_design/members" && !loaded) {
        loaded = true;
        return Response.json({
          members: [
            {
              teamId: "team_design",
              userId: "user_one",
              role: "member",
              source: "manual",
              createdAt: 1,
              displayName: "Ada",
              email: "ada@example.com",
              avatarUrl: null,
            },
          ],
        });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    });
    const { result } = renderHook(() => useTeamMembers("team_design"), { wrapper });
    await waitFor(() => expect(result.current.members).toHaveLength(1));
    await expect(act(() => result.current.removeMember("user_one"))).resolves.toBeUndefined();
    expect(result.current.members).toEqual([]);
  });
});
