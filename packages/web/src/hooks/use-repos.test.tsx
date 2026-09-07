// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRepos } from "./use-repos";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: {} }, status: "authenticated" }),
}));

describe("useRepos", () => {
  afterEach(cleanup);

  it("only requests repositories after the caller is authorized", async () => {
    const fetcher = vi.fn().mockResolvedValue({ repos: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
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
    const { result, rerender } = renderHook(({ enabled }) => useRepos(enabled), {
      initialProps: { enabled: false },
      wrapper,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      repos: [],
      status: "unavailable",
      loading: false,
      error: undefined,
    });

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/repos");
  });
});
