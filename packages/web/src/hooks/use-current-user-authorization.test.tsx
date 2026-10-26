// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import {
  currentUserAuthorizationKey,
  useCurrentUserAuthorization,
} from "./use-current-user-authorization";

vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const AUTHORIZATION = {
  userId: "11111111111111111111111111111111",
  suspendedAt: null,
  role: { id: "role_builtin_member", key: "member", name: "Member" },
  permissions: ["repositories.read"],
};
const OTHER_AUTHORIZATION = { ...AUTHORIZATION, userId: "22222222222222222222222222222222" };
const AUTHENTICATED_SESSION = {
  data: { user: { id: AUTHORIZATION.userId, name: "Test User" } },
  status: "authenticated" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Exposes the hook plus a mutate bound to the same isolated cache. */
function useHarness() {
  return { authorization: useCurrentUserAuthorization(), mutate: useSWRConfig().mutate };
}

function SwrProvider({ cache, children }: { cache: Cache; children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
      {children}
    </SWRConfig>
  );
}

// A fresh cache per render keeps SWR's state from leaking between tests; pass one
// to remount a consumer against the same cache.
function renderHarness({ strictMode = false, cache = new Map() } = {}) {
  return renderHook(useHarness, {
    reactStrictMode: strictMode,
    wrapper: ({ children }) => <SwrProvider cache={cache}>{children}</SwrProvider>,
  });
}

/** Renders one keyed harness per name under one cache; rerender with fewer names to unmount. */
function renderHarnesses(names: string[]) {
  const harnesses: Record<string, ReturnType<typeof useHarness>> = {};
  function Harness({ name }: { name: string }) {
    harnesses[name] = useHarness();
    return null;
  }
  const cache = new Map();
  const tree = (mounted: string[]) => (
    <SwrProvider cache={cache}>
      {mounted.map((name) => (
        <Harness key={name} name={name} />
      ))}
    </SwrProvider>
  );
  const view = render(tree(names));
  return { harnesses, rerender: (mounted: string[]) => view.rerender(tree(mounted)) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
});
afterEach(cleanup);

describe("useCurrentUserAuthorization", () => {
  it("starts the authorization request while the session is loading", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();

    await waitFor(() => expect(browserApiFetch).toHaveBeenCalledWith("/api/me/authorization"));
    expect(result.current.authorization.authorization).toBeNull();
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
  });

  it("adopts a matching prefetch without another network call", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    let response = jsonResponse(AUTHORIZATION);
    vi.mocked(browserApiFetch).mockImplementation(async () => response);
    const { result, rerender } = renderHarness();
    await act(async () => {});

    response = jsonResponse({}, 403);
    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender();

    await waitFor(() => expect(result.current.authorization.authorization).toEqual(AUTHORIZATION));
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.authorization.error).toBeUndefined();
  });

  it("waits for an in-flight matching prefetch instead of fetching again", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    let resolveAuthorization!: (response: Response) => void;
    vi.mocked(browserApiFetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveAuthorization = resolve;
      })
    );
    const { result, rerender } = renderHarness();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender();
    expect(result.current.authorization.loading).toBe(true);
    expect(result.current.authorization.authorization).toBeNull();

    await act(async () => resolveAuthorization(jsonResponse(AUTHORIZATION)));

    await waitFor(() => expect(result.current.authorization.authorization).toEqual(AUTHORIZATION));
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("discards another user's prefetch and fetches fresh authorization", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(jsonResponse(OTHER_AUTHORIZATION))
      .mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result, rerender } = renderHarness();
    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender();

    await waitFor(() => expect(result.current.authorization.authorization).toEqual(AUTHORIZATION));
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["network", 503, 401, 403, "invalid-json", "invalid-schema"] as const)(
    "discards a failed prefetch (%s) and uses the fresh outcome",
    async (failure) => {
      vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
      vi.mocked(browserApiFetch).mockImplementationOnce(async () => {
        if (failure === "network") throw new TypeError("Failed to fetch");
        if (failure === "invalid-json") return new Response("Invalid JSON");
        return jsonResponse({}, failure === "invalid-schema" ? 200 : failure);
      });
      const { result, rerender } = renderHarness();
      await act(async () => {});

      vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
      vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
      rerender();

      await waitFor(() =>
        expect(result.current.authorization.authorization).toEqual(AUTHORIZATION)
      );
      expect(result.current.authorization.error).toBeUndefined();
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
    }
  );

  it("uses a fresh denial after a failed prefetch", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    const { result, rerender } = renderHarness();
    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender();

    await waitFor(() =>
      expect(result.current.authorization.error).toMatchObject({ retryable: false })
    );
    expect(result.current.authorization.authorization).toBeNull();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "fails closed when a fresh response names another user (prefetched: %s)",
    async (prefetched) => {
      if (prefetched) vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
      vi.mocked(browserApiFetch).mockImplementation(async () => jsonResponse(OTHER_AUTHORIZATION));
      const { result, rerender } = renderHarness();
      if (prefetched) {
        vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
        rerender();
      }

      await waitFor(() =>
        expect(result.current.authorization.error).toMatchObject({
          name: "AuthorizationRequestError",
          message: "Authorization belongs to another user",
          retryable: false,
        })
      );
      expect(result.current.authorization.authorization).toBeNull();
      expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
      expect(browserApiFetch).toHaveBeenCalledTimes(prefetched ? 2 : 1);
    }
  );

  it("revalidates an adopted grant over the network and withholds it on a denial", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result, rerender } = renderHarness();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender();
    await waitFor(() => expect(result.current.authorization.authorization).toEqual(AUTHORIZATION));

    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({}, 403));
    await act(async () => {
      await result.current.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));
    });

    await waitFor(() => expect(result.current.authorization.authorization).toBeNull());
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("prefetches only once across loading rerenders and StrictMode effects", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { rerender } = renderHarness({ strictMode: true });
    await act(async () => {});
    rerender();

    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it("adopts only the prefetch its own consumer started", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(jsonResponse(AUTHORIZATION))
      .mockResolvedValueOnce(jsonResponse(OTHER_AUTHORIZATION));
    const first = renderHarness();
    const second = renderHarness();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);

    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    first.rerender();
    await waitFor(() =>
      expect(first.result.current.authorization.authorization).toEqual(AUTHORIZATION)
    );
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: OTHER_AUTHORIZATION.userId } },
      status: "authenticated",
    });
    second.rerender();
    await waitFor(() =>
      expect(second.result.current.authorization.authorization).toEqual(OTHER_AUTHORIZATION)
    );
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not adopt a prefetch for an unauthenticated session", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({}, 401));
    const { result, rerender } = renderHarness();
    await act(async () => {});
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "unauthenticated" });
    rerender();

    expect(result.current.authorization.authorization).toBeNull();
    expect(result.current.authorization.error).toBeUndefined();
    expect(browserApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "unauthenticated"] as const)(
    "drops a successful prefetch when the session lookup ends %s, then honors a fresh denial",
    async (outcome) => {
      vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
      vi.mocked(browserApiFetch)
        .mockResolvedValueOnce(jsonResponse(AUTHORIZATION))
        .mockResolvedValueOnce(jsonResponse({}, 403));
      const { result, rerender } = renderHarness();
      await act(async () => {});
      vi.mocked(useAuthSession).mockReturnValue({ data: null, status: outcome });
      rerender();

      // The session lookup recovers for the same user after their access was revoked.
      vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
      rerender();

      await waitFor(() =>
        expect(result.current.authorization.error).toMatchObject({ retryable: false })
      );
      expect(result.current.authorization.authorization).toBeNull();
      expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
      expect(browserApiFetch).toHaveBeenCalledTimes(2);
    }
  );

  it("does not adopt a prefetch started by an earlier mount", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch)
      .mockResolvedValueOnce(jsonResponse(AUTHORIZATION))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    const cache = new Map();
    renderHarness({ cache }).unmount();
    await act(async () => {});

    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    const { result } = renderHarness({ cache });

    await waitFor(() =>
      expect(result.current.authorization.error).toMatchObject({ retryable: false })
    );
    expect(result.current.authorization.authorization).toBeNull();
    expect(browserApiFetch).toHaveBeenCalledTimes(2);
  });

  it("drops the prefetch of a consumer whose first fetch SWR deduplicated", async () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null, status: "loading" });
    vi.mocked(browserApiFetch).mockResolvedValue(jsonResponse(AUTHORIZATION));
    const { harnesses, rerender } = renderHarnesses(["first", "second"]);
    await act(async () => {});
    expect(browserApiFetch).toHaveBeenCalledTimes(2);

    vi.mocked(useAuthSession).mockReturnValue(AUTHENTICATED_SESSION);
    rerender(["first", "second"]);
    await waitFor(() =>
      expect(harnesses.second.authorization.authorization).toEqual(AUTHORIZATION)
    );

    // With the first consumer gone, the second one's fetcher serves the revalidation.
    rerender(["second"]);
    vi.mocked(browserApiFetch).mockResolvedValue(jsonResponse({}, 403));
    await act(async () => {
      await harnesses.second.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));
    });

    await waitFor(() => expect(harnesses.second.authorization.authorization).toBeNull());
    expect(browserApiFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the cached grant when a revalidation fails with a server error", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    // 200 -> 500: the server answered nothing about this user's access.
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    await result.current.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));

    await waitFor(() => expect(result.current.authorization.error).toBeDefined());
    expect(result.current.authorization.authorization).toEqual(AUTHORIZATION);
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(true);
  });

  it("keeps the cached grant when the request never reaches the server", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    vi.mocked(browserApiFetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await result.current.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));

    await waitFor(() => expect(result.current.authorization.error).toBeDefined());
    expect(result.current.authorization.authorization).toEqual(AUTHORIZATION);
  });

  // 401 follows a revoked session; 403 follows a removed role assignment
  // (`assignment_required`). Both are answers, not blips.
  it.each([401, 403])("withholds the cached grant once the server answers %i", async (status) => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      jsonResponse({ error: "assignment_required" }, status)
    );
    await result.current.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));

    await waitFor(() => expect(result.current.authorization.authorization).toBeNull());
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
  });

  it("withholds the cached grant when the response breaks the contract", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({ nonsense: true }));
    await result.current.mutate(currentUserAuthorizationKey(AUTHORIZATION.userId));

    await waitFor(() => expect(result.current.authorization.authorization).toBeNull());
  });
});
