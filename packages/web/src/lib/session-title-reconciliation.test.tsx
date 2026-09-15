// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, useSWRConfig } from "swr";
import useSWR from "swr";
import type { PropsWithChildren } from "react";
import { applySessionTitleToCaches } from "./session-title-cache";
import {
  clearSessionTitleRevisions,
  reconcileSessionTitleRevision,
} from "./session-title-reconciliation";
import { buildSessionsPageKey, fetchSessionListPage } from "./session-list";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function staleResponse() {
  return Response.json({
    sessions: [
      {
        id: "session-race",
        title: "Original",
        status: "active",
        repoOwner: null,
        repoName: null,
        baseBranch: null,
        parentSessionId: null,
        spawnSource: "user",
        environmentId: null,
        createdAt: 1,
        updatedAt: 1,
        harness: "opencode",
        model: "model",
        reasoningEffort: null,
        spawnDepth: 0,
        automationId: null,
        automationRunId: null,
        scmLogin: null,
        userId: null,
        totalCost: 0,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
      },
    ],
    hasMore: false,
  });
}

afterEach(() => {
  clearSessionTitleRevisions();
  vi.restoreAllMocks();
});

describe("session title reconciliation with SWR", () => {
  it("merges a revision into an in-flight load and a later stale revalidation", async () => {
    const initial = deferred<Response>();
    const refresh = deferred<Response>();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise);
    vi.stubGlobal("fetch", fetchMock);
    const key = buildSessionsPageKey({ excludeStatus: "archived" });

    const { result } = renderHook(
      () => {
        const swr = useSWR(key, fetchSessionListPage);
        const { cache, mutate } = useSWRConfig();
        return { ...swr, cache, mutateCache: mutate, revalidate: swr.mutate };
      },
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            {children}
          </SWRConfig>
        ),
      }
    );

    const revision = reconcileSessionTitleRevision({
      sessionId: "session-race",
      title: "Renamed",
      updatedAt: 2,
    });
    await act(() =>
      applySessionTitleToCaches(
        result.current.mutateCache,
        result.current.cache,
        revision.sessionId,
        revision.title,
        revision.updatedAt
      )
    );
    initial.resolve(staleResponse());

    await waitFor(() =>
      expect(result.current.data?.sessions[0]).toMatchObject({
        title: "Renamed",
        updatedAt: 2,
      })
    );

    let revalidation!: Promise<unknown>;
    act(() => {
      revalidation = result.current.revalidate();
    });
    refresh.resolve(staleResponse());
    await act(() => revalidation);

    expect(result.current.data?.sessions[0]).toMatchObject({
      title: "Renamed",
      updatedAt: 2,
    });
  });
});
