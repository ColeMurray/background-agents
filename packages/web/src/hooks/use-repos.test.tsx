// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepos } from "./use-repos";
import { SwrFetchError } from "@/lib/swr-fetch-error";

const mocks = vi.hoisted(() => ({ useSWR: vi.fn() }));

vi.mock("swr", () => ({ default: mocks.useSWR }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: {} }, status: "authenticated" }),
}));

describe("useRepos", () => {
  beforeEach(() => {
    mocks.useSWR.mockReset();
    mocks.useSWR.mockReturnValue({ data: undefined, isLoading: false, error: undefined });
  });

  it("does not request repositories when the caller is unauthorized", () => {
    renderHook(() => useRepos(false));

    expect(mocks.useSWR).toHaveBeenCalledWith(null);
  });

  it("requests repositories when enabled", () => {
    renderHook(() => useRepos());

    expect(mocks.useSWR).toHaveBeenCalledWith("/api/repos");
  });

  it.each([true, false, undefined])(
    "returns optional server grant metadata without inferring it (%s)",
    (teamHasRepositoryGrants) => {
      mocks.useSWR.mockReturnValue({
        data: {
          repos: [],
          ...(teamHasRepositoryGrants === undefined ? {} : { teamHasRepositoryGrants }),
        },
        isLoading: false,
        error: undefined,
      });
      const { result } = renderHook(() => useRepos(true, "team-1"));
      expect(result.current.teamHasRepositoryGrants).toBe(teamHasRepositoryGrants);
    }
  );

  it("keys repository requests by team and returns to the workspace key", () => {
    const initialProps: { teamId: string | null } = { teamId: "team/one" };
    const { rerender } = renderHook(
      ({ teamId }: { teamId: string | null }) => useRepos(true, teamId),
      {
        initialProps,
      }
    );
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/repos?teamId=team%2Fone");
    rerender({ teamId: "team-2" });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/repos?teamId=team-2");
    rerender({ teamId: null });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/repos");
  });

  it.each([
    [new SwrFetchError(403), []],
    [new SwrFetchError(422), []],
    [new SwrFetchError(503), ["acme/web"]],
    [new TypeError("Failed to fetch"), ["acme/web"]],
  ])("after %s exposes only usable cached repositories", (error, expected) => {
    mocks.useSWR.mockReturnValue({
      data: { repos: [{ fullName: "acme/web" }], teamHasRepositoryGrants: true },
      isLoading: false,
      error,
    });
    const { result } = renderHook(() => useRepos(true, "team-1"));
    expect(result.current.repos.map((repo) => repo.fullName)).toEqual(expected);
    expect(result.current.teamHasRepositoryGrants).toBe(expected.length ? true : undefined);
    expect(result.current.error).toBe(error);
  });
});
