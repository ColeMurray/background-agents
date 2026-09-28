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
});
