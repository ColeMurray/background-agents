// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { ME_TEAMS_API_PATH, meTeamsKey } from "@/lib/me-teams-cache";
import { isRetryableTeamError, TeamRequestError } from "@/lib/team-snapshot";
import { useTeamCapabilities } from "./use-team-capabilities";
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
  snapshotResponse,
  viewerSession,
  wrapper,
} from "./use-teams.test-support";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

function useSnapshots() {
  return {
    mine: useMeTeams(),
    directory: useTeams(),
    detail: useTeam(membership.id),
    mutate: useSWRConfig().mutate,
  };
}

const snapshotKeys = [
  meTeamsKey("user_one"),
  teamCacheKey(TEAMS_KEY, "user_one"),
  teamCacheKey(detailPath, "user_one"),
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue(viewerSession);
});
afterEach(cleanup);

describe("team hooks", () => {
  it.each([408, 429, 503, "network"] as const)(
    "retains successful public snapshots after transient refresh failure %s",
    async (failure) => {
      vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
      const { result } = renderHook(useSnapshots, { wrapper });
      await waitFor(() => {
        expect(result.current.mine.hasData).toBe(true);
        expect(result.current.directory.teams).toHaveLength(1);
        expect(result.current.detail.team).toBeDefined();
      });
      const { mine, directory, detail } = result.current;
      vi.mocked(browserApiFetch).mockImplementation(async () => {
        if (failure === "network") throw new TypeError("Network unavailable");
        return Response.json({ error: "Unavailable" }, { status: failure });
      });
      await act(async () => {
        await Promise.all(snapshotKeys.map((key) => result.current.mutate(key)));
      });

      expect(result.current.mine.teams).toBe(mine.teams);
      expect(result.current.directory.teams).toBe(directory.teams);
      expect(result.current.detail.team).toBe(detail.team);
      expect(result.current.mine).toMatchObject({
        hasData: true,
        loading: false,
        requireTeamOnCreate: true,
        canListAllTeams: true,
      });
      for (const snapshot of [
        result.current.mine,
        result.current.directory,
        result.current.detail,
      ]) {
        expect(snapshot.loading).toBe(false);
        expect(snapshot.error).toBeInstanceOf(TeamRequestError);
        expect(isRetryableTeamError(snapshot.error)).toBe(true);
      }
    }
  );

  it.each([401, 403, 404, "invalid-json", "invalid-schema"] as const)(
    "hides denied public snapshots after %s until a decoded success",
    async (failure) => {
      vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
      const { result } = renderHook(useSnapshots, { wrapper });
      await waitFor(() => {
        expect(result.current.mine.hasData).toBe(true);
        expect(result.current.directory.teams).toHaveLength(1);
        expect(result.current.detail.team).toBeDefined();
      });
      vi.mocked(browserApiFetch).mockImplementation(async () => {
        if (failure === "invalid-json") return new Response("Invalid JSON");
        if (failure === "invalid-schema") return Response.json({ teams: null });
        return Response.json({ error: "Denied" }, { status: failure });
      });
      await act(async () => {
        await Promise.all(snapshotKeys.map((key) => result.current.mutate(key)));
      });
      const denials = [
        result.current.mine.error,
        result.current.directory.error,
        result.current.detail.error,
      ];
      expect(result.current.mine).toMatchObject({
        teams: [],
        hasData: false,
        loading: false,
        requireTeamOnCreate: false,
        canListAllTeams: false,
      });
      expect(result.current.directory.teams).toEqual([]);
      expect(result.current.detail.team).toBeUndefined();
      for (const error of denials) {
        expect(error).toBeInstanceOf(TeamRequestError);
        expect(error).toMatchObject({
          disposition: typeof failure === "number" ? "authoritative-denial" : "invalid-payload",
        });
        expect(isRetryableTeamError(error)).toBe(false);
      }

      vi.mocked(browserApiFetch).mockResolvedValue(Response.json({}, { status: 429 }));
      await act(async () => {
        await Promise.all(snapshotKeys.map((key) => result.current.mutate(key)));
      });
      expect(result.current.mine.hasData).toBe(false);
      expect(result.current.mine.teams).toEqual([]);
      expect(result.current.mine.requireTeamOnCreate).toBe(false);
      expect(result.current.mine.canListAllTeams).toBe(false);
      expect(result.current.directory.teams).toEqual([]);
      expect(result.current.detail.team).toBeUndefined();
      expect(result.current.mine.error).toBe(denials[0]);
      expect(result.current.directory.error).toBe(denials[1]);
      expect(result.current.detail.error).toBe(denials[2]);

      vi.mocked(browserApiFetch).mockImplementation(async (path) => snapshotResponse(path));
      await act(async () => {
        await Promise.all(snapshotKeys.map((key) => result.current.mutate(key)));
      });
      expect(result.current.mine).toMatchObject({
        hasData: true,
        requireTeamOnCreate: true,
        canListAllTeams: true,
        error: undefined,
      });
      expect(result.current.directory.teams[0]?.name).toBe("Design");
      expect(result.current.detail.team?.name).toBe("Design");
      expect(result.current.directory.error).toBeUndefined();
      expect(result.current.detail.error).toBeUndefined();
    }
  );

  it("preserves slug_taken on create conflicts", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ error: "Team slug already exists", code: "slug_taken" }, { status: 409 })
    );
    const { result } = renderHook(useTeams, { wrapper });
    await expect(
      act(() => result.current.createTeam({ slug: "design", name: "Design" }))
    ).rejects.toThrow("Team slug already exists (slug_taken)");
  });

  it("preserves last_lead on removal conflicts", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json(
        { error: "The last team lead cannot be removed", code: "last_lead" },
        { status: 409 }
      )
    );
    const { result } = renderHook(() => useTeamMembers(membership.id), { wrapper });
    await expect(act(() => result.current.removeMember("user_one"))).rejects.toThrow("last_lead");
  });

  it("preserves a server join conflict without inferring joinability", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
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

  it("does not load disabled membership or directory hooks", () => {
    const { result } = renderHook(() => ({ mine: useMeTeams(false), directory: useTeams(false) }), {
      wrapper,
    });
    expect(browserApiFetch).not.toHaveBeenCalled();
    expect(result.current.mine).toMatchObject({ loading: false, hasData: false, teams: [] });
    expect(result.current.directory.loading).toBe(false);
    expect(result.current.directory.teams).toEqual([]);
  });

  it("refreshes lists and members and exposes the server's joined team", async () => {
    let joined = false;
    const team = () => ({
      ...readableTeam,
      joinPolicy: "open",
      memberCount: joined ? 2 : 1,
      grantsVersion: joined ? 1 : 0,
      capabilities: {
        ...readableTeam.capabilities,
        canReadTeamSessions: joined,
        canReadTeamRepositories: false,
        canReadTeamEnvironments: joined,
        canReadAutomations: false,
        canJoin: !joined,
        canLeave: joined,
      },
    });
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (path.endsWith("/join") && init?.method === "POST") {
        joined = true;
        return Response.json(team());
      }
      if (path === TEAMS_KEY) return Response.json({ teams: [team()] });
      if (path === ME_TEAMS_API_PATH) return Response.json({ teams: joined ? [team()] : [] });
      if (path.endsWith("/members")) return Response.json({ members: joined ? [member] : [] });
      return Response.json(team());
    });
    const { result } = renderHook(
      () => {
        const detail = useTeam(membership.id);
        return {
          all: useTeams(),
          mine: useMeTeams(),
          detail,
          members: useTeamMembers(membership.id),
          capabilities: useTeamCapabilities(detail.team),
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.detail.team?.memberCount).toBe(1);
      expect(result.current.all.teams).toHaveLength(1);
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.members.loading).toBe(false);
    });
    expect(result.current.mine.teams).toEqual([]);
    await act(() => result.current.all.joinTeam(membership.id));
    expect(result.current.all.teams[0]?.memberCount).toBe(2);
    expect(result.current.mine.teams[0]?.role).toBe("member");
    expect(result.current.detail.team?.grantsVersion).toBe(1);
    expect(result.current.members.members).toHaveLength(1);
    expect(result.current.capabilities).toMatchObject({
      canJoin: false,
      canLeave: true,
      canReadTeamSessions: true,
      canReadTeamRepositories: false,
      canReadTeamEnvironments: true,
      canReadAutomations: false,
    });
  });

  it("reconciles a renamed team and its grants without replacing unrelated directory entries", async () => {
    const otherTeam = { ...readableTeam, id: "team_other", slug: "engineering" };
    const updated = {
      ...readableTeam,
      slug: "product-design",
      name: "Product Design",
      grantsVersion: 3,
      updatedAt: 2,
      capabilities: {
        ...readableTeam.capabilities,
        canReadTeamSessions: false,
        canReadTeamRepositories: true,
        canEditMetadata: true,
      },
    };
    let written = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") {
        written = true;
        return Response.json(updated);
      }
      if (path === TEAMS_KEY) return Response.json({ teams: [readableTeam, otherTeam] });
      if (path === ME_TEAMS_API_PATH)
        return Response.json({ teams: [written ? updated : readableTeam] });
      return Response.json(readableTeam);
    });
    const { result } = renderHook(useSnapshots, { wrapper });
    await waitFor(() => {
      expect(result.current.directory.teams).toHaveLength(2);
      expect(result.current.detail.team).toBeDefined();
      expect(result.current.mine.hasData).toBe(true);
    });
    const unrelated = result.current.directory.teams[1];
    await act(() => result.current.detail.updateTeam({ slug: updated.slug, name: updated.name }));
    expect(result.current.detail.team).toMatchObject({
      slug: updated.slug,
      name: updated.name,
      grantsVersion: 3,
      capabilities: updated.capabilities,
    });
    expect(result.current.directory.teams).toHaveLength(2);
    expect(result.current.directory.teams.find(({ id }) => id === membership.id)).toBe(
      result.current.detail.team
    );
    expect(result.current.directory.teams.find(({ id }) => id === otherTeam.id)).toBe(unrelated);
    expect(result.current.mine.teams[0]?.name).toBe(updated.name);
    expect(
      vi.mocked(browserApiFetch).mock.calls.filter(([path]) => path === TEAMS_KEY)
    ).toHaveLength(1);
  });

  it("does not seed a partial directory when updating from a detail-only route", async () => {
    const updated = { ...membership, slug: "product-design", updatedAt: 2 };
    const otherTeam = { ...membership, id: "team_other", slug: "engineering" };
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") return Response.json(updated);
      if (path === TEAMS_KEY) return Response.json({ teams: [updated, otherTeam] });
      return Response.json(membership);
    });
    const { result, rerender } = renderHook(
      ({ directoryEnabled }) => ({
        detail: useTeam(membership.id),
        directory: useTeams(directoryEnabled),
      }),
      { initialProps: { directoryEnabled: false }, wrapper }
    );
    await waitFor(() => expect(result.current.detail.team?.id).toBe(membership.id));
    await act(() => result.current.detail.updateTeam({ slug: updated.slug }));
    expect(result.current.directory.teams).toEqual([]);
    expect(result.current.detail.team?.slug).toBe(updated.slug);
    expect(
      vi.mocked(browserApiFetch).mock.calls.filter(([path]) => path === TEAMS_KEY)
    ).toHaveLength(0);

    rerender({ directoryEnabled: true });
    await waitFor(() => expect(result.current.directory.teams).toHaveLength(2));
    expect(result.current.directory.teams.map(({ id }) => id)).toEqual([
      membership.id,
      otherTeam.id,
    ]);
  });

  it("revalidates a mounted directory with no data when a PATCH commits", async () => {
    const updated = { ...membership, slug: "product-design", updatedAt: 2 };
    const otherTeam = { ...membership, id: "team_other", slug: "engineering" };
    let finishInitialDirectory!: (response: Response) => void;
    const initialDirectory = new Promise<Response>((resolve) => {
      finishInitialDirectory = resolve;
    });
    let directoryRequests = 0;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") return Response.json(updated);
      if (path === TEAMS_KEY) {
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
    await act(() => result.current.detail.updateTeam({ slug: updated.slug }));
    expect(directoryRequests).toBe(2);
    expect(result.current.directory.teams.map(({ id }) => id)).toEqual([
      membership.id,
      otherTeam.id,
    ]);
    expect(result.current.directory.teams[0]?.slug).toBe(updated.slug);
    await act(async () => {
      finishInitialDirectory(Response.json({ teams: [membership] }));
      await initialDirectory;
    });
    expect(result.current.directory.teams).toHaveLength(2);
    expect(result.current.directory.teams[0]?.slug).toBe(updated.slug);
  });

  it.each(["absent", "pending", "denied"] as const)(
    "does not seed a partial directory when creating while the directory is %s",
    async (state) => {
      const created = { ...readableTeam, id: "team_created", slug: "created" };
      let finishInitialDirectory!: (response: Response) => void;
      const initialDirectory = new Promise<Response>((resolve) => {
        finishInitialDirectory = resolve;
      });
      let directoryRequests = 0;
      vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
        if (init?.method === "POST") return Response.json(created, { status: 201 });
        if (path === TEAMS_KEY) {
          directoryRequests += 1;
          if (directoryRequests === 1 && state === "pending") return initialDirectory;
          if (directoryRequests === 1 && state === "denied")
            return Response.json({ error: "Forbidden" }, { status: 403 });
          return Response.json({ teams: [readableTeam, created] });
        }
        return Response.json({ teams: [] });
      });
      const { result, rerender } = renderHook(({ enabled }) => useTeams(enabled), {
        initialProps: { enabled: state !== "absent" },
        wrapper,
      });
      if (state === "denied") {
        await waitFor(() =>
          expect(result.current.error).toMatchObject({ disposition: "authoritative-denial" })
        );
      } else if (state === "pending") {
        await waitFor(() => expect(directoryRequests).toBe(1));
        expect(result.current.loading).toBe(true);
      }

      await act(async () => {
        await expect(
          result.current.createTeam({ slug: created.slug, name: created.name })
        ).resolves.toMatchObject({ id: created.id });
      });
      if (state === "absent") {
        expect(directoryRequests).toBe(0);
        rerender({ enabled: true });
        expect(result.current.teams).toEqual([]);
      }
      await waitFor(() =>
        expect(result.current.teams.map(({ id }) => id)).toEqual([readableTeam.id, created.id])
      );
      expect(directoryRequests).toBe(state === "absent" ? 1 : 2);
      expect(result.current.error).toBeUndefined();
      if (state === "pending") {
        await act(async () => {
          finishInitialDirectory(Response.json({ teams: [readableTeam] }));
          await initialDirectory;
        });
        expect(result.current.teams.map(({ id }) => id)).toEqual([readableTeam.id, created.id]);
      }
    }
  );

  it.each(["create", "update", "archive", "restore", "set-member", "remove-member"] as const)(
    "refreshes the user-scoped membership cache after %s",
    async (operation) => {
      let written = false;
      vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
        if (init?.method) {
          written = true;
          if (init.method === "DELETE") return new Response(null, { status: 204 });
          if (init.method === "PUT") return Response.json({ member });
          return Response.json(membership);
        }
        if (path === ME_TEAMS_API_PATH)
          return Response.json({
            teams: written ? [{ ...membership, name: "Refreshed" }] : [membership],
          });
        if (path === TEAMS_KEY) return Response.json({ teams: [membership] });
        if (path.endsWith("/members")) return Response.json({ members: [member] });
        return Response.json(membership);
      });
      const { result } = renderHook(
        () => ({ ...useSnapshots(), members: useTeamMembers(membership.id) }),
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.mine.teams[0]?.name).toBe("Design");
        expect(result.current.directory.loading).toBe(false);
        expect(result.current.detail.loading).toBe(false);
        expect(result.current.members.loading).toBe(false);
      });
      await act(async () => {
        if (operation === "create")
          await result.current.directory.createTeam({ slug: "design", name: "Design" });
        else if (operation === "update")
          await result.current.detail.updateTeam({ name: "Refreshed" });
        else if (operation === "archive" || operation === "restore")
          await result.current.detail.changeArchive(operation === "archive");
        else if (operation === "set-member")
          await result.current.members.setMember("user_one", "member");
        else await result.current.members.removeMember("user_one");
      });
      expect(result.current.mine.teams[0]?.name).toBe("Refreshed");
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.mine.error).toBeUndefined();
    }
  );

  it("reconciles member roles and removals while refreshing team grant versions", async () => {
    const otherMember = { ...member, userId: "user_two", displayName: "Grace" };
    let version = 0;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "PUT") {
        version += 1;
        return Response.json({ member: { ...member, role: "lead" } });
      }
      if (init?.method === "DELETE") {
        version += 1;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/members")) return Response.json({ members: [member, otherMember] });
      const team = { ...readableTeam, grantsVersion: version };
      return Response.json(
        path === TEAMS_KEY || path === ME_TEAMS_API_PATH ? { teams: [team] } : team
      );
    });
    const { result } = renderHook(
      () => ({ ...useSnapshots(), members: useTeamMembers(membership.id) }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.members.members).toHaveLength(2);
      expect(result.current.detail.team?.grantsVersion).toBe(0);
      expect(result.current.directory.teams).toHaveLength(1);
      expect(result.current.mine.hasData).toBe(true);
    });
    const unrelated = result.current.members.members[1];
    await act(() => result.current.members.setMember("user_one", "lead"));
    expect(result.current.members.members.find(({ userId }) => userId === "user_one")?.role).toBe(
      "lead"
    );
    expect(result.current.members.members.find(({ userId }) => userId === "user_two")).toBe(
      unrelated
    );
    expect(result.current.detail.team?.grantsVersion).toBe(1);
    expect(result.current.directory.teams[0]?.grantsVersion).toBe(1);
    expect(result.current.mine.teams[0]?.grantsVersion).toBe(1);
    await act(() => result.current.members.removeMember("user_one"));
    expect(result.current.members.members).toEqual([unrelated]);
    expect(result.current.members.members[0]).toBe(unrelated);
    expect(result.current.detail.team?.grantsVersion).toBe(2);
    expect(result.current.directory.teams[0]?.grantsVersion).toBe(2);
    expect(result.current.mine.teams[0]?.grantsVersion).toBe(2);
  });

  it("exposes a committed creation even when membership refresh fails", async () => {
    const existing = { ...readableTeam, id: "team_existing", slug: "existing" };
    let written = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "POST") {
        written = true;
        return Response.json(readableTeam, { status: 201 });
      }
      if (path === TEAMS_KEY) return Response.json({ teams: [existing] });
      if (!written) return Response.json({ teams: [existing] });
      return Response.json({}, { status: 503 });
    });
    const { result } = renderHook(() => ({ directory: useTeams(), mine: useMeTeams() }), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.directory.teams).toHaveLength(1);
      expect(result.current.mine.hasData).toBe(true);
    });
    const unrelated = result.current.directory.teams[0];
    await expect(
      act(() => result.current.directory.createTeam({ slug: "design", name: "Design" }))
    ).resolves.toMatchObject({ id: membership.id });
    expect(result.current.directory.teams.map(({ id }) => id)).toEqual([
      existing.id,
      membership.id,
    ]);
    expect(result.current.directory.teams[0]).toBe(unrelated);
    expect(result.current.directory.error).toBeUndefined();
    expect(result.current.mine.error).toMatchObject({ disposition: "transient" });
    expect(result.current.mine.hasData).toBe(true);
  });

  it("does not report a committed removal as failed when access to members disappears", async () => {
    let removed = false;
    vi.mocked(browserApiFetch).mockImplementation(async (path, init) => {
      if (init?.method === "DELETE") {
        removed = true;
        return new Response(null, { status: 204 });
      }
      return removed
        ? Response.json({ error: "Not found" }, { status: 404 })
        : snapshotResponse(path);
    });
    const { result } = renderHook(
      () => ({ ...useSnapshots(), members: useTeamMembers(membership.id) }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.members.members).toHaveLength(1);
      expect(result.current.mine.hasData).toBe(true);
      expect(result.current.directory.teams).toHaveLength(1);
      expect(result.current.detail.team).toBeDefined();
    });
    await expect(
      act(() => result.current.members.removeMember("user_one"))
    ).resolves.toBeUndefined();
    expect(result.current.members.members).toEqual([]);
    expect(result.current.mine.hasData).toBe(false);
    expect(result.current.directory.teams).toEqual([]);
    expect(result.current.detail.team).toBeUndefined();
    expect(result.current.mine.error).toMatchObject({ disposition: "authoritative-denial" });
  });
});
