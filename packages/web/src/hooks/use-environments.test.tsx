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
    const initialProps: { teamId: string | undefined } = { teamId: "team/one" };
    const { rerender } = renderHook(
      ({ teamId }: { teamId: string | undefined }) => useEnvironments(teamId),
      {
        initialProps,
      }
    );
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team%2Fone");
    rerender({ teamId: "team-2" });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team-2");
    rerender({ teamId: undefined });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments");
  });

  it("uses an exact workspace-ownership filter for explicit null", () => {
    renderHook(() => useEnvironments(null));
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=null");
  });
});
