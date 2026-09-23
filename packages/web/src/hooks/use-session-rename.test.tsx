// @vitest-environment jsdom

import { useLayoutEffect, type PropsWithChildren } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListSummary } from "@open-inspect/shared/types/sessions";
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

function createSession(title: string, id = "session-1"): SessionListSummary {
  return {
    id,
    title,
    status: "active",
    repoOwner: "acme",
    repoName: "web",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    harness: "opencode",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    automationId: null,
    automationRunId: null,
    scmLogin: null,
    userId: null,
    totalCost: 0,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
    environmentId: null,
    createdAt: 1,
    updatedAt: 1,
    repositories: [],
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      expect(result.current.cache.get(secondPageKey)?.data.sessions[0].title).toBe("Original");
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
      expect(result.current.cache.get(secondPageKey)?.data.sessions[0].title).toBe("Original");
      expect(result.current.optimisticTitle).toBeUndefined();
    });
  });

  it("rolls the latest failure back to an earlier confirmed rename", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let patchCount = 0;
    let serverTitle = "Original";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCount += 1;
          return patchCount === 1 ? firstResponse.promise : secondResponse.promise;
        }
        return new Response(
          JSON.stringify({
            sessions: [createSession(serverTitle, "session-confirmed")],
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
    serverTitle = "Rename A";
    firstResponse.resolve(new Response(null, { status: 204 }));
    await expect(renameA).resolves.toBe(true);
    secondResponse.resolve(new Response(null, { status: 500 }));
    await expect(renameB).resolves.toBe(false);

    await waitFor(() =>
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Rename A")
    );
  });

  it("keeps HTTP-first detail state correct while the list eventually converges", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    const renameResponse = deferred<Response>();
    const staleListResponse = deferred<Response>();
    const freshListResponse = deferred<Response>();
    let listRequest = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return renameResponse.promise;
        listRequest += 1;
        if (listRequest === 2) return staleListResponse.promise;
        if (listRequest === 3) return freshListResponse.promise;
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
      ({ authoritativeTitle }: { authoritativeTitle: string }) => {
        const { data, isValidating } = useSWR<SessionListResponse>(listKey);
        const detailRename = useSessionRename({
          sessionId: "session-authoritative",
          currentTitle: authoritativeTitle,
          authoritativeTitle,
          awaitAuthoritativeTitle: true,
        });
        const listRename = useSessionRename({
          sessionId: "session-authoritative",
          currentTitle: data?.sessions[0]?.title ?? "Original",
        });
        const { cache, mutate } = useSWRConfig();
        return {
          renameSession: detailRename.renameSession,
          optimisticTitle: detailRename.optimisticTitle,
          detailTitle: detailRename.optimisticTitle ?? authoritativeTitle,
          listTitle: listRename.optimisticTitle ?? data?.sessions[0]?.title,
          listIsValidating: isValidating,
          cache,
          mutate,
        };
      },
      {
        initialProps: { authoritativeTitle: "Original" },
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
    renameResponse.resolve(new Response(JSON.stringify({ title: "Rename B" }), { status: 200 }));
    await expect(rename).resolves.toBe(true);

    expect(result.current.detailTitle).toBe("Rename B");
    expect(result.current.listTitle).toBe("Rename B");
    await waitFor(() => {
      expect(listRequest).toBe(2);
      expect(result.current.listIsValidating).toBe(true);
    });
    staleListResponse.resolve(
      new Response(
        JSON.stringify({
          sessions: [createSession("Original", "session-authoritative")],
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await waitFor(() => {
      expect(result.current.listIsValidating).toBe(false);
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Original");
    });
    expect(result.current.detailTitle).toBe("Rename B");
    expect(result.current.listTitle).toBe("Rename B");

    rerender({ authoritativeTitle: "Rename B" });
    await waitFor(() => expect(result.current.optimisticTitle).toBeUndefined());
    expect(result.current.detailTitle).toBe("Rename B");
    expect(result.current.listTitle).toBe("Original");

    let refresh!: Promise<SessionListResponse | undefined>;
    act(() => {
      refresh = result.current.mutate<SessionListResponse>(listKey);
    });
    await waitFor(() => expect(listRequest).toBe(3));
    freshListResponse.resolve(
      new Response(
        JSON.stringify({
          sessions: [createSession("Rename B", "session-authoritative")],
          hasMore: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    await act(() => refresh);

    await waitFor(() => {
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Rename B");
      expect(result.current.listTitle).toBe("Rename B");
    });
  });

  it("accepts a lost HTTP response when the socket confirms the rename", async () => {
    const renameResponse = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return renameResponse.promise;
        throw new Error("Unexpected list fetch");
      })
    );

    const { result, rerender } = renderHook(
      ({ authoritativeTitle }: { authoritativeTitle: string }) =>
        useSessionRename({
          sessionId: "session-lost-response",
          currentTitle: authoritativeTitle,
          authoritativeTitle,
          awaitAuthoritativeTitle: true,
        }),
      {
        initialProps: { authoritativeTitle: "Original" },
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        ),
      }
    );

    let rename!: Promise<boolean>;
    act(() => {
      rename = result.current.renameSession("Renamed");
    });
    rerender({ authoritativeTitle: "Renamed" });
    renameResponse.reject(new TypeError("Response connection lost"));

    await expect(rename).resolves.toBe(true);
    expect(result.current.optimisticTitle).toBeUndefined();
  });

  it.each(["success", "lost response"])(
    "retains socket confirmation across detail unmount until %s settlement",
    async (settlement) => {
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
          throw new Error("Unexpected list fetch");
        })
      );
      const sessionId = `session-pending-unmount-${settlement}`;
      const wrapper = ({ children }: PropsWithChildren) => (
        <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
      );
      const detail = renderHook(
        ({ authoritativeTitle }: { authoritativeTitle: string }) =>
          useSessionRename({
            sessionId,
            currentTitle: authoritativeTitle,
            authoritativeTitle,
            awaitAuthoritativeTitle: true,
          }),
        { initialProps: { authoritativeTitle: "Original" }, wrapper }
      );
      const sidebar = renderHook(() => useSessionRename({ sessionId, currentTitle: "Original" }), {
        wrapper,
      });

      let rename!: Promise<boolean>;
      act(() => {
        rename = sidebar.result.current.renameSession("Renamed");
      });
      await waitFor(() => expect(patchCount).toBe(1));
      detail.rerender({ authoritativeTitle: "Renamed" });
      detail.unmount();

      await act(async () => {
        if (settlement === "success") {
          firstResponse.resolve(new Response(null, { status: 204 }));
        } else {
          firstResponse.reject(new TypeError("Response connection lost"));
        }
        expect(await rename).toBe(true);
      });
      expect(sidebar.result.current.optimisticTitle).toBeUndefined();

      // With no detail subscriber, the old confirmation cannot validate a new request.
      act(() => {
        rename = sidebar.result.current.renameSession("Renamed");
      });
      await waitFor(() => expect(patchCount).toBe(2));
      await act(async () => {
        secondResponse.reject(new TypeError("Second response connection lost"));
        expect(await rename).toBe(false);
      });
      expect(sidebar.result.current.optimisticTitle).toBeUndefined();
    }
  );

  it("hands an HTTP-confirmed overlay to the next authoritative title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return new Response(JSON.stringify({ title: "Local rename" }), { status: 200 });
        }
        throw new Error("Unexpected list fetch");
      })
    );

    const { result, rerender } = renderHook(
      ({ authoritativeTitle }: { authoritativeTitle: string }) =>
        useSessionRename({
          sessionId: "session-cross-tab-handoff",
          currentTitle: authoritativeTitle,
          authoritativeTitle,
          awaitAuthoritativeTitle: true,
        }),
      {
        initialProps: { authoritativeTitle: "Original" },
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        ),
      }
    );

    await act(() => result.current.renameSession("Local rename"));
    expect(result.current.optimisticTitle).toBe("Local rename");

    rerender({ authoritativeTitle: "Newer cross-tab title" });
    await waitFor(() => expect(result.current.optimisticTitle).toBeUndefined());
  });

  it.each([
    { settlement: "success", authorityTitles: ["Newer cross-tab title"] },
    { settlement: "failure", authorityTitles: ["Newer cross-tab title"] },
    { settlement: "success", authorityTitles: ["Intermediate title", "Original"] },
    { settlement: "failure", authorityTitles: ["Intermediate title", "Original"] },
  ])(
    "keeps authority $authorityTitles visible across pending rename $settlement",
    async ({ settlement, authorityTitles }) => {
      const renameResponse = deferred<Response>();
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return renameResponse.promise;
        throw new Error("Unexpected list fetch");
      });
      vi.stubGlobal("fetch", fetchMock);
      const { result, rerender } = renderHook(
        ({ authoritativeTitle }: { authoritativeTitle: string }) => {
          const rename = useSessionRename({
            sessionId: "session-pending-authority",
            currentTitle: authoritativeTitle,
            authoritativeTitle,
            awaitAuthoritativeTitle: true,
          });
          return { ...rename, displayTitle: rename.optimisticTitle ?? authoritativeTitle };
        },
        {
          initialProps: { authoritativeTitle: "Original" },
          wrapper: ({ children }: PropsWithChildren) => (
            <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
          ),
        }
      );

      let rename!: Promise<boolean>;
      act(() => {
        rename = result.current.renameSession("Local rename");
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(result.current.displayTitle).toBe("Local rename");

      for (const authoritativeTitle of authorityTitles) {
        rerender({ authoritativeTitle });
        expect(result.current.displayTitle).toBe(authoritativeTitle);
      }
      await act(async () => {
        if (settlement === "success") {
          renameResponse.resolve(new Response(null, { status: 204 }));
        } else {
          renameResponse.reject(new TypeError("Response connection lost"));
        }
        expect(await rename).toBe(settlement === "success");
      });
      expect(result.current.displayTitle).toBe(authorityTitles.at(-1));
      expect(result.current.optimisticTitle).toBeUndefined();
    }
  );

  it("releases an HTTP-confirmed overlay when the detail subscriber unmounts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          return new Response(JSON.stringify({ title: "Renamed" }), { status: 200 });
        }
        throw new Error("Unexpected list fetch");
      })
    );
    const wrapper = ({ children }: PropsWithChildren) => (
      <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
    );
    const detail = renderHook(
      () =>
        useSessionRename({
          sessionId: "session-detail-unmount",
          currentTitle: "Original",
          authoritativeTitle: "Original",
          awaitAuthoritativeTitle: true,
        }),
      { wrapper }
    );
    const sidebar = renderHook(
      () => useSessionRename({ sessionId: "session-detail-unmount", currentTitle: "Original" }),
      { wrapper }
    );

    await act(() => detail.result.current.renameSession("Renamed"));
    expect(sidebar.result.current.optimisticTitle).toBe("Renamed");

    detail.unmount();
    await waitFor(() => expect(sidebar.result.current.optimisticTitle).toBeUndefined());
  });

  it("lets a later authoritative title replace a failure rollback overlay", async () => {
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
        throw new Error("Unexpected list fetch");
      })
    );

    const { result, rerender } = renderHook(
      ({ authoritativeTitle }: { authoritativeTitle: string }) => {
        const firstCaller = useSessionRename({
          sessionId: "session-failure-rollback",
          currentTitle: authoritativeTitle,
          authoritativeTitle,
          awaitAuthoritativeTitle: true,
        });
        const secondCaller = useSessionRename({
          sessionId: "session-failure-rollback",
          currentTitle: authoritativeTitle,
        });
        return {
          optimisticTitle: firstCaller.optimisticTitle,
          renameA: firstCaller.renameSession,
          renameB: secondCaller.renameSession,
        };
      },
      {
        initialProps: { authoritativeTitle: "Original" },
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
        ),
      }
    );

    let renameA!: Promise<boolean>;
    let renameB!: Promise<boolean>;
    act(() => {
      renameA = result.current.renameA("Rename A");
      renameB = result.current.renameB("Rename B");
    });
    firstResponse.resolve(new Response(null, { status: 204 }));
    await expect(renameA).resolves.toBe(true);
    secondResponse.reject(new TypeError("Response connection lost"));
    await expect(renameB).resolves.toBe(false);
    expect(result.current.optimisticTitle).toBe("Rename A");

    rerender({ authoritativeTitle: "Rename B" });
    await waitFor(() => expect(result.current.optimisticTitle).toBeUndefined());
  });

  it("captures the current title when renamed from a layout effect after it changes", async () => {
    const listKey = buildSessionsPageKey({ excludeStatus: "archived" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") return new Response(null, { status: 500 });
        return new Response(
          JSON.stringify({
            sessions: [createSession("Updated", "session-layout")],
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    let rename: Promise<boolean> | undefined;

    const { result, rerender } = renderHook(
      ({ currentTitle, renameInLayout }) => {
        useSWR<SessionListResponse>(listKey);
        const sessionRename = useSessionRename({ sessionId: "session-layout", currentTitle });
        const { renameSession } = sessionRename;
        useLayoutEffect(() => {
          if (renameInLayout) rename = renameSession("Optimistic");
        }, [renameInLayout, renameSession]);
        return { ...sessionRename, cache: useSWRConfig().cache };
      },
      {
        initialProps: { currentTitle: "Original", renameInLayout: false },
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

    rerender({ currentTitle: "Updated", renameInLayout: true });
    await expect(rename).resolves.toBe(false);

    await waitFor(() => {
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Updated");
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
    await waitFor(() => expect(result.current.optimisticTitle).toBe("Optimistic"));
    expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Original");

    renameResponse.resolve(new Response(null, { status: 500 }));
    await expect(rename).resolves.toBe(false);
    await waitFor(() => {
      expect(result.current.optimisticTitle).toBeUndefined();
      expect(result.current.cache.get(listKey)?.data.sessions[0].title).toBe("Original");
    });
  });
});
