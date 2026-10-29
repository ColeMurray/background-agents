// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import {
  TEAMS_KEY,
  teamCacheKey,
  useMeTeams,
  useTeam,
  useTeamMembers,
  useTeams,
} from "./use-teams";
import {
  detailPath,
  member,
  membership,
  readableTeam,
  teamApiResponse,
  viewerSession,
  wrapper,
} from "./use-teams.test-support";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const otherViewer = {
  data: { user: { id: "user_two", name: "Grace" } },
  status: "authenticated" as const,
};

function useViewerTeams() {
  return {
    mine: useMeTeams(),
    directory: useTeams(),
    detail: useTeam(membership.id),
    members: useTeamMembers(membership.id),
    mutate: useSWRConfig().mutate,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue(viewerSession);
});
afterEach(cleanup);

describe("team viewer isolation", () => {
  it("isolates cached data and errors during an account switch and signout", async () => {
    vi.mocked(browserApiFetch).mockImplementation(async (path) => teamApiResponse(path));
    const { result, rerender } = renderHook(useViewerTeams, { wrapper });
    await waitFor(() => {
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.directory.teams).toHaveLength(1);
      expect(result.current.detail.team).toBeDefined();
      expect(result.current.members.members).toHaveLength(1);
    });
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status: 503 }));
    await act(async () => {
      await Promise.all([
        result.current.mutate(meTeamsKey("user_one")),
        result.current.mutate(teamCacheKey(TEAMS_KEY, "user_one")),
        result.current.mutate(teamCacheKey(detailPath, "user_one")),
        result.current.mutate(teamCacheKey(`${detailPath}/members`, "user_one")),
      ]);
    });
    expect(result.current.mine.error).toBeInstanceOf(Error);
    expect(result.current.directory.error).toBeInstanceOf(Error);
    expect(result.current.detail.error).toBeInstanceOf(Error);
    expect(result.current.members.error).toBeInstanceOf(Error);

    const pending = new Map<string, (response: Response) => void>();
    vi.mocked(browserApiFetch).mockImplementation(
      (path) => new Promise((resolve) => pending.set(path, resolve))
    );
    vi.mocked(useAuthSession).mockReturnValue(otherViewer);
    rerender();
    expect(result.current.mine).toMatchObject({
      teams: [],
      hasData: false,
      requireTeamOnCreate: false,
      canListAllTeams: false,
      loading: true,
      error: undefined,
    });
    expect(result.current.directory).toMatchObject({ teams: [], loading: true, error: undefined });
    expect(result.current.detail).toMatchObject({
      team: undefined,
      loading: true,
      error: undefined,
    });
    expect(result.current.members).toMatchObject({ members: [], loading: true, error: undefined });
    await waitFor(() => expect(pending.size).toBe(4));
    await act(async () => {
      for (const [path, resolve] of pending) {
        if (path === ME_TEAMS_API_PATH) resolve(Response.json({ teams: [] }));
        else if (path.endsWith("/members")) resolve(Response.json({ members: [] }));
        else resolve(teamApiResponse(path));
      }
    });
    await waitFor(() => {
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.detail.loading).toBe(false);
      expect(result.current.members.loading).toBe(false);
    });
    expect(result.current.mine.teams).toEqual([]);
    expect(result.current.mine.canListAllTeams).toBe(false);
    expect(result.current.mine.requireTeamOnCreate).toBe(false);
    expect(result.current.members.members).toEqual([]);

    const callsBeforeSignout = vi.mocked(browserApiFetch).mock.calls.length;
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();
    expect(result.current.mine).toMatchObject({
      teams: [],
      hasData: false,
      loading: false,
      error: undefined,
      canListAllTeams: false,
    });
    expect(result.current.directory).toMatchObject({ teams: [], loading: false, error: undefined });
    expect(result.current.detail).toMatchObject({
      team: undefined,
      loading: false,
      error: undefined,
    });
    expect(result.current.members).toMatchObject({ members: [], loading: false, error: undefined });
    expect(browserApiFetch).toHaveBeenCalledTimes(callsBeforeSignout);
  });

  it.each([
    { transition: "account-switch", status: 200 },
    { transition: "account-switch", status: 403 },
    { transition: "signout", status: 200 },
  ])(
    "does not expose old HTTP $status responses after $transition",
    async ({ transition, status }) => {
      const pending = new Map<string, (response: Response) => void>();
      vi.mocked(browserApiFetch).mockImplementation(
        (path) => new Promise((resolve) => pending.set(path, resolve))
      );
      const { result, rerender } = renderHook(useViewerTeams, { wrapper });
      await waitFor(() => expect(pending.size).toBe(4));
      const otherTeam = { ...readableTeam, name: "Visible to Grace" };
      vi.mocked(browserApiFetch).mockImplementation(async (path) => {
        if (path === ME_TEAMS_API_PATH) return Response.json({ teams: [] });
        if (path.endsWith("/members")) return Response.json({ members: [] });
        return Response.json(path === TEAMS_KEY ? { teams: [otherTeam] } : otherTeam);
      });
      vi.mocked(useAuthSession).mockReturnValue(
        transition === "account-switch" ? otherViewer : { data: null, status: "unauthenticated" }
      );
      rerender();
      if (transition === "account-switch") {
        await waitFor(() => {
          expect(result.current.mine.hasData).toBe(true);
          expect(result.current.directory.teams[0]?.name).toBe(otherTeam.name);
          expect(result.current.detail.team?.name).toBe(otherTeam.name);
          expect(result.current.members.loading).toBe(false);
        });
      }
      const current = result.current;
      await act(async () => {
        for (const [path, resolve] of pending)
          resolve(status === 200 ? teamApiResponse(path) : Response.json({}, { status }));
      });
      expect(result.current.mine.teams).toEqual([]);
      expect(result.current.mine.hasData).toBe(transition === "account-switch");
      expect(result.current.mine.canListAllTeams).toBe(false);
      expect(result.current.mine.requireTeamOnCreate).toBe(false);
      expect(result.current.directory.teams).toEqual(current.directory.teams);
      expect(result.current.detail.team).toBe(current.detail.team);
      expect(result.current.members.members).toEqual(current.members.members);
      for (const hook of [
        result.current.mine,
        result.current.directory,
        result.current.detail,
        result.current.members,
      ]) {
        expect(hook.error).toBeUndefined();
        expect(hook.loading).toBe(false);
      }
    }
  );

  it.each(["team", "member"] as const)(
    "keeps a late account-A %s write out of account-B data and invalidations",
    async (operation) => {
      let finishWrite!: (response: Response) => void;
      vi.mocked(browserApiFetch).mockImplementation((path, init) =>
        init?.method
          ? new Promise((resolve) => {
              finishWrite = resolve;
            })
          : Promise.resolve(teamApiResponse(path))
      );
      const { result, rerender } = renderHook(useViewerTeams, { wrapper });
      await waitFor(() => {
        expect(result.current.mine.hasData).toBe(true);
        expect(result.current.directory.teams).toHaveLength(1);
        expect(result.current.detail.team).toBeDefined();
        expect(result.current.members.members).toHaveLength(1);
      });
      let pendingWrite!: Promise<unknown>;
      act(() => {
        pendingWrite =
          operation === "team"
            ? result.current.detail.updateTeam({ name: "Updated by Ada" })
            : result.current.members.setMember("user_one", "lead");
      });
      const otherTeam = {
        ...readableTeam,
        name: "Grace's team",
        capabilities: {
          ...readableTeam.capabilities,
          canReadTeamSessions: false,
          canReadAutomations: false,
        },
      };
      vi.mocked(browserApiFetch).mockImplementation(async (path) => {
        if (path === ME_TEAMS_API_PATH) return Response.json({ teams: [] });
        if (path.endsWith("/members")) return Response.json({ members: [] });
        return Response.json(path === TEAMS_KEY ? { teams: [otherTeam] } : otherTeam);
      });
      vi.mocked(useAuthSession).mockReturnValue(otherViewer);
      rerender();
      await waitFor(() => {
        expect(result.current.mine.hasData).toBe(true);
        expect(result.current.directory.teams[0]?.name).toBe(otherTeam.name);
        expect(result.current.detail.team?.name).toBe(otherTeam.name);
        expect(result.current.members.loading).toBe(false);
      });
      const current = result.current;
      const callsBeforeCompletion = vi.mocked(browserApiFetch).mock.calls.length;
      await act(async () => {
        finishWrite(
          Response.json(
            operation === "team"
              ? { ...readableTeam, name: "Updated by Ada" }
              : { member: { ...member, role: "lead" } }
          )
        );
        await pendingWrite;
      });
      expect(result.current.mine.teams).toBe(current.mine.teams);
      expect(result.current.mine.canListAllTeams).toBe(false);
      expect(result.current.directory.teams).toBe(current.directory.teams);
      expect(result.current.detail.team).toBe(current.detail.team);
      expect(result.current.members.members).toBe(current.members.members);
      expect(browserApiFetch).toHaveBeenCalledTimes(callsBeforeCompletion);
    }
  );
});
