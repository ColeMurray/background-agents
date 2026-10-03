// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import { useTeamCapabilities } from "./use-team-capabilities";
import { TEAMS_KEY, useMeTeams, useTeam, useTeams } from "./use-teams";
import { membership, readableTeam, viewerSession, wrapper } from "./use-teams.test-support";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue(viewerSession);
});
afterEach(cleanup);

describe("team response defaults and capabilities", () => {
  it.each([undefined, false, true])(
    "loads memberships with requireTeamOnCreate=%s without a decoder error",
    async (requireTeamOnCreate) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [], requireTeamOnCreate })
      );
      const { result } = renderHook(useMeTeams, { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current).toMatchObject({
        error: undefined,
        hasData: true,
        teams: [],
        requireTeamOnCreate: requireTeamOnCreate ?? false,
        canListAllTeams: false,
      });
    }
  );

  it.each([undefined, {}, { canListAllTeams: false }, { canListAllTeams: true }])(
    "decodes workspace capabilities %j without inferring grants from a lead membership",
    async (capabilities) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [{ ...membership, role: "lead" }], capabilities })
      );
      const { result } = renderHook(useMeTeams, { wrapper });
      await waitFor(() => expect(result.current.hasData).toBe(true));
      expect(result.current.error).toBeUndefined();
      expect(result.current.teams[0]?.role).toBe("lead");
      expect(result.current.canListAllTeams).toBe(capabilities?.canListAllTeams ?? false);
    }
  );

  it.each([undefined, {}, { canListAllTeams: false }])(
    "revokes a cached workspace grant when a successful response returns capabilities %j",
    async (capabilities) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], capabilities: { canListAllTeams: true } })
      );
      const { result } = renderHook(() => ({ mine: useMeTeams(), mutate: useSWRConfig().mutate }), {
        wrapper,
      });
      await waitFor(() => expect(result.current.mine.canListAllTeams).toBe(true));
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], capabilities })
      );
      await act(async () => {
        await result.current.mutate(meTeamsKey("user_one"));
      });
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.mine.canListAllTeams).toBe(false);
      expect(result.current.mine.error).toBeUndefined();
    }
  );

  it.each([null, { canListAllTeams: "true" }])(
    "denies the entire membership snapshot for invalid workspace capabilities %j",
    async (capabilities) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({
          teams: [membership],
          requireTeamOnCreate: true,
          capabilities: { canListAllTeams: true },
        })
      );
      const { result } = renderHook(() => ({ mine: useMeTeams(), mutate: useSWRConfig().mutate }), {
        wrapper,
      });
      await waitFor(() => expect(result.current.mine.canListAllTeams).toBe(true));
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({ teams: [membership], capabilities })
      );
      await act(async () => {
        await result.current.mutate(meTeamsKey("user_one"));
      });
      expect(result.current.mine).toMatchObject({
        teams: [],
        hasData: false,
        canListAllTeams: false,
        requireTeamOnCreate: false,
      });
      expect(result.current.mine.error).toMatchObject({ disposition: "invalid-payload" });
    }
  );

  it.each([undefined, null, {}, { capabilities: null }, { capabilities: {} }])(
    "denies all team grants when the capability response is absent: %j",
    (team) => {
      const { result } = renderHook(() => useTeamCapabilities(team));
      expect(Object.values(result.current).every((value) => value === false)).toBe(true);
    }
  );

  it.each([undefined, { canJoin: true }, { canEditMetadata: true }])(
    "keeps a lead membership visible with capabilities %j but denies every action",
    async (capabilities) => {
      vi.mocked(browserApiFetch).mockResolvedValue(
        Response.json({
          requireTeamOnCreate: true,
          teams: [{ ...membership, role: "lead", capabilities }],
        })
      );
      const { result } = renderHook(
        () => {
          const mine = useMeTeams();
          return { mine, actions: useTeamCapabilities(mine.teams[0]) };
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current.mine.teams).toHaveLength(1));
      expect(result.current.mine.requireTeamOnCreate).toBe(true);
      expect(result.current.mine.error).toBeUndefined();
      expect(Object.values(result.current.actions).every((value) => value === false)).toBe(true);
    }
  );

  it("preserves legacy full action grants and defaults newer read grants on every browser endpoint", async () => {
    const legacy = {
      ...membership,
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
    };
    vi.mocked(browserApiFetch).mockImplementation(async (path) =>
      Response.json(path === TEAMS_KEY || path === ME_TEAMS_API_PATH ? { teams: [legacy] } : legacy)
    );
    const { result } = renderHook(
      () => {
        const mine = useMeTeams();
        const directory = useTeams();
        const detail = useTeam(membership.id);
        return {
          mine,
          directory,
          detail,
          grants: [
            useTeamCapabilities(mine.teams[0]),
            useTeamCapabilities(directory.teams[0]),
            useTeamCapabilities(detail.team),
          ],
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.directory.teams).toHaveLength(1);
      expect(result.current.detail.team).toBeDefined();
    });
    for (const capabilities of result.current.grants)
      expect(capabilities).toEqual({
        ...legacy.capabilities,
        canReadTeamSessions: false,
        canReadTeamRepositories: false,
        canReadTeamEnvironments: false,
        canReadAutomations: false,
      });
    expect(result.current.mine.error).toBeUndefined();
    expect(result.current.directory.error).toBeUndefined();
    expect(result.current.detail.error).toBeUndefined();
  });

  it.each([
    {
      canReadTeamSessions: true,
      canReadTeamRepositories: false,
      canReadTeamEnvironments: true,
      canReadAutomations: false,
    },
    {
      canReadTeamSessions: false,
      canReadTeamRepositories: true,
      canReadTeamEnvironments: false,
      canReadAutomations: true,
    },
  ])("preserves independent server-computed read grants %j", async (readGrants) => {
    const capabilities = { ...readableTeam.capabilities, ...readGrants, canEditMetadata: true };
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ teams: [{ ...membership, capabilities }] })
    );
    const { result } = renderHook(
      () => {
        const mine = useMeTeams();
        return { mine, capabilities: useTeamCapabilities(mine.teams[0]) };
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.mine.hasData).toBe(true));
    expect(result.current.capabilities).toEqual(capabilities);
  });
});
