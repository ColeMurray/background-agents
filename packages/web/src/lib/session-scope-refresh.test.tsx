// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "./browser-api-fetch";
import { updateSessionScope } from "./session-scope";

vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("scope refresh with real SWR caches", () => {
  it("invalidates inactive pages even when no infinite discovery list has been loaded", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ affectedSessionIds: ["s1"] }));
    const { result, rerender } = renderHook(
      ({ mounted }) => {
        const config = useSWRConfig();
        const resource = useSWR(
          mounted ? ["/api/teams/source/activity", "viewer"] : null,
          async () => ({ stale: true })
        );
        return {
          resource,
          config,
          update: () =>
            updateSessionScope("/api/sessions/s1/scope", { method: "PUT" }, async () => {}, config),
        };
      },
      { wrapper, initialProps: { mounted: true } }
    );
    await waitFor(() => expect(result.current.resource.data).toEqual({ stale: true }));
    rerender({ mounted: false });
    await act(() => result.current.update());
    expect(
      [...result.current.config.cache.keys()].some(
        (key) => result.current.config.cache.get(key)?.data?.stale
      )
    ).toBe(false);
  });
  it("refetches every discovery page and both team scopes, inbox, and activity without timestamp changes", async () => {
    let version = 1;
    const fetchPage = vi.fn(async (path: string) => ({ path, version, updatedAt: 1 }));
    const snapshot = vi.fn().mockResolvedValue(undefined);
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      version = 2;
      return Response.json({ updatedAt: 1 });
    });
    const { result } = renderHook(
      () => {
        const { mutate, cache } = useSWRConfig();
        const source = useSWRInfinite(
          (page) => `/api/sessions?teamId=source&offset=${page}`,
          fetchPage,
          { initialSize: 2 }
        );
        const target = useSWRInfinite(
          (page) => `/api/sessions?teamId=target&offset=${page}`,
          fetchPage,
          { initialSize: 2 }
        );
        const inbox = useSWR(["/api/sessions/inbox?mine=true", "viewer"], ([path]) =>
          fetchPage(path)
        );
        const sourceBucket = useSWR("/api/teams/source/sessions?bucket=in_progress", fetchPage);
        const targetBucket = useSWR("/api/teams/target/sessions?bucket=needs_attention", fetchPage);
        const activity = useSWR("/api/teams/target/activity?cursor=page2", fetchPage);
        const unrelated = useSWR("/api/repos", fetchPage);
        return {
          source,
          target,
          inbox,
          sourceBucket,
          targetBucket,
          activity,
          unrelated,
          update: () =>
            updateSessionScope(
              "/api/sessions/s1/scope",
              { method: "PUT", body: { teamId: "target", includeChildren: true, joinTeam: false } },
              snapshot,
              { mutate, cache }
            ),
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.source.data).toHaveLength(2);
      expect(result.current.target.data).toHaveLength(2);
      expect(result.current.activity.data?.version).toBe(1);
      expect(result.current.unrelated.data?.version).toBe(1);
    });
    await act(() => result.current.update());
    expect(snapshot).toHaveBeenCalledOnce();
    for (const list of [result.current.source, result.current.target]) {
      expect(list.data?.map((page) => page.version)).toEqual([2, 2]);
    }
    for (const list of [
      result.current.inbox,
      result.current.sourceBucket,
      result.current.targetBucket,
      result.current.activity,
    ]) {
      expect(list.data?.version).toBe(2);
    }
    expect(result.current.unrelated.data?.version).toBe(1);
    expect(fetchPage.mock.calls.filter(([path]) => path === "/api/repos")).toHaveLength(1);
  });
});
