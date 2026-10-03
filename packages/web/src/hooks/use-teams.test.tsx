// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import { useTeamCapabilities } from "./use-team-capabilities";
import { useWorkspaceTeamCapabilities } from "./use-workspace-team-capabilities";
import {
  TEAMS_KEY,
  isRetryableTeamError,
  teamCacheKey,
  useMeTeams,
  useTeam,
  useTeamMembers,
  useTeams,
} from "./use-teams";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
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

const readableTeam = {
  ...membership,
  capabilities: {
    canViewWork: true,
    canReadAutomations: true,
    canJoin: false,
    canLeave: false,
    canEditMetadata: false,
    canManageMembers: false,
    canManageRepositories: false,
    canManageBindings: false,
    canManageAutomations: false,
    canManageEnvironments: false,
    canManageSecrets: false,
    canArchive: false,
  },
};
const detailPath = "/api/teams/team_design";

function snapshotResponse(path: string) {
  if (path === ME_TEAMS_API_PATH)
    return Response.json({
      teams: [readableTeam],
      requireTeamOnCreate: true,
      capabilities: { canListAllTeams: true },
    });
  return Response.json(path === TEAMS_KEY ? { teams: [readableTeam] } : readableTeam);
}

function useSnapshots() {
  const mine = useMeTeams();
  const directory = useTeams();
  const detail = useTeam(membership.id);
  return {
    mine,
    directory,
    detail,
    grants: [
      useWorkspaceTeamCapabilities(mine).canListAllTeams,
      useTeamCapabilities(directory.teams[0]).canViewWork,
      useTeamCapabilities(detail.team).canReadAutomations,
    ],
    ...useSWRConfig(),
  };
}

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
        Response.json({
          teams: [membership],
          requireTeamOnCreate: true,
          capabilities: { canListAllTeams: true },
        })
      );
      const { result } = renderHook(
        () => {
          const mine = useMeTeams();
          return { mine, capabilities: useWorkspaceTeamCapabilities(mine), ...useSWRConfig() };
        },
        {
          wrapper,
        }
      );
      expect(result.current.mine.hasData).toBe(false);
      await waitFor(() => expect(result.current.mine.hasData).toBe(true));
      const cachedTeams = result.current.mine.teams;
      const cachedData = result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data;
      expect(cachedData).toEqual({
        teams: [membership],
        requireTeamOnCreate: true,
        capabilities: { canListAllTeams: true },
      });
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
      expect(result.current.capabilities.canListAllTeams).toBe(
        failure === 503 || failure === "network"
      );
      const refreshedData = result.current.cache.get(
        unstable_serialize(meTeamsKey("user_one"))
      )?.data;
      if (failure === 503 || failure === "network") expect(refreshedData).toBe(cachedData);
      else expect(refreshedData).toEqual({ ...cachedData, capabilities: undefined });
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
      Response.json({
        teams: [membership],
        requireTeamOnCreate: true,
        capabilities: { canListAllTeams: true },
      })
    );
    const { result, rerender } = renderHook(
      () => {
        const mine = useMeTeams();
        return {
          mine,
          capabilities: useWorkspaceTeamCapabilities(mine),
          mutate: useSWRConfig().mutate,
        };
      },
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
    expect(result.current.capabilities.canListAllTeams).toBe(true);
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
      capabilities: undefined,
    });
    expect(result.current.capabilities.canListAllTeams).toBe(false);
    await act(async () => {
      resolveMemberships?.(
        Response.json({ teams: [{ ...membership, id: "team_platform", name: "Platform" }] })
      );
    });
    await waitFor(() => expect(result.current.mine.hasData).toBe(true));
    expect(result.current.mine.teams.map((team) => team.id)).toEqual(["team_platform"]);
    expect(result.current.mine.requireTeamOnCreate).toBe(false);
    expect(result.current.capabilities.canListAllTeams).toBe(false);

    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();
    expect(result.current.mine).toMatchObject({
      teams: [],
      requireTeamOnCreate: false,
      loading: false,
      error: undefined,
      hasData: false,
      capabilities: undefined,
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
        () => {
          const mine = useMeTeams();
          return {
            mine,
            capabilities: useWorkspaceTeamCapabilities(mine),
            cache: useSWRConfig().cache,
          };
        },
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
        resolveOldMemberships?.(
          Response.json({
            teams: [membership],
            requireTeamOnCreate: true,
            capabilities: { canListAllTeams: true },
          })
        );
      });
      await waitFor(() =>
        expect(result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data).toEqual({
          teams: [membership],
          requireTeamOnCreate: true,
          capabilities: { canListAllTeams: true },
        })
      );
      expect(result.current.mine).toMatchObject({
        teams: [],
        requireTeamOnCreate: false,
        loading: false,
        error: undefined,
        hasData: transition === "account-switch",
      });
      expect(result.current.capabilities.canListAllTeams).toBe(false);
      expect(browserApiFetch).toHaveBeenCalledTimes(transition === "account-switch" ? 2 : 1);
    }
  );

  it.each([undefined, {}, { canListAllTeams: false }, { canListAllTeams: true }])(
    "decodes workspace capabilities %j without inferring grants from memberships",
    async (capabilities) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [{ ...membership, role: "lead" }], capabilities })
      );
      const { result } = renderHook(
        () => {
          const mine = useMeTeams();
          return { mine, capabilities: useWorkspaceTeamCapabilities(mine) };
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current.mine.hasData).toBe(true));
      expect(result.current.mine.error).toBeUndefined();
      expect(result.current.mine.teams[0]?.role).toBe("lead");
      expect(result.current.capabilities.canListAllTeams).toBe(
        capabilities?.canListAllTeams ?? false
      );
    }
  );

  it.each([undefined, null, {}, { capabilities: null }, { capabilities: {} }])(
    "denies workspace grants for an absent capability response %j",
    (workspace) => {
      const { result } = renderHook(() => useWorkspaceTeamCapabilities(workspace));
      expect(result.current.canListAllTeams).toBe(false);
    }
  );

  it.each([undefined, {}, { canListAllTeams: false }])(
    "revokes a cached workspace grant when a successful response returns capabilities %j",
    async (capabilities) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], capabilities: { canListAllTeams: true } })
      );
      const { result } = renderHook(
        () => {
          const mine = useMeTeams();
          return { mine, capabilities: useWorkspaceTeamCapabilities(mine), ...useSWRConfig() };
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current.mine.hasData).toBe(true));
      expect(result.current.capabilities.canListAllTeams).toBe(true);
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], capabilities })
      );
      await act(async () => {
        await result.current.mutate(meTeamsKey("user_one"));
      });
      expect(result.current.capabilities.canListAllTeams).toBe(false);
    }
  );

  it("withholds a cached workspace grant after an invalid capabilities refresh", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ teams: [membership], capabilities: { canListAllTeams: true } })
    );
    const { result } = renderHook(
      () => {
        const mine = useMeTeams();
        return { mine, capabilities: useWorkspaceTeamCapabilities(mine), ...useSWRConfig() };
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.mine.hasData).toBe(true));
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ teams: [membership], capabilities: { canListAllTeams: "true" } })
    );
    await act(async () => {
      await result.current.mutate(meTeamsKey("user_one"));
    });
    expect(result.current.mine.error).toBeInstanceOf(Error);
    expect(result.current.mine.capabilities).toBeUndefined();
    expect(result.current.capabilities.canListAllTeams).toBe(false);
  });

  it.each([503, "network"] as const)(
    "keeps terminal revocation across retryable %s refreshes until decoded success",
    async (failure) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
      vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
      const { result } = renderHook(useSnapshots, { wrapper });
      await waitFor(() => expect(result.current.grants).toEqual([true, true, true]));
      const cachedMemberships = result.current.mine.teams;
      const keys = [
        meTeamsKey("user_one"),
        teamCacheKey(TEAMS_KEY, "user_one"),
        teamCacheKey(detailPath, "user_one"),
      ];
      const refresh = () =>
        act(async () => {
          await Promise.all(keys.map((key) => result.current.mutate(key)));
        });

      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ error: "Forbidden" }, { status: 403 })
      );
      await refresh();
      expect(result.current.grants).toEqual([false, false, false]);

      vi.mocked(browserApiFetch).mockImplementation(async () => {
        if (failure === "network") throw new TypeError("Network unavailable");
        return Response.json({ error: "Unavailable" }, { status: failure });
      });
      await refresh();
      expect(result.current.grants).toEqual([false, false, false]);
      expect(isRetryableTeamError(result.current.mine.error)).toBe(true);
      expect(isRetryableTeamError(result.current.directory.error)).toBe(true);
      expect(isRetryableTeamError(result.current.detail.error)).toBe(true);
      expect(result.current.mine.teams).toBe(cachedMemberships);
      expect(result.current.mine).toMatchObject({ hasData: true, requireTeamOnCreate: true });
      expect(result.current.directory.teams[0]?.name).toBe("Design");
      expect(result.current.detail.team?.name).toBe("Design");
      for (const key of keys)
        expect(
          result.current.cache.get(unstable_serialize(key))?.data.capabilities
        ).toBeUndefined();
      expect(result.current.directory.teams[0]?.capabilities).toBeUndefined();

      vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
      await refresh();
      expect(result.current.grants).toEqual([true, true, true]);
      expect(result.current.mine.error).toBeUndefined();
      expect(result.current.directory.error).toBeUndefined();
      expect(result.current.detail.error).toBeUndefined();
    }
  );

  it("isolates directory and detail grants while a new viewer and late old responses are pending", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
    const { result, rerender } = renderHook(useSnapshots, { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([true, true, true]));
    const oldResponses = new Map<string, (response: Response) => void>();
    vi.mocked(browserApiFetch).mockImplementation(
      (path) => new Promise((resolve) => oldResponses.set(path, resolve))
    );
    let oldRefresh!: Promise<unknown>;
    act(() => {
      oldRefresh = Promise.all([
        result.current.mutate(teamCacheKey(TEAMS_KEY, "user_one")),
        result.current.mutate(teamCacheKey(detailPath, "user_one")),
      ]);
    });
    expect(oldResponses.size).toBe(2);

    const newResponses = new Map<string, (response: Response) => void>();
    vi.mocked(browserApiFetch).mockImplementation(
      (path) => new Promise((resolve) => newResponses.set(path, resolve))
    );
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_two", name: "Grace" } },
      status: "authenticated",
    });
    rerender();
    expect(result.current.grants).toEqual([false, false, false]);
    expect(result.current.directory).toMatchObject({ teams: [], loading: true, error: undefined });
    expect(result.current.detail).toMatchObject({
      team: undefined,
      loading: true,
      error: undefined,
    });

    await act(async () => {
      for (const [path, resolve] of oldResponses) resolve(snapshotResponse(path));
      await oldRefresh;
    });
    expect(result.current.grants).toEqual([false, false, false]);
    expect(result.current.directory.teams).toEqual([]);
    expect(result.current.detail.team).toBeUndefined();
    expect(
      result.current.cache.get(unstable_serialize(teamCacheKey(detailPath, "user_one")))?.data
    ).toMatchObject({ capabilities: { canViewWork: true } });

    const denied = {
      ...readableTeam,
      capabilities: { ...readableTeam.capabilities, canViewWork: false, canReadAutomations: false },
    };
    await act(async () => {
      newResponses.get(TEAMS_KEY)?.(Response.json({ teams: [denied] }));
      newResponses.get(detailPath)?.(Response.json(denied));
      newResponses.get(ME_TEAMS_API_PATH)?.(Response.json({ teams: [] }));
    });
    await waitFor(() => expect(result.current.detail.loading).toBe(false));
    expect(result.current.grants).toEqual([false, false, false]);
    expect(result.current.cache.get(TEAMS_KEY)).toBeUndefined();
    expect(result.current.cache.get(detailPath)).toBeUndefined();

    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();
    expect(result.current.directory.teams).toEqual([]);
    expect(result.current.detail.team).toBeUndefined();
    expect(result.current.grants).toEqual([false, false, false]);
  });

  it("revokes a late old-viewer terminal response only in that viewer's membership cache", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
    const { result, rerender } = renderHook(useSnapshots, { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([true, true, true]));
    const cachedMemberships = result.current.mine.teams;
    let finishOldRefresh!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishOldRefresh = resolve;
      })
    );
    let oldRefresh!: Promise<unknown>;
    act(() => {
      oldRefresh = result.current.mutate(meTeamsKey("user_one"));
    });
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_two", name: "Grace" } },
      status: "authenticated",
    });
    rerender();
    await waitFor(() => expect(result.current.grants).toEqual([true, true, true]));
    await act(async () => {
      finishOldRefresh(Response.json({ error: "Forbidden" }, { status: 403 }));
      await oldRefresh;
    });
    expect(result.current.grants).toEqual([true, true, true]);
    expect(
      result.current.cache.get(unstable_serialize(meTeamsKey("user_two")))?.data.capabilities
    ).toEqual({ canListAllTeams: true });
    const revoked = result.current.cache.get(unstable_serialize(meTeamsKey("user_one")))?.data;
    expect(revoked.capabilities).toBeUndefined();
    expect(revoked.teams).toBe(cachedMemberships);

    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Unavailable" }, { status: 503 })
    );
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    rerender();
    await act(async () => {
      await result.current.mutate(meTeamsKey("user_one"));
    });
    expect(result.current.grants[0]).toBe(false);
    expect(result.current.mine.teams).toBe(cachedMemberships);
  });

  it("does not let superseded terminal failures revoke a newer identical successful snapshot", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
    const { result } = renderHook(useSnapshots, { wrapper });
    await waitFor(() => expect(result.current.grants).toEqual([true, true, true]));
    const keys = [
      meTeamsKey("user_one"),
      teamCacheKey(TEAMS_KEY, "user_one"),
      teamCacheKey(detailPath, "user_one"),
    ];
    const oldResponses = new Map<string, (response: Response) => void>();
    vi.mocked(browserApiFetch).mockImplementation(
      (path) => new Promise((resolve) => oldResponses.set(path, resolve))
    );
    let oldRefresh!: Promise<unknown>;
    act(() => {
      oldRefresh = Promise.all(keys.map((key) => result.current.mutate(key)));
    });
    expect(oldResponses.size).toBe(3);
    vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
    await act(async () => {
      await Promise.all(keys.map((key) => result.current.mutate(key)));
    });
    await act(async () => {
      for (const resolve of oldResponses.values())
        resolve(Response.json({ error: "Forbidden" }, { status: 403 }));
      await oldRefresh;
    });
    expect(result.current.grants).toEqual([true, true, true]);
    expect(result.current.mine.error).toBeUndefined();
    expect(result.current.directory.error).toBeUndefined();
    expect(result.current.detail.error).toBeUndefined();
  });

  it.each([
    "create",
    "join",
    "update",
    "archive",
    "restore",
    "set-member",
    "remove-member",
  ] as const)(
    "keeps a late account-A %s mutation out of account-B caches and invalidations",
    async (operation) => {
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_one", name: "Ada" } },
        status: "authenticated",
      });
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
      let finishWrite!: (response: Response) => void;
      vi.mocked(browserApiFetch).mockImplementation((path, init) => {
        if (init?.method)
          return new Promise((resolve) => {
            finishWrite = resolve;
          });
        return Promise.resolve(
          path.endsWith("/members") ? Response.json({ members: [member] }) : snapshotResponse(path)
        );
      });
      const { result, rerender } = renderHook(
        () => ({ ...useSnapshots(), members: useTeamMembers(membership.id) }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.grants).toEqual([true, true, true]);
        expect(result.current.members.members).toHaveLength(1);
      });
      let pendingWrite!: Promise<unknown>;
      act(() => {
        if (operation === "create") {
          pendingWrite = result.current.directory.createTeam({ slug: "design", name: "Design" });
        } else if (operation === "join") {
          pendingWrite = result.current.directory.joinTeam(membership.id);
        } else if (operation === "update") {
          pendingWrite = result.current.detail.updateTeam({ name: "Updated by Ada" });
        } else if (operation === "archive" || operation === "restore") {
          pendingWrite = result.current.detail.changeArchive(operation === "archive");
        } else if (operation === "set-member") {
          pendingWrite = result.current.members.setMember("user_one", "member");
        } else {
          pendingWrite = result.current.members.removeMember("user_one");
        }
      });

      const denied = {
        ...readableTeam,
        capabilities: {
          ...readableTeam.capabilities,
          canViewWork: false,
          canReadAutomations: false,
        },
      };
      vi.mocked(browserApiFetch).mockImplementation(async (path) => {
        if (path === ME_TEAMS_API_PATH)
          return Response.json({ teams: [], capabilities: { canListAllTeams: false } });
        if (path.endsWith("/members")) return Response.json({ members: [] });
        return Response.json(path === TEAMS_KEY ? { teams: [denied] } : denied);
      });
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_two", name: "Grace" } },
        status: "authenticated",
      });
      rerender();
      await waitFor(() => {
        expect(result.current.mine.hasData).toBe(true);
        expect(result.current.directory.loading).toBe(false);
        expect(result.current.detail.loading).toBe(false);
        expect(result.current.members.loading).toBe(false);
      });
      const keys = [
        meTeamsKey("user_two"),
        teamCacheKey(TEAMS_KEY, "user_two"),
        teamCacheKey(detailPath, "user_two"),
        teamCacheKey(`${detailPath}/members`, "user_two"),
      ];
      const snapshots = keys.map((key) => result.current.cache.get(unstable_serialize(key))?.data);
      const callsBeforeCompletion = vi.mocked(browserApiFetch).mock.calls.length;
      await act(async () => {
        finishWrite(
          operation === "remove-member"
            ? new Response(null, { status: 204 })
            : Response.json(operation === "set-member" ? { member } : readableTeam)
        );
        await pendingWrite;
      });
      expect(result.current.grants).toEqual([false, false, false]);
      keys.forEach((key, index) => {
        expect(result.current.cache.get(unstable_serialize(key))?.data).toBe(snapshots[index]);
      });
      expect(browserApiFetch).toHaveBeenCalledTimes(callsBeforeCompletion);
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
      canViewWork: false,
      canReadAutomations: false,
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
        canViewWork: joined,
        canReadAutomations: false,
        canJoin: !joined,
        canLeave: joined,
        canEditMetadata: false,
        canManageMembers: false,
        canManageRepositories: false,
        canManageBindings: false,
        canManageAutomations: false,
        canManageEnvironments: false,
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
    const capabilities = renderHook(() => useTeamCapabilities(result.current.detail.team));
    expect(capabilities.result.current.canViewWork).toBe(true);
  });

  it("does not seed a partial directory when updating from a detail-only route", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    const updated = { ...membership, slug: "product-design", updatedAt: 2 };
    const otherTeam = { ...membership, id: "team_other", slug: "engineering" };
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") return Response.json(updated);
      if (path === "/api/teams") return Response.json({ teams: [updated, otherTeam] });
      return Response.json(membership);
    });
    const { result, rerender } = renderHook(
      ({ directoryEnabled }) => ({
        detail: useTeam(membership.id),
        directory: useTeams(directoryEnabled),
        cache: useSWRConfig().cache,
      }),
      { initialProps: { directoryEnabled: false }, wrapper }
    );
    await waitFor(() => expect(result.current.detail.team?.id).toBe(membership.id));

    await act(() => result.current.detail.updateTeam({ slug: "product-design" }));

    expect(
      result.current.cache.get(unstable_serialize(teamCacheKey(TEAMS_KEY, "user_one")))?.data
    ).toBeUndefined();
    expect(result.current.detail.team?.slug).toBe("product-design");
    expect(
      vi.mocked(browserApiFetch).mock.calls.filter(([path]) => path === "/api/teams")
    ).toHaveLength(0);

    rerender({ directoryEnabled: true });
    await waitFor(() => expect(result.current.directory.teams).toHaveLength(2));
    expect(result.current.directory.teams.map(({ id }) => id)).toEqual([
      membership.id,
      otherTeam.id,
    ]);
  });

  it("revalidates a mounted directory that has no data when a PATCH commits", async () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user_one", name: "Ada" } },
      status: "authenticated",
    });
    const updated = { ...membership, slug: "product-design", updatedAt: 2 };
    const otherTeam = { ...membership, id: "team_other", slug: "engineering" };
    let finishInitialDirectory!: (response: Response) => void;
    const initialDirectory = new Promise<Response>((resolve) => {
      finishInitialDirectory = resolve;
    });
    let directoryRequests = 0;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") return Response.json(updated);
      if (path === "/api/teams") {
        directoryRequests += 1;
        return directoryRequests === 1
          ? initialDirectory
          : Response.json({ teams: [updated, otherTeam] });
      }
      return Response.json(membership);
    });
    const { result } = renderHook(
      () => ({ detail: useTeam(membership.id), directory: useTeams() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.detail.team?.id).toBe(membership.id));
    expect(result.current.directory.teams).toEqual([]);

    await act(() => result.current.detail.updateTeam({ slug: "product-design" }));

    expect(directoryRequests).toBe(2);
    expect(result.current.directory.teams.map(({ id }) => id)).toEqual([
      membership.id,
      otherTeam.id,
    ]);
    expect(result.current.directory.teams[0]?.slug).toBe("product-design");
    await act(async () => {
      finishInitialDirectory(Response.json({ teams: [membership] }));
      await initialDirectory;
    });
    expect(result.current.directory.teams).toHaveLength(2);
    expect(result.current.directory.teams[0]?.slug).toBe("product-design");
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
        canViewWork: false,
        canReadAutomations: false,
      });
    }
  );

  it("loads a legacy lead through the settings list, preserving old grants and defaulting new ones", async () => {
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
                  canManageEnvironments: true,
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
    const capabilities = renderHook(() => useTeamCapabilities(result.current.teams[0]));
    expect(capabilities.result.current).toMatchObject({
      canEditMetadata: true,
      canManageMembers: true,
      canManageRepositories: true,
      canManageBindings: true,
      canManageAutomations: true,
      canManageEnvironments: true,
      canManageSecrets: true,
      canArchive: true,
      canViewWork: false,
      canReadAutomations: false,
    });
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
        canManageEnvironments: true,
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
