// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAutomationsPageResponse } from "@open-inspect/shared";
import { useAutomations } from "./use-automations";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

const firstAutomation = { id: "auto-2", name: "Daily sync" } as never;
const secondAutomation = { id: "auto-1", name: "Daily cleanup" } as never;

function wrapper(fetcher: (path: string) => Promise<ListAutomationsPageResponse>) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig value={{ provider: () => new Map(), fetcher, dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    );
  };
}

describe("useAutomations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads and appends cursor pages for a name search", async () => {
    const fetcher = vi.fn(async (path: string): Promise<ListAutomationsPageResponse> => {
      if (path.includes("cursor=")) {
        return { automations: [secondAutomation], hasMore: false, nextCursor: null };
      }
      return { automations: [firstAutomation], hasMore: true, nextCursor: "123:auto-2" };
    });
    const { result } = renderHook(() => useAutomations("Daily"), {
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.automations).toEqual([firstAutomation]));
    expect(fetcher).toHaveBeenCalledWith("/api/automations?limit=25&search=Daily");

    await act(() => result.current.loadMore());

    await waitFor(() =>
      expect(result.current.automations).toEqual([firstAutomation, secondAutomation])
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/automations?limit=25&search=Daily&cursor=123%3Aauto-2"
    );
    expect(result.current.hasMore).toBe(false);
  });

  it("replaces loaded pages when the search changes", async () => {
    const fetcher = vi.fn(
      async (path: string): Promise<ListAutomationsPageResponse> => ({
        automations: path.includes("search=Weekly") ? [secondAutomation] : [firstAutomation],
        hasMore: false,
        nextCursor: null,
      })
    );
    const { result, rerender } = renderHook(({ search }) => useAutomations(search), {
      initialProps: { search: "Daily" },
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.automations).toEqual([firstAutomation]));
    rerender({ search: "Weekly" });

    await waitFor(() => expect(result.current.automations).toEqual([secondAutomation]));
    expect(result.current.automations).not.toContain(firstAutomation);
  });

  it("rebuilds later cursor pages when the first page changes", async () => {
    const insertedAutomation = { id: "auto-3", name: "New automation" } as never;
    let listVersion: "initial" | "updated" = "initial";
    const fetcher = vi.fn(async (path: string): Promise<ListAutomationsPageResponse> => {
      if (path.includes("cursor=updated")) {
        return {
          automations: [firstAutomation, secondAutomation],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (path.includes("cursor=initial")) {
        return { automations: [secondAutomation], hasMore: false, nextCursor: null };
      }
      return listVersion === "initial"
        ? { automations: [firstAutomation], hasMore: true, nextCursor: "initial" }
        : { automations: [insertedAutomation], hasMore: true, nextCursor: "updated" };
    });
    const TestWrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fetcher,
          dedupingInterval: 0,
          focusThrottleInterval: 0,
        }}
      >
        {children}
      </SWRConfig>
    );
    const { result } = renderHook(() => useAutomations(""), { wrapper: TestWrapper });

    await waitFor(() => expect(result.current.automations).toEqual([firstAutomation]));
    await act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.automations).toEqual([firstAutomation, secondAutomation])
    );

    listVersion = "updated";
    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() =>
      expect(result.current.automations).toEqual([
        insertedAutomation,
        firstAutomation,
        secondAutomation,
      ])
    );
    expect(fetcher).toHaveBeenCalledWith("/api/automations?limit=25&cursor=updated");
  });
});
