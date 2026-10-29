// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnvironments } from "./use-environments";
import { SwrFetchError } from "@/lib/swr-fetch-error";

const mocks = vi.hoisted(() => ({ useSWR: vi.fn() }));
vi.mock("swr", () => ({ default: mocks.useSWR }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: {} }, status: "authenticated" }),
}));

describe("useEnvironments", () => {
  beforeEach(() => {
    mocks.useSWR.mockReset();
    mocks.useSWR.mockReturnValue({ data: undefined, isLoading: false, error: undefined });
  });

  it("keys environment requests by team and returns to the unfiltered key", () => {
    const initialProps: { teamId: string | null | undefined } = { teamId: "team/one" };
    const { rerender } = renderHook(
      ({ teamId }: { teamId: string | null | undefined }) => useEnvironments({ teamId }),
      {
        initialProps,
      }
    );
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team%2Fone");
    rerender({ teamId: "team-2" });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team-2");
    rerender({ teamId: null });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments");
    rerender({ teamId: undefined });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments");
  });

  it.each([
    ["team/one", "/api/environments?ownerTeamId=team%2Fone"],
    [null, "/api/environments?ownerTeamId=null"],
  ])("filters by exact ownership %s", (ownerTeamId, key) => {
    renderHook(() => useEnvironments({ ownerTeamId }));
    expect(mocks.useSWR).toHaveBeenLastCalledWith(key);
  });

  it.each([
    [new SwrFetchError(404), []],
    [new SwrFetchError(400), []],
    [new SwrFetchError(500), ["env-1"]],
    [new TypeError("Failed to fetch"), ["env-1"]],
  ])("after %s exposes only usable cached environments", (error, expected) => {
    mocks.useSWR.mockReturnValue({
      data: { environments: [{ id: "env-1" }] },
      isLoading: false,
      error,
    });
    const { result } = renderHook(() => useEnvironments({ teamId: "team-1" }));
    expect(result.current.environments.map((environment) => environment.id)).toEqual(expected);
    expect(result.current.error).toBe(error);
  });
});
