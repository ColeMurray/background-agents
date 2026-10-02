// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { TeamResponse } from "@/hooks/use-teams";
import { TeamPage } from "./team-page";

expect.extend(matchers);

const replace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user_one" } }, status: "authenticated" }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { role: { key: "owner" }, suspendedAt: null },
    hasPermission: (permission: string) => permission === "automations.read",
  }),
}));
vi.mock("./team-overview", () => ({ TeamOverview: () => <p>Team session buckets</p> }));
vi.mock("@/components/settings/team-members-table", () => ({
  TeamMembersTable: () => <p>Team member table</p>,
}));

let stored: TeamResponse;
let reusedSlugTeam: TeamResponse | undefined;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  reusedSlugTeam = undefined;
  stored = {
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
    memberCount: 0,
    capabilities: {
      canJoin: false,
      canLeave: false,
      canEditMetadata: true,
      canManageMembers: false,
      canManageRepositories: false,
      canManageBindings: false,
      canManageAutomations: false,
      canManageEnvironments: false,
      canManageSecrets: false,
      canArchive: true,
    },
  };
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/teams")
      return Response.json({
        teams:
          reusedSlugTeam && stored.slug !== reusedSlugTeam.slug
            ? [stored, reusedSlugTeam]
            : [stored],
      });
    if (path === "/api/me/teams") return Response.json({ teams: [] });
    if (path === "/api/teams/team_design/members") return Response.json({ members: [] });
    if (path === "/api/teams/team_design" && init?.method === "PATCH") {
      stored = { ...stored, ...JSON.parse(String(init.body)), updatedAt: 2 };
      return Response.json(stored);
    }
    if (path === "/api/teams/team_design") return Response.json(stored);
    if (path === "/api/teams/team_reused") return Response.json(reusedSlugTeam);
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(slug: string) {
  return render(<TeamPage slug={slug} />, {
    wrapper: ({ children }) => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    ),
  });
}

describe("TeamPage", () => {
  it.each([false, true])(
    "keeps the team after a Settings slug rename (old slug reused: %s)",
    async (reuseOldSlug) => {
      if (reuseOldSlug) reusedSlugTeam = { ...stored, id: "team_reused", name: "New Design Team" };
      renderPage("design");
      fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
        target: { value: "product-design" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
      );

      expect(fetchMock.mock.calls.filter(([path]) => path === "/api/teams")).toHaveLength(2);
      expect(screen.getByRole("heading", { level: 1, name: "Design" })).toBeInTheDocument();
      expect(screen.queryByText("Team not found.")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("product-design");
      expect(replace).toHaveBeenCalledWith("/teams/product-design");
    }
  );
});
