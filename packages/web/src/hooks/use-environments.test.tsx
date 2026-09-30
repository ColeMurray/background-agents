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

  it("keys environment requests by team and returns to the workspace key", () => {
    const initialProps: { teamId: string | null } = { teamId: "team/one" };
    const { rerender } = renderHook(
      ({ teamId }: { teamId: string | null }) => useEnvironments(teamId),
      {
        initialProps,
      }
    );
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team%2Fone");
    rerender({ teamId: "team-2" });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments?teamId=team-2");
    rerender({ teamId: null });
    expect(mocks.useSWR).toHaveBeenLastCalledWith("/api/environments");
  });
});
