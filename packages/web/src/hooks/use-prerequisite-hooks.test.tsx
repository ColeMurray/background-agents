// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import { useEnvironments } from "./use-environments";
import { useRepos, type Repo } from "./use-repos";

const mocks = vi.hoisted(() => ({ useAuthSession: vi.fn() }));

vi.mock("@/lib/auth-session", () => ({ useAuthSession: mocks.useAuthSession }));

const repo: Repo = {
  id: 1,
  fullName: "owner/repo",
  owner: "owner",
  name: "repo",
  description: null,
  private: false,
  defaultBranch: "main",
};
const environment: Environment = {
  id: "env_test",
  name: "Test",
  description: null,
  prebuildEnabled: false,
  createdAt: 0,
  updatedAt: 0,
  repositories: [{ repoOwner: "owner", repoName: "repo", repoId: 1, baseBranch: "main" }],
};

describe.each([
  { name: "useRepos", useHook: useRepos, key: "/api/repos", field: "repos", items: [repo] },
  {
    name: "useEnvironments",
    useHook: useEnvironments,
    key: "/api/environments",
    field: "environments",
    items: [environment],
  },
])("$name SWR wiring", ({ useHook, key, field, items }) => {
  const emptyResponse = field === "repos" ? { repos: [] } : { environments: [], total: 0 };
  const populatedResponse = { [field]: items, ...(field === "environments" ? { total: 1 } : {}) };
  let fetcher: ReturnType<typeof vi.fn<(key: string) => Promise<unknown>>>;

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        }}
      >
        {children}
      </SWRConfig>
    );
  }

  beforeEach(() => {
    mocks.useAuthSession.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    fetcher = vi.fn().mockResolvedValue(emptyResponse);
  });
  afterEach(cleanup);

  it("waits for auth, then reports fetch loading before accepting an empty response", async () => {
    mocks.useAuthSession.mockReturnValue({ data: null, status: "loading" });
    let resolve!: (value: typeof emptyResponse) => void;
    fetcher.mockReturnValue(new Promise<typeof emptyResponse>((done) => (resolve = done)));
    const { result, rerender } = renderHook(() => useHook(), { wrapper });

    expect(result.current).toEqual({
      [field]: [],
      status: "loading",
      loading: true,
      error: undefined,
    });
    expect(fetcher).not.toHaveBeenCalled();

    mocks.useAuthSession.mockReturnValue({ data: { user: {} }, status: "authenticated" });
    rerender();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(key);
    expect(result.current).toEqual({
      [field]: [],
      status: "loading",
      loading: true,
      error: undefined,
    });

    await act(async () => resolve(emptyResponse));
    await waitFor(() =>
      expect(result.current).toEqual({
        [field]: [],
        status: "ready",
        loading: false,
        error: undefined,
      })
    );
  });

  it("does not fetch without an authenticated session", () => {
    mocks.useAuthSession.mockReturnValue({ data: null, status: "unauthenticated" });
    const { result } = renderHook(() => useHook(), { wrapper });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      [field]: [],
      status: "unavailable",
      loading: false,
      error: undefined,
    });
  });

  it("reports an initial failure and recovers after successful revalidation", async () => {
    const error = new Error("Initial request failed");
    fetcher.mockRejectedValueOnce(error);
    const { result } = renderHook(() => ({ value: useHook(), mutate: useSWRConfig().mutate }), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.value).toEqual({
        [field]: [],
        status: "unavailable",
        loading: false,
        error,
      })
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(key);

    await act(async () => {
      await result.current.mutate(key);
    });
    await waitFor(() =>
      expect(result.current.value).toEqual({
        [field]: [],
        status: "ready",
        loading: false,
        error: undefined,
      })
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains cached data but becomes unavailable when revalidation fails", async () => {
    fetcher.mockResolvedValueOnce(populatedResponse);
    const { result } = renderHook(() => ({ value: useHook(), mutate: useSWRConfig().mutate }), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.value).toEqual({
        [field]: items,
        status: "ready",
        loading: false,
        error: undefined,
      })
    );

    const error = new Error("Revalidation failed");
    fetcher.mockRejectedValueOnce(error);
    await act(async () => {
      await result.current.mutate(key);
    });
    await waitFor(() =>
      expect(result.current.value).toEqual({
        [field]: items,
        status: "unavailable",
        loading: false,
        error,
      })
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
