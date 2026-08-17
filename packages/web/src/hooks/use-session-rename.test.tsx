// @vitest-environment jsdom

import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@open-inspect/shared/types/sessions";
import { buildSessionsPageKey, type SessionListResponse } from "@/lib/session-list";
import { useSessionRename } from "./use-session-rename";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSession(title: string, id = "session-1"): Session {
  return {
    id,
    title,
    status: "active",
    repoOwner: "acme",
    repoName: "web",
    baseBranch: null,
    branchName: null,
    baseSha: null,
    currentSha: null,
    opencodeSessionId: null,
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    createdAt: 1,
    updatedAt: 1,
    repositories: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSessionRename", () => {
  it("serializes overlapping renames and ignores a stale failure", async () => {
    const firstPageKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const secondPageKey = buildSessionsPageKey({ excludeStatus: "archived", offset: 50 });
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let serverTitle = "Original";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const title = JSON.parse(String(init.body)).title as string;
        if (title === "Rename A") return firstResponse.promise;
        serverTitle = title;
        return secondResponse.promise;
      }
      if (String(input) === firstPageKey) {
        return new Response(
          JSON.stringify({ sessions: [createSession("Other", "session-other")], hasMore: true }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ sessions: [createSession(serverTitle)], hasMore: false }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    function Wrapper({ children }: PropsWithChildren) {
      return (
        <SWRConfig
          value={{
            provider: () => new Map(),
            dedupingInterval: 0,
            fetcher: async (url: string) => (await fetch(url)).json(),
          }}
        >
          {children}
        </SWRConfig>
      );
    }

    const { result } = renderHook(
      () => {
        useSWRInfinite<SessionListResponse>(
          (index) => (index === 0 ? firstPageKey : index === 1 ? secondPageKey : null),
          { initialSize: 2 }
        );
        const firstCaller = useSessionRename({ sessionId: "session-1", currentTitle: serverTitle });
        const secondCaller = useSessionRename({
          sessionId: "session-1",
          currentTitle: serverTitle,
        });
        return {
          optimisticTitle: firstCaller.optimisticTitle,
          renameA: firstCaller.renameSession,
          renameB: secondCaller.renameSession,
          cache: useSWRConfig().cache,
        };
      },
      { wrapper: Wrapper }
    );
    await waitFor(() => {
      expect(result.current.cache.get(firstPageKey)?.data).toBeDefined();
      expect(result.current.cache.get(secondPageKey)?.data).toBeDefined();
    });

    let renameA!: Promise<boolean>;
    let renameB!: Promise<boolean>;
    act(() => {
      renameA = result.current.renameA("Rename A");
      renameB = result.current.renameB("Rename B");
    });

    await waitFor(() => {
      expect(result.current.optimisticTitle).toBe("Rename B");
      expect(result.current.cache.get(firstPageKey)?.data.sessions[0].title).toBe("Other");
      expect(result.current.cache.get(secondPageKey)?.data.sessions[0].title).toBe("Rename B");
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);

    firstResponse.resolve(new Response(null, { status: 500 }));
    await expect(renameA).resolves.toBe(true);
    expect(result.current.optimisticTitle).toBe("Rename B");
    expect(result.current.cache.get(firstPageKey)?.data.sessions[0].title).toBe("Other");

    secondResponse.resolve(new Response(null, { status: 204 }));
    await expect(renameB).resolves.toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
    await waitFor(() => {
      expect(result.current.cache.get(firstPageKey)?.data.sessions[0].title).toBe("Other");
      expect(result.current.cache.get(secondPageKey)?.data.sessions[0].title).toBe("Rename B");
      expect(result.current.optimisticTitle).toBeUndefined();
    });
  });

  it("rolls the latest failure back to an earlier confirmed rename", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let patchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCount += 1;
          return patchCount === 1 ? firstResponse.promise : secondResponse.promise;
        }
        return new Response(
          JSON.stringify({
            sessions: [createSession("Original", "session-confirmed")],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const { result } = renderHook(
      () => {
        useSWR<SessionListResponse>(listKey);
        const firstCaller = useSessionRename({
          sessionId: "session-confirmed",
          currentTitle: "Original",
        });
        const secondCaller = useSessionRename({
          sessionId: "session-confirmed",
          currentTitle: "Original",
        });
        return {
          renameA: firstCaller.renameSession,
          renameB: secondCaller.renameSession,
          cache: useSWRConfig().cache,
        };
      },
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig
            value={{
              provider: () => new Map(),
              dedupingInterval: 0,
              fetcher: async (url: string) => (await fetch(url)).json(),
            }}
          >
            {children}
          </SWRConfig>
        ),
      }
    );
    await waitFor(() => expect(result.current.cache.get(listKey)?.data).toBeDefined());

    let renameA!: Promise<boolean>;
    let renameB!: Promise<boolean>;
    act(() => {
      renameA = result.current.renameA("Rename A");
      renameB = result.current.renameB("Rename B");
    });
    firstResponse.resolve(new Response(null, { status: 204 }));
    await expect(renameA).resolves.toBe(true);
    secondResponse.resolve(new Response(null, { status: 500 }));
    await expect(renameB).resolves.toBe(false);

    await waitFor(() =>
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Rename A")
    );
  });

  it("keeps the latest overlay until its authoritative title is cached", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const renameResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return renameResponse.promise;
        return new Response(
          JSON.stringify({
            sessions: [createSession("Original", "session-authoritative")],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const { result, rerender } = renderHook(
      ({ authoritativeTitle }: { authoritativeTitle?: string }) => {
        useSWR<SessionListResponse>(listKey);
        const rename = useSessionRename({
          sessionId: "session-authoritative",
          currentTitle: authoritativeTitle ?? "Original",
          authoritativeTitle,
          awaitAuthoritativeTitle: true,
        });
        const { cache, mutate } = useSWRConfig();
        return { ...rename, cache, mutate };
      },
      {
        initialProps: { authoritativeTitle: undefined as string | undefined },
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig
            value={{
              provider: () => new Map(),
              dedupingInterval: 0,
              fetcher: async (url: string) => (await fetch(url)).json(),
            }}
          >
            {children}
          </SWRConfig>
        ),
      }
    );
    await waitFor(() => expect(result.current.cache.get(listKey)?.data).toBeDefined());

    let rename!: Promise<boolean>;
    act(() => {
      rename = result.current.renameSession("Rename B");
    });
    await act(() =>
      result.current.mutate<SessionListResponse>(
        listKey,
        (current) => ({
          ...(current as SessionListResponse),
          sessions: [createSession("Rename A", "session-authoritative")],
        }),
        { revalidate: false }
      )
    );
    rerender({ authoritativeTitle: "Rename A" });
    expect(result.current.optimisticTitle).toBe("Rename B");

    rerender({ authoritativeTitle: "Rename B" });
    expect(result.current.optimisticTitle).toBe("Rename B");
    renameResponse.reject(new TypeError("Response connection lost"));
    await expect(rename).resolves.toBe(true);

    await waitFor(() => {
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Rename B");
      expect(result.current.optimisticTitle).toBeUndefined();
    });
  });

  it("rolls back the current optimistic rename after a failure", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const renameResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return renameResponse.promise;
        return new Response(
          JSON.stringify({
            sessions: [createSession("Original", "session-rollback")],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const { result } = renderHook(
      () => {
        useSWR<SessionListResponse>(listKey);
        const rename = useSessionRename({
          sessionId: "session-rollback",
          currentTitle: "Original",
        });
        return { ...rename, cache: useSWRConfig().cache };
      },
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig
            value={{
              provider: () => new Map(),
              dedupingInterval: 0,
              fetcher: async (url: string) => (await fetch(url)).json(),
            }}
          >
            {children}
          </SWRConfig>
        ),
      }
    );
    await waitFor(() => expect(result.current.cache.get(listKey)?.data).toBeDefined());

    let rename!: Promise<boolean>;
    act(() => {
      rename = result.current.renameSession("Optimistic");
    });
    await waitFor(() =>
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Optimistic")
    );

    renameResponse.resolve(new Response(null, { status: 500 }));
    await expect(rename).resolves.toBe(false);
    await waitFor(() => {
      expect(result.current.optimisticTitle).toBeUndefined();
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Original");
    });
  });
});
