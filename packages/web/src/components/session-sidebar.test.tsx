// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig } from "swr";
import { MOBILE_LONG_PRESS_MS, SessionSidebar } from "./session-sidebar";
import {
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  SIDEBAR_SESSIONS_KEY,
} from "@/lib/session-list";

expect.extend(matchers);

const { mockUseIsMobile } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
}));

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        name: "Test User",
        email: "test@example.com",
      },
    },
  }),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: mockUseIsMobile,
}));

const { mockUseEnvironments } = vi.hoisted(() => ({
  mockUseEnvironments: vi.fn(() => ({ environments: [] as unknown[], loading: false })),
}));

vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: mockUseEnvironments,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  mockUseIsMobile.mockReturnValue(false);
  mockPush.mockReset();
  mockUseEnvironments.mockReturnValue({ environments: [], loading: false });
});

function createSession(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    repoOwner: "open-inspect",
    repoName: "background-agents",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    status: "active",
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SessionSidebar", () => {
  it("renders nested child sessions under their immediate parent", async () => {
    const parent = createSession(1, { updatedAt: 4000 });
    const child = createSession(2, {
      title: "Child session",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: 3000,
    });
    const grandchild = createSession(3, {
      title: "Grandchild session",
      parentSessionId: child.id,
      spawnSource: "agent",
      spawnDepth: 2,
      updatedAt: 2000,
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [parent, child, grandchild],
              hasMore: false,
            },
          },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("Child session")).toBeInTheDocument();
    expect(screen.getByText("Grandchild session")).toBeInTheDocument();
  });

  it("shows an empty state for an unmatched search and restores sessions when cleared", async () => {
    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(searchInput, { target: { value: "missing" } });

    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "" } });

    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("keeps the genuine empty-session state distinct from empty search results", () => {
    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "missing" },
    });

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("keeps the session-loading failure distinct from empty search results", async () => {
    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: async () => {
            throw new Error("Failed to load sessions");
          },
          shouldRetryOnError: false,
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Unable to load sessions")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions..."), {
      target: { value: "missing" },
    });

    expect(screen.getByText("Unable to load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No matching sessions")).not.toBeInTheDocument();
  });

  it("loads the next page when scrolled near the bottom", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const secondPage = Array.from({ length: 5 }, (_, index) => createSession(index + 51));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true });
      }

      if (url === buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })) {
        return jsonResponse({ sessions: secondPage, hasMore: false });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value;
      },
    });

    scrollTop = 1705;
    fireEvent.scroll(scrollContainer);

    expect(await screen.findByText("Session 55")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })
      );
    });
  });

  it("filters sessions to the current user when Mine is selected", async () => {
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: [createSession(1)], hasMore: false });
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(2, { title: "Mine only" })],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Mine"));

    expect(await screen.findByText("Mine only")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(mineKey);
    });
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
  });

  it("matches non-primary repository members in the sidebar search", async () => {
    const session = createSession(1, {
      repositories: [
        { repoOwner: "open-inspect", repoName: "background-agents", repoId: 1, baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
      ],
    });

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [session], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(searchInput, { target: { value: "acme/api" } });

    expect(screen.getByText("Session 1")).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "acme/docs" } });

    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
  });

  it("shows the environment name on cards for environment-launched sessions", async () => {
    mockUseEnvironments.mockReturnValue({
      environments: [{ id: "env_1", name: "Full stack" }],
      loading: false,
    });

    const sessions = [
      createSession(1, { environmentId: "env_1" }),
      // Deleted environment: the chip is dropped rather than showing a raw id.
      createSession(2, { environmentId: "env_gone" }),
    ];

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions, hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("Full stack")).toBeInTheDocument();
    expect(screen.queryByText("env_gone")).not.toBeInTheDocument();
  });

  it("ignores stale load-more results after the creator filter changes", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const allNextPageKey = buildSessionsPageKey({ excludeStatus: "archived", offset: 50 });
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: [CURRENT_USER_CREATED_BY],
    });
    let resolveAllNextPage!: (response: Response) => void;
    const allNextPage = new Promise<Response>((resolve) => {
      resolveAllNextPage = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({ sessions: firstPage, hasMore: true });
      }

      if (url === allNextPageKey) {
        return allNextPage;
      }

      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(99, { title: "Mine only" })],
          hasMore: false,
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => {
            const response = await fetch(url);
            return response.json();
          },
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      value: 1705,
    });

    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(allNextPageKey);
    });

    fireEvent.click(screen.getByText("Mine"));
    expect(await screen.findByText("Mine only")).toBeInTheDocument();

    await act(async () => {
      resolveAllNextPage(
        jsonResponse({
          sessions: [createSession(51, { title: "Stale page" })],
          hasMore: false,
        })
      );
      await allNextPage;
    });

    expect(screen.queryByText("Stale page")).not.toBeInTheDocument();
    expect(screen.getByText("Mine only")).toBeInTheDocument();
  });

  it("navigates directly on mobile tap without opening rename actions", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar onSessionSelect={onSessionSelect} />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    fireEvent.click(link);

    expect(screen.queryByText("Rename")).not.toBeInTheDocument();
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it("closes the sidebar on mobile when using non-session navigation links", () => {
    mockUseIsMobile.mockReturnValue(true);
    const onSessionSelect = vi.fn();

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar onSessionSelect={onSessionSelect} />
      </SWRConfig>
    );

    fireEvent.click(screen.getByRole("link", { name: /^inspect$/i }));
    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("link", { name: /automations/i }));
    fireEvent.click(screen.getByRole("link", { name: /analytics/i }));

    expect(onSessionSelect).toHaveBeenCalledTimes(4);
  });

  it("opens rename actions on mobile long press", async () => {
    mockUseIsMobile.mockReturnValue(true);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("archives a session from the sidebar actions menu", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return jsonResponse({ ok: true });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });
  });

  it("keeps the session in the sidebar when archiving fails", async () => {
    mockUseIsMobile.mockReturnValue(true);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/sessions/session-1/archive" && init?.method === "POST") {
        return new Response(null, { status: 500 });
      }

      throw new Error(`Unexpected fetch for ${String(input)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    const link = await screen.findByRole("link", { name: /session 1/i });
    vi.useFakeTimers();
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    act(() => {
      vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", { method: "POST" });
    });

    expect(screen.getByRole("link", { name: /session 1/i })).toBeInTheDocument();
  });
});
