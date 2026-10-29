// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import useSWR, { SWRConfig, useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApiFetch } from "./browser-api-fetch";
import { buildSessionsPageKey } from "./session-list";
import {
  isSessionScopeCacheKey,
  SessionScopeRefreshError,
  updateSessionScope,
} from "./session-scope";

vi.mock("./browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("scope refresh with real SWR caches", () => {
  it("does not invalidate the removed activity endpoint", () => {
    expect(isSessionScopeCacheKey("/api/activity")).toBe(false);
    expect(isSessionScopeCacheKey("/api/activity?teamId=source")).toBe(false);
    expect(isSessionScopeCacheKey(["/api/activity", "viewer"])).toBe(false);
  });

  it("retries an acknowledged write's snapshot refresh without resending the write", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const cause = new Error("Snapshot unavailable");
    const snapshot = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
    const { result } = renderHook(() => useSWRConfig(), { wrapper });
    let failure!: SessionScopeRefreshError;
    await act(async () => {
      try {
        await updateSessionScope(
          "/api/sessions/s1/visibility",
          { method: "PUT", body: { visibility: "workspace", includeChildren: true } },
          snapshot,
          result.current
        );
      } catch (error) {
        expect(error).toBeInstanceOf(SessionScopeRefreshError);
        failure = error as SessionScopeRefreshError;
      }
    });
    expect(failure.cause).toBe(cause);
    await act(() => failure.retryRefresh());
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(browserApiFetch).toHaveBeenCalledOnce();
  });

  it.each(["inbox", "infinite"])(
    "treats a real SWR %s revalidation error as best-effort after refreshing the snapshot",
    async (resource) => {
      vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
      const fetchInbox = vi.fn().mockResolvedValue({ version: 1 });
      const fetchPage = vi.fn().mockResolvedValue({ version: 1 });
      const snapshot = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(
        () => {
          const config = useSWRConfig();
          const inbox = useSWR(["/api/sessions/inbox", "viewer"], fetchInbox, {
            shouldRetryOnError: false,
          });
          const list = useSWRInfinite(
            (page) => buildSessionsPageKey({ teamIds: ["team_source"], offset: page * 50 }),
            fetchPage,
            { shouldRetryOnError: false }
          );
          return {
            config,
            inboxData: inbox.data,
            listData: list.data,
            inboxError: inbox.error,
            listError: list.error,
          };
        },
        { wrapper }
      );
      await waitFor(() => {
        expect(result.current.inboxData).toEqual({ version: 1 });
        expect(result.current.listData).toEqual([{ version: 1 }]);
      });
      const cause = new Error("Discovery unavailable");
      (resource === "inbox" ? fetchInbox : fetchPage).mockRejectedValueOnce(cause);
      await act(() =>
        updateSessionScope(
          "/api/sessions/s1/visibility",
          { method: "PUT" },
          snapshot,
          result.current.config
        )
      );
      expect(resource === "inbox" ? result.current.inboxError : result.current.listError).toBe(
        cause
      );
      expect(snapshot).toHaveBeenCalledOnce();
      expect(browserApiFetch).toHaveBeenCalledOnce();
    }
  );

  it.each(["before", "after"])(
    "does not use a concurrent SWR error settling %s the snapshot as the scope result",
    async (timing) => {
      vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
      let failConcurrent!: (error: Error) => void;
      const fetchInbox = vi
        .fn()
        .mockResolvedValueOnce({ version: 1 })
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failConcurrent = reject;
            })
        )
        .mockResolvedValue({ version: 2 });
      let finishSnapshot!: () => void;
      const snapshot = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSnapshot = resolve;
          })
      );
      const { result } = renderHook(
        () => {
          const config = useSWRConfig();
          const inbox = useSWR(["/api/sessions/inbox", "viewer"], fetchInbox, {
            shouldRetryOnError: false,
          });
          return { config, inbox, data: inbox.data, error: inbox.error };
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current.data).toEqual({ version: 1 }));
      let concurrent!: Promise<unknown>;
      act(() => {
        concurrent = result.current.inbox.mutate();
      });
      await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(2));
      let update!: Promise<void>;
      act(() => {
        update = updateSessionScope(
          "/api/sessions/s1/visibility",
          { method: "PUT" },
          snapshot,
          result.current.config
        );
      });
      await waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
      await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(3));
      const cause = new Error("Older inbox request failed");
      if (timing === "before") {
        await act(async () => {
          failConcurrent(cause);
          await concurrent;
        });
        expect(result.current.error).toBe(cause);
      }
      await act(async () => {
        finishSnapshot();
        await update;
      });
      if (timing === "after") {
        await act(async () => {
          failConcurrent(cause);
          await concurrent;
        });
        expect(result.current.error).toBe(cause);
      }
      expect(snapshot).toHaveBeenCalledOnce();
      expect(browserApiFetch).toHaveBeenCalledOnce();
    }
  );

  it.each(["success", "failure"])(
    "reports snapshot %s and permits recovery while discovery revalidation is pending",
    async (outcome) => {
      vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
      let finishDiscovery!: (data: { version: number }) => void;
      const fetchInbox = vi
        .fn()
        .mockResolvedValueOnce({ version: 1 })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishDiscovery = resolve;
            })
        )
        .mockResolvedValue({ version: 2 });
      const cause = new Error("Snapshot unavailable");
      const snapshot = vi.fn().mockResolvedValue(undefined);
      if (outcome === "failure") snapshot.mockRejectedValueOnce(cause);
      const { result } = renderHook(
        () => {
          const config = useSWRConfig();
          const inbox = useSWR("/api/sessions/inbox", fetchInbox);
          return { config, data: inbox.data };
        },
        { wrapper }
      );
      await waitFor(() => expect(result.current.data).toEqual({ version: 1 }));
      const completed = vi.fn();
      act(() => {
        void updateSessionScope(
          "/api/sessions/s1/visibility",
          { method: "PUT" },
          snapshot,
          result.current.config
        ).then(
          () => completed(null),
          (error) => completed(error)
        );
      });
      await waitFor(() => expect(fetchInbox).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(completed).toHaveBeenCalledOnce());
      const error = completed.mock.calls[0][0];
      if (outcome === "failure") {
        expect(error).toBeInstanceOf(SessionScopeRefreshError);
        expect(error.cause).toBe(cause);
        await act(() => error.retryRefresh());
        expect(snapshot).toHaveBeenCalledTimes(2);
      } else {
        expect(error).toBeNull();
        expect(snapshot).toHaveBeenCalledOnce();
      }
      await act(async () => finishDiscovery({ version: 2 }));
      expect(browserApiFetch).toHaveBeenCalledOnce();
    }
  );

  it("completes a scope write without refetching membership or unmounting the terminal", async () => {
    const sandboxAccess = { ttydUrl: "https://terminal.example", ttydToken: "token" };
    const meTeams = { teams: [{ id: "source" }] };
    const fetchMembership = vi.fn().mockResolvedValue(meTeams);
    // An unexpected refetch must not mask a cleared sandbox-access cache.
    const fetchSandboxAccess = vi
      .fn()
      .mockResolvedValueOnce(sandboxAccess)
      .mockImplementation(() => new Promise<typeof sandboxAccess>(() => {}));
    const terminalMounted = vi.fn();
    const terminalUnmounted = vi.fn();
    const snapshot = vi.fn().mockResolvedValue(undefined);
    vi.mocked(browserApiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    let request!: Promise<void>;

    function Terminal() {
      useEffect(() => {
        terminalMounted();
        return () => terminalUnmounted();
      }, []);
      return <div data-testid="terminal">Terminal</div>;
    }

    function Session() {
      const config = useSWRConfig();
      const access = useSWR("/api/sessions/s1/sandbox-access", fetchSandboxAccess);
      const membership = useSWR(["/api/me/teams", "viewer"], fetchMembership);
      return (
        <>
          <div data-testid="sandbox-access">{JSON.stringify(access.data)}</div>
          <div data-testid="membership">{JSON.stringify(membership.data)}</div>
          {access.data?.ttydUrl && <Terminal />}
          <button
            onClick={() => {
              request = updateSessionScope(
                "/api/sessions/s1/visibility",
                { method: "PUT" },
                snapshot,
                config
              );
            }}
          >
            Update scope
          </button>
        </>
      );
    }

    const view = render(<Session />, { wrapper });
    await waitFor(() => {
      expect(view.getByTestId("sandbox-access").textContent).toBe(JSON.stringify(sandboxAccess));
      expect(view.getByTestId("membership").textContent).toBe(JSON.stringify(meTeams));
      expect(view.getByTestId("terminal")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Update scope" }));
      await request;
    });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(fetchMembership).toHaveBeenCalledOnce();
    expect(view.getByTestId("membership").textContent).toBe(JSON.stringify(meTeams));
    expect(view.getByTestId("sandbox-access").textContent).toBe(JSON.stringify(sandboxAccess));
    expect(view.getByTestId("terminal")).toBeTruthy();
    expect(fetchSandboxAccess).toHaveBeenCalledOnce();
    expect(terminalMounted).toHaveBeenCalledOnce();
    expect(terminalUnmounted).not.toHaveBeenCalled();
  });

  it.each(
    [
      buildSessionsPageKey({ teamIds: ["team_source", "team_target"], offset: 100 }),
      ["/api/teams", "viewer"],
      ["/api/teams/team_source", "viewer"],
      "/api/teams/team_source/sessions?cursor=page2",
      ["/api/teams/team_source/sessions?bucket=finished", "viewer"],
      ["/api/audit-events?cursor=page2", "viewer"],
      ["/api/sessions/inbox?category=finished", "viewer"],
    ].map((key) => ({ key }))
  )(
    "invalidates inactive $key without an infinite list and refetches on remount",
    async ({ key }) => {
      let version = 1;
      const fetchResource = vi.fn(async () => ({ version }));
      vi.mocked(browserApiFetch).mockImplementation(async () => {
        version = 2;
        return new Response(null, { status: 204 });
      });
      const { result, rerender } = renderHook(
        ({ mounted }) => {
          const config = useSWRConfig();
          const resource = useSWR(mounted ? key : null, fetchResource);
          return {
            resource,
            update: () =>
              updateSessionScope(
                "/api/sessions/s1/visibility",
                { method: "PUT" },
                async () => {},
                config
              ),
          };
        },
        { wrapper, initialProps: { mounted: true } }
      );
      await waitFor(() => expect(result.current.resource.data).toEqual({ version: 1 }));
      rerender({ mounted: false });
      await act(() => result.current.update());
      expect(fetchResource).toHaveBeenCalledOnce();
      rerender({ mounted: true });
      expect(result.current.resource.data).toBeUndefined();
      await waitFor(() => expect(result.current.resource.data).toEqual({ version: 2 }));
      expect(fetchResource).toHaveBeenCalledTimes(2);
    }
  );

  it("clears inactive canonical infinite pages and their aggregate without losing page size", async () => {
    let version = 1;
    const pageKey = (page: number) =>
      buildSessionsPageKey({ teamIds: ["team_source", "team_target"], offset: page * 50 });
    const fetchPage = vi.fn(async () => ({ version }));
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      version = 2;
      return new Response(null, { status: 204 });
    });
    const { result, rerender } = renderHook(
      ({ mounted }) => {
        const config = useSWRConfig();
        const list = useSWRInfinite((page) => (mounted ? pageKey(page) : null), fetchPage);
        return {
          list,
          update: () =>
            updateSessionScope(
              "/api/sessions/s1/visibility",
              { method: "PUT" },
              async () => {},
              config
            ),
        };
      },
      { wrapper, initialProps: { mounted: true } }
    );
    await waitFor(() => expect(result.current.list.data).toEqual([{ version: 1 }]));
    await act(() => result.current.list.setSize(2));
    await waitFor(() => expect(result.current.list.data).toEqual([{ version: 1 }, { version: 1 }]));
    expect(result.current.list.size).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(3);

    rerender({ mounted: false });
    await act(() => result.current.update());
    expect(fetchPage).toHaveBeenCalledTimes(3);
    rerender({ mounted: true });
    expect(result.current.list.data).toBeUndefined();
    expect(result.current.list.size).toBe(2);
    await waitFor(() => expect(result.current.list.data).toEqual([{ version: 2 }, { version: 2 }]));
    expect(result.current.list.size).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("refetches every discovery page, both team scopes, inbox, and audit without timestamp changes", async () => {
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
          (page) => buildSessionsPageKey({ teamIds: ["team_source"], offset: page * 50 }),
          fetchPage,
          { initialSize: 2 }
        );
        const target = useSWRInfinite(
          (page) => buildSessionsPageKey({ teamIds: ["team_target"], offset: page * 50 }),
          fetchPage,
          { initialSize: 2 }
        );
        const inbox = useSWR(["/api/sessions/inbox?mine=true", "viewer"], ([path]) =>
          fetchPage(path)
        );
        const teams = useSWR(["/api/teams", "viewer"], ([path]) => fetchPage(path));
        const sourceBucket = useSWR(
          "/api/teams/team_source/sessions?bucket=in_progress",
          fetchPage
        );
        const targetBucket = useSWR(
          "/api/teams/team_target/sessions?bucket=needs_attention",
          fetchPage
        );
        const activity = useSWR("/api/activity?teamId=team_target", fetchPage);
        const audit = useSWR(["/api/audit-events?limit=25", "viewer"], ([path]) => fetchPage(path));
        const sessionSnapshot = useSWR("/api/sessions/s1", fetchPage);
        const children = useSWR("/api/sessions/s1/children", fetchPage);
        const sandboxAccess = useSWR("/api/sessions/s1/sandbox-access", fetchPage);
        const diff = useSWR("/api/sessions/s1/diff", fetchPage);
        const skills = useSWRInfinite(
          (page) => `/api/sessions/s1/skills?offset=${page}`,
          fetchPage,
          { initialSize: 2 }
        );
        const profiles = useSWR(["/api/sessions/s1/participant-profiles", "viewer"], ([path]) =>
          fetchPage(path)
        );
        const candidates = useSWR("/api/sessions/s1/collaborator-candidates", fetchPage);
        const unrelated = useSWR("/api/repos", fetchPage);
        return {
          source,
          target,
          inbox,
          teams,
          sourceBucket,
          targetBucket,
          activity,
          audit,
          sessionSnapshot,
          children,
          sandboxAccess,
          diff,
          skills,
          profiles,
          candidates,
          unrelated,
          update: () =>
            updateSessionScope(
              "/api/sessions/s1/visibility",
              {
                method: "PUT",
                body: { visibility: "private", includeChildren: true },
              },
              async () => {
                await snapshot();
                await sessionSnapshot.mutate();
              },
              { mutate, cache }
            ),
        };
      },
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.source.data).toHaveLength(2);
      expect(result.current.target.data).toHaveLength(2);
      expect(result.current.skills.data).toHaveLength(2);
      for (const resource of [
        result.current.inbox,
        result.current.teams,
        result.current.sourceBucket,
        result.current.targetBucket,
        result.current.audit,
      ]) {
        expect(resource.data?.version).toBe(1);
      }
      for (const resource of [
        result.current.sessionSnapshot,
        result.current.children,
        result.current.sandboxAccess,
        result.current.diff,
        result.current.profiles,
        result.current.candidates,
      ]) {
        expect(resource.data?.version).toBe(1);
      }
      expect(result.current.unrelated.data?.version).toBe(1);
    });
    await act(() => result.current.update());
    expect(snapshot).toHaveBeenCalledOnce();
    for (const list of [result.current.source, result.current.target]) {
      expect(list.data?.map((page) => page.version)).toEqual([2, 2]);
      expect(list.size).toBe(2);
      for (const page of list.data ?? []) {
        expect(fetchPage.mock.calls.filter(([path]) => path === page.path)).toHaveLength(2);
      }
    }
    for (const list of [
      result.current.inbox,
      result.current.teams,
      result.current.sourceBucket,
      result.current.targetBucket,
      result.current.audit,
    ]) {
      expect(list.data?.version).toBe(2);
      expect(fetchPage.mock.calls.filter(([path]) => path === list.data?.path)).toHaveLength(2);
    }
    expect(result.current.unrelated.data?.version).toBe(1);
    expect(result.current.activity.data?.version).toBe(1);
    expect(
      fetchPage.mock.calls.filter(([path]) => path === "/api/activity?teamId=team_target")
    ).toHaveLength(1);
    expect(fetchPage.mock.calls.filter(([path]) => path === "/api/repos")).toHaveLength(1);
    expect(result.current.sessionSnapshot.data?.version).toBe(2);
    expect(fetchPage.mock.calls.filter(([path]) => path === "/api/sessions/s1")).toHaveLength(2);
    for (const resource of [
      result.current.children,
      result.current.sandboxAccess,
      result.current.diff,
      result.current.profiles,
      result.current.candidates,
    ]) {
      expect(resource.data?.version).toBe(1);
      expect(fetchPage.mock.calls.filter(([path]) => path === resource.data?.path)).toHaveLength(1);
    }
    expect(result.current.skills.data?.map((page) => page.version)).toEqual([1, 1]);
    for (const page of result.current.skills.data ?? []) {
      expect(fetchPage.mock.calls.filter(([path]) => path === page.path)).toHaveLength(1);
    }
  });
});
