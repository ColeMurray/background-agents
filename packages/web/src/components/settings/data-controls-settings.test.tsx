// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import useSWR, { SWRConfig, mutate as globalMutate } from "swr";
import { DataControlsSettings } from "./data-controls-settings";
import { SIDEBAR_SESSIONS_KEY } from "@/lib/session-list";

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
  archivedPages?: ArchivedSession[][];
  onUnarchive?: (sessionId: string) => Response | Promise<Response>;
  onListSidebar?: () => Response | Promise<Response>;
};

function installFetch(handlers: FetchHandlers) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    const unarchiveMatch = url.match(/^\/api\/sessions\/([^/]+)\/unarchive$/);
    if (unarchiveMatch && method === "POST") {
      if (!handlers.onUnarchive) throw new Error(`No POST handler for ${url}`);
      return handlers.onUnarchive(unarchiveMatch[1]);
    }

    if (method === "GET" && url.startsWith("/api/sessions?")) {
      const params = new URL(url, "http://localhost").searchParams;
      const offset = Number(params.get("offset") || 0);
      const limit = Number(params.get("limit") || 20);
      if (params.get("status") === "archived") {
        const page = (handlers.archivedPages ?? []).find((_, i) => offset === i * limit);
        const sessions = page ?? [];
        const nextOffset = offset + sessions.length;
        const hasMore = (handlers.archivedPages ?? []).some(
          (p, i) => i * limit === nextOffset && p.length > 0
        );
        return jsonResponse({ sessions, hasMore, total: sessions.length });
      }
      if (params.get("excludeStatus") === "archived") {
        return handlers.onListSidebar
          ? handlers.onListSidebar()
          : jsonResponse({ sessions: [], hasMore: false });
      }
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderComponent() {
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
      archivedPages: [[createArchivedSession(1)]],
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
    const page1 = Array.from({ length: 20 }, (_, i) => createArchivedSession(i + 1));
    const page2 = Array.from({ length: 3 }, (_, i) => createArchivedSession(i + 21));

    installFetch({
      archivedPages: [page1, page2],
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
    const page1 = Array.from({ length: 20 }, (_, i) => createArchivedSession(i + 1));
    const page2 = Array.from({ length: 3 }, (_, i) => createArchivedSession(i + 21));

    installFetch({
      archivedPages: [page1, page2],
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

  it("keeps the row visible when the unarchive request returns 500", async () => {
    installFetch({
      archivedPages: [[createArchivedSession(1)]],
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
  useSWR<{ sessions: unknown[]; hasMore: boolean }>(SIDEBAR_SESSIONS_KEY);
  return null;
}

describe("DataControlsSettings — sidebar invalidation", () => {
  it("refetches the sidebar session list after a successful unarchive", async () => {
    const sidebarHandler = vi.fn(() => jsonResponse({ sessions: [], hasMore: false }));
    const fetchMock = installFetch({
      archivedPages: [[createArchivedSession(1)]],
      onUnarchive: () => jsonResponse({ status: "active" }),
      onListSidebar: sidebarHandler,
    });

    render(
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
        <SidebarProbe />
      </SWRConfig>
    );

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
