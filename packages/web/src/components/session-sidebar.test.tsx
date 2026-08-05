// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig, useSWRConfig } from "swr";
import { MOBILE_LONG_PRESS_MS, SessionSidebar } from "./session-sidebar";
import {
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  SIDEBAR_SESSIONS_KEY,
} from "@/lib/session-list";
import { SESSION_CREATOR_FILTER_STORAGE_KEY } from "@/hooks/use-sidebar-sessions";

expect.extend(matchers);

const { mockUseIsMobile } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
}));

const { mockPush } = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
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
  vi.unstubAllGlobals();
  localStorage.clear();
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
  it("shows the user profile at the bottom of the sidebar", async () => {
    const { container } = render(
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

    const profileButton = await screen.findByRole("button", { name: "Signed in as Test User" });
    expect(profileButton).toHaveTextContent("Test User");
    expect(container.querySelector("aside")?.lastElementChild).toContainElement(profileButton);
  });

  it("renders the PR status summary on session rows", async () => {
    const single = createSession(1, {
      updatedAt: 4000,
      pullRequestSummary: { total: 1, open: 0, draft: 0, merged: 1, closed: 0 },
    });
    const multi = createSession(2, {
      updatedAt: 3000,
      pullRequestSummary: { total: 3, open: 1, draft: 1, merged: 1, closed: 0 },
    });
    const none = createSession(3, { updatedAt: 2000 });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [single, multi, none],
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

    // GitHub-style state icon next to the title: merged for the single-PR
    // session, open (dominant bucket) for the multi-PR session, none without
    // tracked PRs.
    expect(await screen.findByTestId("pr-state-merged")).toHaveClass(
      "text-[#8250df]",
      "dark:text-[#a371f7]"
    );
    expect(screen.getByTestId("pr-state-open")).toHaveClass(
      "text-[#1f883d]",
      "dark:text-[#3fb950]"
    );
    expect(screen.queryAllByTestId(/^pr-state-/)).toHaveLength(2);

    // PR state is conveyed by the title icon without repeating the summary in
    // the lower repository and branch metadata.
    expect(screen.getByText("Session 1").closest("a")).not.toHaveTextContent("PR merged");
    expect(screen.getByText("Session 2").closest("a")).not.toHaveTextContent("3 PRs · 2 open");
  });

  it("renders unread sessions distinctly with an accessible label", async () => {
    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: {
              sessions: [
                createSession(1, {
                  readState: {
                    unread: true,
                    latestMessageId: "message-1",
                  },
                }),
                createSession(2, {
                  readState: {
                    unread: false,
                    latestMessageId: "message-2",
                  },
                }),
              ],
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

    expect(await screen.findByText("Unread")).toBeInTheDocument();
    expect(screen.getByText("Session 1")).toHaveClass("font-semibold");
    expect(screen.getByText("Session 2")).not.toHaveClass("font-semibold");
  });

  it("marks an unread session read from its action menu", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === SIDEBAR_SESSIONS_KEY) {
        return jsonResponse({
          sessions: [
            createSession(1, {
              readState: {
                unread: true,
                latestMessageId: "message-1",
              },
            }),
          ],
          hasMore: false,
        });
      }
      expect(init?.method).toBe("PATCH");
      expect(init?.body).toBe(JSON.stringify({ action: "mark_latest_message_read" }));
      return jsonResponse({
        sessionId: "session-1",
        outcome: "marked_read",
        unread: false,
        latestMessageId: "message-1",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher: async (url: string) => (await fetch(url)).json(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    fireEvent.pointerDown(await screen.findByRole("button", { name: "Session actions" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as read" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/session-1/read-state",
        expect.objectContaining({ method: "PATCH" })
      )
    );
    await waitFor(() => expect(screen.queryByText("Unread")).not.toBeInTheDocument());
  });

  it("renders nested child sessions under their immediate parent", async () => {
    const parent = createSession(1, { updatedAt: 4000 });
    const child = createSession(2, {
      title: "Child session",
      parentSessionId: parent.id,
      spawnSource: "agent",
      spawnDepth: 1,
      updatedAt: 3000,
      pullRequestSummary: { total: 1, open: 0, draft: 0, merged: 1, closed: 0 },
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
    const childLink = screen.getByText("Child session").closest("a");
    expect(childLink).toBeInTheDocument();
    expect(childLink).toContainElement(screen.getByLabelText("PR merged"));
    expect(screen.getByText("Grandchild session")).toBeInTheDocument();
  });

  it("opens session search from the header", async () => {
    const onSearchSessions = vi.fn();

    render(
      <SWRConfig
        value={{
          fallback: { [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false } },
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar onSearchSessions={onSearchSessions} />
      </SWRConfig>
    );

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Search sessions/ }));
    expect(onSearchSessions).toHaveBeenCalledOnce();
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
    expect(fetchMock).not.toHaveBeenCalledWith(
      buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })
    );

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

  it("retains loaded pagination rows when the first page revalidates", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => createSession(index + 1));
    const secondPage = [createSession(51)];
    let firstPageRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === SIDEBAR_SESSIONS_KEY) {
        firstPageRequests += 1;
        return jsonResponse({
          sessions: firstPage.map((session, index) =>
            index === 0 && firstPageRequests > 1
              ? { ...session, title: "Revalidated session" }
              : session
          ),
          hasMore: true,
        });
      }
      if (url === buildSessionsPageKey({ excludeStatus: "archived", offset: 50 })) {
        return jsonResponse({ sessions: secondPage, hasMore: false });
      }
      throw new Error(`Unexpected fetch for ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    function RevalidateButton() {
      const { mutate } = useSWRConfig();
      return <button onClick={() => mutate(SIDEBAR_SESSIONS_KEY)}>Revalidate</button>;
    }

    const { container } = render(
      <SWRConfig
        value={{
          provider: () => new Map(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
          fetcher: async (url: string) => (await fetch(url)).json(),
        }}
      >
        <RevalidateButton />
        <SessionSidebar />
      </SWRConfig>
    );
    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 1_705, writable: true },
    });
    fireEvent.scroll(scrollContainer);
    expect(await screen.findByText("Session 51")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revalidate" }));
    expect(await screen.findByText("Revalidated session")).toBeInTheDocument();
    expect(screen.getByText("Session 51")).toBeInTheDocument();
  });

  it("filters sessions to the current user and excludes automations when Mine is selected", async () => {
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      excludeAutomationLineage: true,
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
    expect(localStorage.getItem(SESSION_CREATOR_FILTER_STORAGE_KEY)).toBe("mine");
    expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
  });

  it("restores the saved creator filter after a refresh", async () => {
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      excludeAutomationLineage: true,
      createdBy: [CURRENT_USER_CREATED_BY],
    });
    localStorage.setItem(SESSION_CREATOR_FILTER_STORAGE_KEY, "mine");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === mineKey) {
        return jsonResponse({
          sessions: [createSession(2, { title: "Saved mine session" })],
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
          fetcher: async (url: string) => (await fetch(url)).json(),
          dedupingInterval: 0,
          revalidateOnFocus: false,
        }}
      >
        <SessionSidebar />
      </SWRConfig>
    );

    expect(await screen.findByText("Saved mine session")).toBeInTheDocument();
    expect(screen.getByText("Mine").closest("button")).toHaveAttribute("data-state", "on");
    expect(fetchMock).toHaveBeenCalledWith(mineKey);
    expect(fetchMock).not.toHaveBeenCalledWith(SIDEBAR_SESSIONS_KEY);
  });

  it("ignores an invalid saved creator filter", async () => {
    localStorage.setItem(SESSION_CREATOR_FILTER_STORAGE_KEY, "invalid");

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
    expect(screen.getByText("All").closest("button")).toHaveAttribute("data-state", "on");
  });

  it("keeps the creator filter usable when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const mineKey = buildSessionsPageKey({
      excludeStatus: "archived",
      excludeAutomationLineage: true,
      createdBy: [CURRENT_USER_CREATED_BY],
    });

    render(
      <SWRConfig
        value={{
          fallback: {
            [SIDEBAR_SESSIONS_KEY]: { sessions: [createSession(1)], hasMore: false },
            [mineKey]: {
              sessions: [createSession(2, { title: "Mine without storage" })],
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
    fireEvent.click(screen.getByText("Mine"));
    expect(await screen.findByText("Mine without storage")).toBeInTheDocument();
    expect(screen.getByText("Mine").closest("button")).toHaveAttribute("data-state", "on");
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
      excludeAutomationLineage: true,
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

    fireEvent.click(screen.getByTitle("Settings"));
    fireEvent.click(screen.getByRole("link", { name: /automations/i }));
    fireEvent.click(screen.getByRole("link", { name: /analytics/i }));

    expect(onSessionSelect).toHaveBeenCalledTimes(3);
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
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
      });
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
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/archive", {
        method: "POST",
        mode: "same-origin",
        credentials: "same-origin",
      });
    });

    expect(screen.getByRole("link", { name: /session 1/i })).toBeInTheDocument();
  });
});
