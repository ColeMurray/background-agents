// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEnvironments } from "./use-environments";

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
});
