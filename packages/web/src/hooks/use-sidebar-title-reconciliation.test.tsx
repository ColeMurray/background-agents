// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { PropsWithChildren } from "react";
import type { SessionInboxPage } from "@open-inspect/shared/types/session-inbox";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { item, page, snapshot } from "@/test/session-inbox-fixtures";
import { useSidebarSessions } from "./use-sidebar-sessions";
import { useSessionRename } from "./use-session-rename";

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "github:123" } } }),
}));
vi.mock("./use-active-team", () => ({
  useActiveTeam: () => ({ activeTeamId: null, loading: false }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

async function setup({
  pendingPage,
  descendant = false,
  headerTitle = "Original",
  withAuthority = true,
}: {
  pendingPage: boolean;
  descendant?: boolean;
  headerTitle?: string;
  withAuthority?: boolean;
}) {
  const sessionId = "rename-tail";
  const originalSession = { ...item(sessionId).rootSession, title: "Original" };
  const tailPage: SessionInboxPage = {
    items: [
      descendant
        ? {
            ...item("tail-parent"),
            descendantSessions: [{ ...originalSession, parentSessionId: "tail-parent" }],
          }
        : { ...item(sessionId), rootSession: originalSession },
    ],
    hasMore: false,
    nextCursor: null,
  };
  const cursorResponse = deferred<SessionInboxPage>();
  const response = deferred<Response>();
  const fetcher = vi.fn(async (key: string) =>
    key.includes("category=")
      ? cursorResponse.promise
      : snapshot({ needs_attention: page(["head"], "next") })
  );
  vi.mocked(browserApiFetch).mockReturnValue(response.promise);
  const hook = renderHook(
    ({ authoritativeTitle }) => {
      const sidebar = useSidebarSessions();
      const session = descendant
        ? sidebar.childrenMap.get("tail-parent")?.[0]
        : sidebar.needsAttention.find(({ id }) => id === sessionId);
      const header = useSessionRename({
        sessionId,
        currentTitle: authoritativeTitle,
        authoritativeTitle: withAuthority ? authoritativeTitle : undefined,
        awaitAuthoritativeTitle: withAuthority,
      });
      const row = useSessionRename({ sessionId, currentTitle: session?.title ?? "Original" });
      return { sidebar, header, row, session, displayTitle: row.optimisticTitle ?? session?.title };
    },
    {
      initialProps: { authoritativeTitle: headerTitle },
      wrapper: ({ children }: PropsWithChildren) => (
        <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0 }}>
          {children}
        </SWRConfig>
      ),
    }
  );
  await waitFor(() => expect(hook.result.current.sidebar.loading).toBe(false));
  act(() => hook.result.current.sidebar.sectionPagination.needsAttention.loadMore());
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("cursor=")));

  async function arrive() {
    await act(async () => cursorResponse.resolve(tailPage));
    await waitFor(() => expect(hook.result.current.session).toBeDefined());
  }
  if (!pendingPage) await arrive();

  function rename(title = "Renamed", initiator: "header" | "row" = "header") {
    let request!: Promise<boolean>;
    act(() => {
      request = hook.result.current[initiator].renameSession(title);
    });
    return request;
  }

  async function expectTitle(title: string) {
    await arrive();
    expect(hook.result.current.header.optimisticTitle).toBeUndefined();
    expect(hook.result.current.displayTitle).toBe(title);
    expect(hook.result.current.session?.title).toBe(title);
    expect(fetcher.mock.calls.filter(([key]) => key.includes("category="))).toHaveLength(1);
    expect(originalSession.title).toBe("Original");
  }
  return { ...hook, response, rename, expectTitle };
}

describe.each([false, true])("sidebar title reconciliation (pending page: %s)", (pendingPage) => {
  it("keeps optimism when a stale detail subscriber mounts during a row rename", async () => {
    const view = await setup({ pendingPage, withAuthority: false });
    const rename = view.rename("Renamed", "row");
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledTimes(1));
    const detail = renderHook(() =>
      useSessionRename({
        sessionId: "rename-tail",
        currentTitle: "Original",
        authoritativeTitle: "Original",
        awaitAuthoritativeTitle: true,
      })
    );
    const displayWhilePending = view.result.current.displayTitle;
    await act(async () => {
      view.response.resolve(new Response(null, { status: 204 }));
      expect(await rename).toBe(true);
    });
    detail.unmount();
    expect(displayWhilePending).toBe("Renamed");
    await view.expectTitle("Renamed");
  });

  it.each([
    { initiator: "header", descendant: false },
    { initiator: "row", descendant: false },
    { initiator: "header", descendant: true },
    { initiator: "row", descendant: true },
  ] as const)(
    "retains HTTP confirmation from $initiator (descendant: $descendant)",
    async ({ initiator, descendant }) => {
      const view = await setup({ pendingPage, descendant });
      const rename = view.rename("Renamed", initiator);
      expect(view.result.current.displayTitle).toBe("Renamed");
      await act(async () => {
        view.response.resolve(new Response(null, { status: 204 }));
        expect(await rename).toBe(true);
      });
      view.rerender({ authoritativeTitle: "Renamed" });
      await view.expectTitle("Renamed");
    }
  );

  it("retains HTTP confirmation without a detail subscriber", async () => {
    const view = await setup({ pendingPage, withAuthority: false });
    const rename = view.rename("Renamed", "row");
    await act(async () => {
      view.response.resolve(new Response(null, { status: 204 }));
      expect(await rename).toBe(true);
    });
    await view.expectTitle("Renamed");
  });

  it.each([false, true])(
    "retains socket confirmation across a lost response: %s",
    async (lostResponse) => {
      const view = await setup({ pendingPage, descendant: lostResponse });
      const rename = view.rename("Renamed", lostResponse ? "header" : "row");
      await waitFor(() => expect(browserApiFetch).toHaveBeenCalledTimes(1));
      view.rerender({ authoritativeTitle: "Renamed" });
      await act(async () => {
        if (lostResponse) view.response.reject(new TypeError("Response connection lost"));
        else view.response.resolve(new Response(null, { status: 204 }));
        expect(await rename).toBe(true);
      });
      await view.expectTitle("Renamed");
    }
  );

  it("keeps newer authority across a late HTTP success", async () => {
    const view = await setup({ pendingPage });
    const rename = view.rename();
    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledTimes(1));
    view.rerender({ authoritativeTitle: "Newer title" });
    await act(async () => {
      view.response.resolve(new Response(null, { status: 204 }));
      expect(await rename).toBe(true);
    });
    await view.expectTitle("Newer title");
  });

  it.each([204, 500])(
    "follows two authoritative updates across pending HTTP %s",
    async (status) => {
      const view = await setup({ pendingPage });
      const rename = view.rename();
      await waitFor(() => expect(browserApiFetch).toHaveBeenCalledTimes(1));
      view.rerender({ authoritativeTitle: "Intermediate title" });
      view.rerender({ authoritativeTitle: "Original" });
      await act(async () => {
        view.response.resolve(new Response(null, { status }));
        expect(await rename).toBe(status === 204);
      });
      await view.expectTitle("Original");
    }
  );

  it.each(["Original", "Stale header"])(
    "does not write the header baseline %s into retained data after failure",
    async (headerTitle) => {
      const view = await setup({ pendingPage, headerTitle, descendant: true });
      const rename = view.rename();
      await act(async () => {
        view.response.resolve(new Response(null, { status: 500 }));
        expect(await rename).toBe(false);
      });
      await view.expectTitle("Original");
    }
  );

  it("retains a successful queued rename when the next rename fails", async () => {
    const view = await setup({ pendingPage });
    const secondResponse = deferred<Response>();
    vi.mocked(browserApiFetch)
      .mockReturnValueOnce(view.response.promise)
      .mockReturnValueOnce(secondResponse.promise);
    const first = view.rename("Saved");
    const second = view.rename("Rejected", "row");
    await act(async () => {
      view.response.resolve(new Response(null, { status: 204 }));
      expect(await first).toBe(true);
    });
    await act(async () => {
      secondResponse.resolve(new Response(null, { status: 500 }));
      expect(await second).toBe(false);
    });
    view.rerender({ authoritativeTitle: "Saved" });
    await view.expectTitle("Saved");
  });
});
