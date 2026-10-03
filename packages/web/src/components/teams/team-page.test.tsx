// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { TEAMS_KEY, teamCacheKey, type TeamResponse } from "@/hooks/use-teams";
import { useAuthSession } from "@/lib/auth-session";
import { TeamPage } from "./team-page";

expect.extend(matchers);

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const { replace } = router;

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    authorization: { role: { key: "viewer" }, suspendedAt: null },
    hasPermission: () => false,
  }),
}));
vi.mock("./team-overview", () => ({ TeamOverview: () => <p>Team session buckets</p> }));
vi.mock("./team-automations", () => ({ TeamAutomations: () => <p>Team automation work</p> }));
vi.mock("@/components/settings/team-members-table", () => ({
  TeamMembersTable: () => <p>Team member table</p>,
}));

let stored: TeamResponse;
let reusedSlugTeam: TeamResponse | undefined;
let directoryRefresh: "fresh" | "stale" | "failed";
const fetchMock = vi.fn<typeof fetch>();
const directoryKey = unstable_serialize(teamCacheKey(TEAMS_KEY, "user_one"));
const detailKey = unstable_serialize(teamCacheKey("/api/teams/team_design", "user_one"));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthSession).mockReturnValue({
    data: { user: { id: "user_one" } },
    status: "authenticated",
  });
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
      canViewWork: true,
      canReadAutomations: true,
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
          keepPreviousData: true,
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
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  return (
    <>
      <button onClick={() => void mutate(teamCacheKey(TEAMS_KEY, userId))}>
        Refresh directory
      </button>
      <button onClick={() => void mutate(teamCacheKey("/api/teams/team_design", userId))}>
        Refresh team
      </button>
    </>
  );
}

describe("TeamPage", () => {
  it.each([false, undefined] as const)(
    "unmounts work when fresh canViewWork is %s despite directory grants",
    async (canViewWork) => {
      directoryRefresh = "stale";
      const { cache } = renderPage("design");
      await screen.findByText("Team session buckets");
      await waitFor(() => expect(cache.get(detailKey)?.data).toBeDefined());
      stored = { ...stored, capabilities: { ...stored.capabilities, canViewWork } };
      fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
      await screen.findByText("Team member table");
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      expect(cache.get(directoryKey)?.data.teams[0].capabilities.canViewWork).toBe(true);
    }
  );

  it.each([false, undefined] as const)(
    "unmounts Automations when fresh canReadAutomations is %s despite directory grants",
    async (canReadAutomations) => {
      directoryRefresh = "stale";
      const { cache } = renderPage("design");
      fireEvent.click(await screen.findByRole("button", { name: "Automations" }));
      expect(screen.getByText("Team automation work")).toBeInTheDocument();
      await waitFor(() => expect(cache.get(detailKey)?.data).toBeDefined());
      stored = { ...stored, capabilities: { ...stored.capabilities, canReadAutomations } };
      fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
      await waitFor(() =>
        expect(screen.queryByText("Team automation work")).not.toBeInTheDocument()
      );
      expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      expect(cache.get(directoryKey)?.data.teams[0].capabilities.canReadAutomations).toBe(true);
    }
  );

  it.each([401, 403, "invalid-schema"] as const)(
    "does not trust cached work grants after terminal detail failure %s",
    async (failure) => {
      const { cache } = renderPage("design");
      await screen.findByText("Team session buckets");
      await waitFor(() => expect(cache.get(detailKey)?.data).toBeDefined());
      const fetchNormally = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        String(input) === "/api/teams/team_design"
          ? Promise.resolve(
              failure === "invalid-schema"
                ? Response.json({ ...stored, capabilities: { canViewWork: "true" } })
                : Response.json({ error: "Forbidden" }, { status: failure })
            )
          : fetchNormally(input, init)
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh team" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load team.");
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(cache.get(detailKey)?.data.capabilities).toBeUndefined();
    }
  );

  it.each(["directory", "detail"] as const)(
    "isolates work grants from a late account-A %s response while account B is pending",
    async (source) => {
      const { cache, rerender } = renderPage("design");
      await screen.findByText("Team session buckets");
      await waitFor(() => expect(cache.get(detailKey)?.data).toBeDefined());
      const oldPath = source === "directory" ? TEAMS_KEY : "/api/teams/team_design";
      let finishOldResponse!: (response: Response) => void;
      const oldResponse = new Promise<Response>((resolve) => {
        finishOldResponse = resolve;
      });
      const fetchNormally = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation((input, init) =>
        String(input) === oldPath ? oldResponse : fetchNormally(input, init)
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: source === "directory" ? "Refresh directory" : "Refresh team",
        })
      );
      await waitFor(() =>
        expect(cache.get(source === "directory" ? directoryKey : detailKey)?.isValidating).toBe(
          true
        )
      );

      const newResponses = new Map<string, (response: Response) => void>();
      fetchMock.mockImplementation((input, init) => {
        const path = String(input);
        return path === TEAMS_KEY || path === "/api/teams/team_design"
          ? new Promise((resolve) => newResponses.set(path, resolve))
          : fetchNormally(input, init);
      });
      vi.mocked(useAuthSession).mockReturnValue({
        data: { user: { id: "user_two" } },
        status: "authenticated",
      });
      rerender(<TeamPage slug="design" />);
      expect(screen.getByText("Loading team...")).toBeInTheDocument();
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();

      const denied = {
        ...stored,
        capabilities: { ...stored.capabilities, canViewWork: false, canReadAutomations: false },
      };
      await act(async () => {
        newResponses.get(TEAMS_KEY)?.(Response.json({ teams: [denied] }));
      });
      await screen.findByText("Team member table");
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(
        cache.get(unstable_serialize(teamCacheKey("/api/teams/team_design", "user_two")))?.data
      ).toBeUndefined();

      await act(async () => {
        finishOldResponse(
          Response.json(
            source === "directory" ? { teams: [stored] } : { ...stored, slug: "old-account-rename" }
          )
        );
        await oldResponse;
      });
      await waitFor(() =>
        expect(cache.get(source === "directory" ? directoryKey : detailKey)?.isValidating).toBe(
          false
        )
      );
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
      expect(
        cache.get(unstable_serialize(teamCacheKey(TEAMS_KEY, "user_two")))?.data.teams[0]
      ).toMatchObject({ slug: "design", capabilities: { canViewWork: false } });

      await act(async () => {
        newResponses.get("/api/teams/team_design")?.(Response.json(denied));
      });
      await waitFor(() =>
        expect(
          cache.get(unstable_serialize(teamCacheKey("/api/teams/team_design", "user_two")))?.data
        ).toBeDefined()
      );
      expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
      expect(cache.get(TEAMS_KEY)).toBeUndefined();
      expect(cache.get("/api/teams/team_design")).toBeUndefined();
    }
  );

  it.each(["directory", "detail"] as const)(
    "does not resurrect work after terminal then transient %s failures",
    async (source) => {
      const { cache } = renderPage("design");
      await screen.findByText("Team session buckets");
      await waitFor(() => expect(cache.get(detailKey)?.data).toBeDefined());
      const path = source === "directory" ? TEAMS_KEY : "/api/teams/team_design";
      const button = source === "directory" ? "Refresh directory" : "Refresh team";
      const fetchNormally = fetchMock.getMockImplementation()!;
      for (const status of [403, 503]) {
        fetchMock.mockImplementation((input, init) =>
          String(input) === path
            ? Promise.resolve(Response.json({ error: "Unavailable" }, { status }))
            : fetchNormally(input, init)
        );
        fireEvent.click(screen.getByRole("button", { name: button }));
        await waitFor(() =>
          expect(
            cache.get(source === "directory" ? directoryKey : detailKey)?.error?.message
          ).toContain(String(status))
        );
        expect(screen.getByRole("alert")).toHaveTextContent("Unable to load team.");
        expect(screen.queryByText("Team session buckets")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Automations" })).not.toBeInTheDocument();
      }
      fetchMock.mockImplementation(fetchNormally);
      fireEvent.click(screen.getByRole("button", { name: button }));
      await screen.findByText("Team session buckets");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );

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
      expect(cache.get(directoryKey)?.data?.teams).toContainEqual(stored);
      expect(cache.get(directoryKey)?.data?.teams).toContainEqual(
        expect.objectContaining({ id: "team_other", slug: "engineering" })
      );
      expect(cache.get(detailKey)?.data).toEqual(stored);
      expect(fetchMock.mock.calls.filter(([path]) => path === "/api/teams")).toHaveLength(1);

      if (reuseOldSlug) {
        fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
        await waitFor(() =>
          expect(cache.get(directoryKey)?.data?.teams).toContainEqual(reusedSlugTeam)
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

      expect(cache.get(directoryKey)?.data?.teams).toContainEqual(
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

      expect(cache.get(directoryKey)?.data?.teams).toContainEqual(stored);
      expect(cache.get(detailKey)?.data).toEqual(stored);
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
