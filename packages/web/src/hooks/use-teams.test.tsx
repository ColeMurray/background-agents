// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useTeamCapabilities } from "./use-team-capabilities";
import { useMeTeams, useTeamMembers, useTeams } from "./use-teams";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

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
      expect(result.current.teams).toEqual([]);
      expect(result.current.requireTeamOnCreate).toBe(requireTeamOnCreate ?? false);
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

  it("accepts a missing capabilities object but denies every team action", async () => {
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
