// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Automation, ListAutomationsResponse } from "@open-inspect/shared";
import { useAutomations } from "./use-automations";

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));

function automation(id: string, name: string): Automation {
  return {
    id,
    name,
    instructions: "Run maintenance",
    triggerType: "schedule",
    scheduleCron: "0 9 * * *",
    scheduleTz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdBy: "user-1",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    eventType: null,
    triggerConfig: { conditions: [] },
    repositories: [],
    environmentIds: [],
  };
}

const firstAutomation = automation("auto-2", "Daily sync");
const secondAutomation = automation("auto-1", "Daily cleanup");

function wrapper(fetcher: (path: string) => Promise<unknown>) {
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
    const fetcher = vi.fn(async (path: string): Promise<ListAutomationsResponse> => {
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
      async (path: string): Promise<ListAutomationsResponse> => ({
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
    const insertedAutomation = automation("auto-3", "New automation");
    let listVersion: "initial" | "updated" = "initial";
    const fetcher = vi.fn(async (path: string): Promise<ListAutomationsResponse> => {
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

  it("reports an invalid page response as a contract error", async () => {
    const fetcher = vi.fn(async () => ({
      automations: [],
      hasMore: true,
      nextCursor: null,
    }));
    const { result } = renderHook(() => useAutomations(""), {
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.error?.message).toBe("Invalid automations response"));
    expect(result.current.automations).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it("does not request another page after the final page", async () => {
    const fetcher = vi.fn(
      async (): Promise<ListAutomationsResponse> => ({
        automations: [firstAutomation],
        hasMore: false,
        nextCursor: null,
      })
    );
    const { result } = renderHook(() => useAutomations(""), {
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.automations).toEqual([firstAutomation]));
    await act(() => result.current.loadMore());

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache or paginate beyond an invalid later page", async () => {
    const fetcher = vi.fn(async (path: string) =>
      path.includes("cursor=")
        ? { automations: [], hasMore: true, nextCursor: null }
        : { automations: [firstAutomation], hasMore: true, nextCursor: "next" }
    );
    const { result } = renderHook(() => useAutomations(""), {
      wrapper: wrapper(fetcher),
    });

    await waitFor(() => expect(result.current.automations).toEqual([firstAutomation]));
    await act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.error?.message).toBe("Invalid automations response"));
    expect(result.current.automations).toEqual([firstAutomation]);
    expect(
      fetcher.mock.calls.filter(([path]) => String(path).includes("cursor=")).map(([path]) => path)
    ).toEqual(["/api/automations?limit=25&cursor=next"]);
  });
});
