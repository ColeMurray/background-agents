// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepos } from "./use-repos";

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
});
