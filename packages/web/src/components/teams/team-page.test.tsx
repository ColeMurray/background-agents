// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, useSWRConfig } from "swr";
import type { TeamResponse } from "@/hooks/use-teams";
import { TeamPage } from "./team-page";

expect.extend(matchers);

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const { replace } = router;

vi.mock("next/navigation", () => ({ useRouter: () => router }));
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
let directoryRefresh: "fresh" | "stale" | "failed";
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  reusedSlugTeam = undefined;
  directoryRefresh = "fresh";
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
  const initialTeam = stored;
  const otherTeam = { ...stored, id: "team_other", slug: "engineering", name: "Engineering" };
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/teams") {
      if (stored !== initialTeam && directoryRefresh === "failed")
        return Response.json({ error: "Unavailable" }, { status: 503 });
      return Response.json({
        teams: [
          ...(reusedSlugTeam && stored.slug !== reusedSlugTeam.slug
            ? [stored, reusedSlugTeam]
            : [directoryRefresh === "stale" ? initialTeam : stored]),
          otherTeam,
        ],
      });
    }
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
  const cache = new Map();
  const view = render(<TeamPage slug={slug} />, {
    wrapper: ({ children }) => (
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          shouldRetryOnError: false,
        }}
      >
        <RefreshDirectory />
        {children}
      </SWRConfig>
    ),
  });
  return { ...view, cache };
}

function RefreshDirectory() {
  const { mutate } = useSWRConfig();
  return <button onClick={() => void mutate("/api/teams")}>Refresh directory</button>;
}

describe("TeamPage", () => {
  it.each([
    ["fresh", false],
    ["fresh", true],
    ["stale", false],
    ["failed", false],
  ] as const)(
    "keeps the PATCH result after a slug rename (directory: %s, old slug reused: %s)",
    async (refresh, reuseOldSlug) => {
      directoryRefresh = refresh;
      if (reuseOldSlug) reusedSlugTeam = { ...stored, id: "team_reused", name: "New Design Team" };
      const { cache } = renderPage("design");
      fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
        target: { value: "product-design" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
      );

      expect(screen.getByRole("heading", { level: 1, name: "Design" })).toBeInTheDocument();
      expect(screen.queryByText("Team not found.")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("product-design");
      expect(replace).toHaveBeenCalledWith("/teams/product-design");
      expect(cache.get("/api/teams")?.data?.teams).toContainEqual(stored);
      expect(cache.get("/api/teams")?.data?.teams).toContainEqual(
        expect.objectContaining({ id: "team_other", slug: "engineering" })
      );
      expect(cache.get("/api/teams/team_design")?.data).toEqual(stored);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/api/teams")).toHaveLength(1);

      if (reuseOldSlug) {
        fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
        await waitFor(() =>
          expect(cache.get("/api/teams")?.data?.teams).toContainEqual(reusedSlugTeam)
        );
        expect(screen.getByRole("heading", { level: 1, name: "Design" })).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("product-design");
        expect(replace).toHaveBeenCalledTimes(1);
      }
    }
  );

  it.each(["rerender", "remount"] as const)(
    "resolves the canonical route after %s with a stale directory",
    async (navigation) => {
      directoryRefresh = "stale";
      stored = { ...stored, slug: "product-design", updatedAt: 2 };
      const { cache, rerender } = renderPage("design");

      await waitFor(() => expect(replace).toHaveBeenCalledWith("/teams/product-design"));

      rerender(
        <TeamPage
          key={navigation === "remount" ? "canonical-route" : undefined}
          slug="product-design"
        />
      );

      expect(cache.get("/api/teams")?.data?.teams).toContainEqual(
        expect.objectContaining({ id: "team_design", slug: "product-design" })
      );
      expect(screen.getByRole("heading", { level: 1, name: "Design" })).toBeInTheDocument();
      expect(screen.queryByText("Team not found.")).not.toBeInTheDocument();
    }
  );

  it.each(["stale", "failed", "forbidden"] as const)(
    "reconciles the PATCH while an older directory refresh is %s",
    async (refresh) => {
      const initialTeam = stored;
      const { cache } = renderPage("design");
      fireEvent.click(await screen.findByRole("button", { name: "Settings" }));

      let finishRefresh!: (response: Response) => void;
      const pendingRefresh = new Promise<Response>((resolve) => {
        finishRefresh = resolve;
      });
      const fetchNormally = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        String(input) === "/api/teams" ? pendingRefresh : fetchNormally(input, init)
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
      await waitFor(() =>
        expect(fetchMock.mock.calls.filter(([path]) => path === "/api/teams")).toHaveLength(2)
      );

      fireEvent.change(screen.getByRole("textbox", { name: "Slug" }), {
        target: { value: "product-design" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
      );
      expect(replace).toHaveBeenCalledWith("/teams/product-design");

      await act(async () => {
        finishRefresh(
          refresh === "stale"
            ? Response.json({ teams: [initialTeam] })
            : Response.json({ error: "Unavailable" }, { status: refresh === "failed" ? 503 : 403 })
        );
        await pendingRefresh;
      });

      expect(cache.get("/api/teams")?.data?.teams).toContainEqual(stored);
      expect(cache.get("/api/teams/team_design")?.data).toEqual(stored);
      if (refresh === "forbidden") {
        expect(screen.getByRole("alert")).toHaveTextContent("Unable to load team.");
        expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
      } else {
        expect(screen.getByRole("heading", { level: 1, name: "Design" })).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("product-design");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      }
    }
  );
});
