// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Exposes the hook plus a mutate bound to the same isolated cache. */
function useHarness() {
  return { authorization: useCurrentUserAuthorization(), mutate: useSWRConfig().mutate };
}

function renderHarness() {
  return renderHook(useHarness, {
    // A fresh provider per render keeps SWR's cache from leaking between tests.
    wrapper: ({ children }) => (
      <SWRConfig
        value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
      >
        {children}
      </SWRConfig>
    ),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthSession).mockReturnValue({
    data: { user: { id: "user-1", name: "Test User" } },
    status: "authenticated",
  });
});

describe("useCurrentUserAuthorization", () => {
  it("keeps the cached grant when a revalidation fails with a server error", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    // 200 -> 500: the server answered nothing about this user's access.
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    await result.current.mutate(currentUserAuthorizationKey("user-1"));

    await waitFor(() => expect(result.current.authorization.error).toBeDefined());
    expect(result.current.authorization.authorization).toEqual(AUTHORIZATION);
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(true);
  });

  it("keeps the cached grant when the request never reaches the server", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    vi.mocked(browserApiFetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await result.current.mutate(currentUserAuthorizationKey("user-1"));

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
    await result.current.mutate(currentUserAuthorizationKey("user-1"));

    await waitFor(() => expect(result.current.authorization.authorization).toBeNull());
    expect(result.current.authorization.hasPermission("repositories.read")).toBe(false);
  });

  it("withholds the cached grant when the response breaks the contract", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse(AUTHORIZATION));
    const { result } = renderHarness();
    await waitFor(() => expect(result.current.authorization.authorization).not.toBeNull());

    vi.mocked(browserApiFetch).mockResolvedValueOnce(jsonResponse({ nonsense: true }));
    await result.current.mutate(currentUserAuthorizationKey("user-1"));

    await waitFor(() => expect(result.current.authorization.authorization).toBeNull());
  });
});
