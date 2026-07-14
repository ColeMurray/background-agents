// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SWRConfig, mutate as globalMutate } from "swr";
import useSWRInfinite from "swr/infinite";
import { DataControlsSettings } from "./data-controls-settings";
import { createSidebarSessionsKeyLoader, SIDEBAR_SESSIONS_KEY } from "@/lib/session-list";

expect.extend(matchers);

const { toastMock } = vi.hoisted(() => ({
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

type ArchivedSession = ReturnType<typeof createArchivedSession>;

function createArchivedSession(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `session-${index}`,
    title: `Session ${index}`,
    repoOwner: "open-inspect",
    repoName: "background-agents",
    baseBranch: "main",
    branchName: null,
    baseSha: null,
    currentSha: null,
    opencodeSessionId: null,
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    status: "archived",
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchHandlers = {
  // Flat backing store of archived sessions. GETs slice it by offset/limit;
  // successful POST /unarchive removes the session from it so subsequent
  // pages shift the way they would server-side.
  archivedSessions?: ArchivedSession[];
  onUnarchive?: (sessionId: string) => Response | Promise<Response>;
  onListSidebar?: () => Response | Promise<Response>;
};

function installFetch(handlers: FetchHandlers) {
  const archived = [...(handlers.archivedSessions ?? [])];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    const unarchiveMatch = url.match(/^\/api\/sessions\/([^/]+)\/unarchive$/);
    if (unarchiveMatch && method === "POST") {
      if (!handlers.onUnarchive) throw new Error(`No POST handler for ${url}`);
      const sessionId = unarchiveMatch[1];
      const res = await handlers.onUnarchive(sessionId);
      if (res.ok) {
        const idx = archived.findIndex((s) => s.id === sessionId);
        if (idx >= 0) archived.splice(idx, 1);
      }
      return res;
    }

    if (method === "GET" && url.startsWith("/api/sessions?")) {
      const params = new URL(url, "http://localhost").searchParams;
      if (params.get("status") === "archived") {
        const offset = Number(params.get("offset") || 0);
        const limit = Number(params.get("limit") || 20);
        const sessions = archived.slice(offset, offset + limit);
        return jsonResponse({
          sessions,
          hasMore: offset + sessions.length < archived.length,
          total: archived.length,
        });
      }
      if (params.get("view") === "sidebar") {
        return handlers.onListSidebar
          ? handlers.onListSidebar()
          : jsonResponse({ trees: [], nextCursor: null });
      }
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderComponent(additionalChildren?: React.ReactNode) {
  return render(
    <SWRConfig
      value={{
        dedupingInterval: 0,
        revalidateOnFocus: false,
        revalidateIfStale: false,
        revalidateOnReconnect: false,
        fetcher: async (url: string) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        },
      }}
    >
      <DataControlsSettings />
      {additionalChildren}
    </SWRConfig>
  );
}

afterEach(async () => {
  cleanup();
  // Clear SWR's global cache between tests so cache state doesn't leak.
  await globalMutate(() => true, undefined, { revalidate: false });
  vi.restoreAllMocks();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe("DataControlsSettings — unarchive flow", () => {
  it("removes the row when the unarchive request succeeds", async () => {
    installFetch({
      archivedSessions: [createArchivedSession(1)],
      onUnarchive: () => jsonResponse({ status: "active" }),
    });

    renderComponent();

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unarchive" }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Session unarchived");
    });

    await waitFor(() => {
      expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    });
  });

  it("preserves Load-more pagination when a page-1 session is unarchived", async () => {
    const sessions = Array.from({ length: 23 }, (_, i) => createArchivedSession(i + 1));

    installFetch({
      archivedSessions: sessions,
      onUnarchive: () => jsonResponse({ status: "active" }),
    });

    renderComponent();

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Session 23")).toBeInTheDocument();

    // Unarchive a page-1 session.
    const rowOne = screen.getByText("Session 1").closest("div.group") as HTMLElement;
    const unarchiveButton = rowOne.querySelector("button") as HTMLButtonElement;
    await user.click(unarchiveButton);

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Session unarchived");
    });

    // Session 1 should be gone; page-2 sessions must remain visible.
    await waitFor(() => {
      expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Session 21")).toBeInTheDocument();
    expect(screen.getByText("Session 22")).toBeInTheDocument();
    expect(screen.getByText("Session 23")).toBeInTheDocument();
  });

  it("removes a page-2 session from the list when it is unarchived", async () => {
    const sessions = Array.from({ length: 23 }, (_, i) => createArchivedSession(i + 1));

    installFetch({
      archivedSessions: sessions,
      onUnarchive: () => jsonResponse({ status: "active" }),
    });

    renderComponent();

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Session 22")).toBeInTheDocument();

    // Unarchive Session 22 (from page 2).
    const row = screen.getByText("Session 22").closest("div.group") as HTMLElement;
    const unarchiveButton = row.querySelector("button") as HTMLButtonElement;
    await user.click(unarchiveButton);

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Session unarchived");
    });

    await waitFor(() => {
      expect(screen.queryByText("Session 22")).not.toBeInTheDocument();
    });
    // Siblings in page 2 must remain.
    expect(screen.getByText("Session 21")).toBeInTheDocument();
    expect(screen.getByText("Session 23")).toBeInTheDocument();
    // Page 1 anchor still there.
    expect(screen.getByText("Session 1")).toBeInTheDocument();
  });

  it("does not skip an archived session when Load more runs after an unarchive", async () => {
    // 23 archived sessions: page 1 holds 1..20, page 2 would hold 21..23.
    // After unarchiving session 1 (without loading page 2), the server-side
    // list shifts down so the next session at offset 19 is session 21. If we
    // forget to decrement the local offset, Load more would request offset 20
    // and skip session 21.
    const sessions = Array.from({ length: 23 }, (_, i) => createArchivedSession(i + 1));

    installFetch({
      archivedSessions: sessions,
      onUnarchive: () => jsonResponse({ status: "active" }),
    });

    renderComponent();

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    expect(screen.queryByText("Session 21")).not.toBeInTheDocument();

    const user = userEvent.setup();
    const rowOne = screen.getByText("Session 1").closest("div.group") as HTMLElement;
    await user.click(rowOne.querySelector("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Session unarchived");
    });
    await waitFor(() => {
      expect(screen.queryByText("Session 1")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Session 21")).toBeInTheDocument();
    expect(screen.getByText("Session 22")).toBeInTheDocument();
    expect(screen.getByText("Session 23")).toBeInTheDocument();
  });

  it("keeps the row visible when the unarchive request returns 500", async () => {
    installFetch({
      archivedSessions: [createArchivedSession(1)],
      onUnarchive: () => jsonResponse({ error: "boom" }, 500),
    });

    renderComponent();

    expect(await screen.findByText("Session 1")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unarchive" }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Failed to unarchive session");
    });

    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

function SidebarProbe() {
  // Mounting this subscribes to SIDEBAR_SESSIONS_KEY so that mutate(key)
  // from the component-under-test triggers a real refetch we can observe.
  useSWRInfinite(createSidebarSessionsKeyLoader());
  return null;
}

describe("DataControlsSettings — sidebar invalidation", () => {
  it("refetches the sidebar session list after a successful unarchive", async () => {
    const sidebarHandler = vi.fn(() => jsonResponse({ trees: [], nextCursor: null }));
    const fetchMock = installFetch({
      archivedSessions: [createArchivedSession(1)],
      onUnarchive: () => jsonResponse({ status: "active" }),
      onListSidebar: sidebarHandler,
    });

    renderComponent(<SidebarProbe />);

    expect(await screen.findByText("Session 1")).toBeInTheDocument();
    // Sidebar probe should have done its initial fetch.
    await waitFor(() => {
      expect(sidebarHandler).toHaveBeenCalledTimes(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unarchive" }));

    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalledWith("Session unarchived");
    });

    // After unarchive, the sidebar key should have been revalidated.
    await waitFor(() => {
      expect(sidebarHandler).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock).toHaveBeenCalledWith(SIDEBAR_SESSIONS_KEY);
  });
});
