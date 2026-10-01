// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig, useSWRConfig, type Cache } from "swr";
import { unstable_serialize } from "swr/infinite";
import type {
  AutomationListItem,
  ListAutomationInvocationsResponse,
  ListAutomationsResponse,
} from "@open-inspect/shared";
import AutomationDetailPage from "@/app/(app)/(sidebar)/automations/[id]/page";
import { useAutomation, useAutomationInvocations, useAutomations } from "@/hooks/use-automations";
import { useAutomationActions } from "@/hooks/use-automation-actions";
import { browserApiFetch } from "./browser-api-fetch";
import { invalidateAutomationCache } from "./automation-cache";

expect.extend(matchers);
afterEach(cleanup);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("teamId=team-1"),
}));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));
vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({ isOpen: true }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));

const original: AutomationListItem = {
  id: "auto-1",
  name: "Original",
  instructions: "Review code",
  harness: "opencode",
  triggerType: "schedule",
  scheduleCron: "0 9 * * *",
  scheduleTz: "UTC",
  model: "openai/gpt-5.4",
  reasoningEffort: null,
  enabled: true,
  nextRunAt: null,
  consecutiveFailures: 0,
  createdBy: "user-1",
  userId: null,
  ownerTeamId: "team-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  eventType: null,
  triggerConfig: null,
  repositories: [],
  environmentIds: [],
  providerSelections: {},
  recentExecutions: [],
  capabilities: { canRead: true, canManage: true, canTrigger: true },
};

function wrapper(cache: Cache, fetcher: (path: string) => Promise<unknown>) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => cache,
          fetcher,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("automation cache invalidation", () => {
  it.each([undefined, "auto-1"])("clears collections before refresh for %s", async (id) => {
    const collectionKeys = [
      "/api/automations",
      "/api/automations?search=Original&teamId=team-1",
      "/api/automations?teamId=team-2&cursor=next",
      unstable_serialize(() => "/api/automations?search=Original&teamId=team-1"),
    ];
    const resourceKeys = [
      "/api/automations/auto-1",
      "/api/automations/auto-1?view=detail",
      "/api/automations/auto-1/invocations?limit=20&offset=0",
    ];
    const unrelated = [
      "/api/repos",
      "/api/environments?teamId=team-1",
      "/api/automations-other",
      "/api/automations/auto-10",
      "/api/automations/auto-2",
      "/api/automations/auto-2/invocations?limit=20",
      unstable_serialize(() => "/api/sessions?teamId=team-1"),
    ];
    const cache = new Map<string, { data: string | undefined }>(
      [...collectionKeys, ...resourceKeys, ...unrelated].map((key) => [key, { data: "retained" }])
    );
    const mutate = vi
      .fn()
      .mockImplementation(
        async (key: string, data?: undefined, options?: { revalidate: boolean }) => {
          if (options?.revalidate === false) cache.set(key, { data });
          else {
            for (const collectionKey of collectionKeys) {
              expect(cache.get(collectionKey)?.data).toBeUndefined();
            }
          }
        }
      );
    await invalidateAutomationCache({ cache, mutate }, id);
    expect(mutate.mock.calls).toEqual([
      ...collectionKeys.map((key) => [key, undefined, { revalidate: false }]),
      ...collectionKeys.map((key) => [key]),
      ...(id ? resourceKeys.map((key) => [key]) : []),
    ]);
    for (const key of [...resourceKeys, ...unrelated]) {
      expect(cache.get(key)?.data).toBe("retained");
    }
  });

  it("remounts inactive paged and filtered SWR lists without stale records", async () => {
    const cache: Cache = new Map();
    let updated = false;
    let releasePages!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePages = resolve;
    });
    const revised = { ...original, name: "Renamed", enabled: false };
    const fetcher = vi.fn(async (path: string) => {
      if (updated) await pageGate;
      const query = new URL(path, "https://example.com").searchParams;
      const current = updated ? revised : original;
      if (query.get("search") === "Original") {
        return { automations: updated ? [] : [current], hasMore: false, nextCursor: null };
      }
      const secondPage = query.has("cursor");
      return (
        secondPage
          ? { automations: [current], hasMore: false, nextCursor: null }
          : {
              automations: [{ ...original, id: "auto-2", name: "Page 1" }],
              hasMore: true,
              nextCursor: "second",
            }
      ) satisfies ListAutomationsResponse;
    });
    const TestWrapper = wrapper(cache, fetcher);
    const list = renderHook(() => useAutomations("", "team-1"), { wrapper: TestWrapper });
    await waitFor(() => expect(list.result.current.automations).toHaveLength(1));
    await act(() => list.result.current.loadMore());
    expect(list.result.current.automations[1]).toEqual(original);
    list.unmount();
    const filtered = renderHook(() => useAutomations("Original", "team-1"), {
      wrapper: TestWrapper,
    });
    await waitFor(() => expect(filtered.result.current.automations).toHaveLength(1));
    filtered.unmount();
    updated = true;
    const config = renderHook(useSWRConfig, { wrapper: TestWrapper });
    await act(() => invalidateAutomationCache(config.result.current, "auto-1"));
    config.unmount();
    for (const key of cache.keys()) {
      expect(cache.get(key)?.data).toBeUndefined();
    }

    fetcher.mockClear();
    const seenNames: string[][] = [];
    const remounted = renderHook(
      () => {
        const result = useAutomations("", "team-1");
        seenNames.push(result.automations.map((item) => item.name));
        return result;
      },
      { wrapper: TestWrapper }
    );
    expect(remounted.result.current.automations).toEqual([]);
    await act(async () => {
      releasePages();
    });
    await waitFor(() => expect(remounted.result.current.automations).toHaveLength(2));
    expect(remounted.result.current.automations.map((item) => item.name)).toEqual([
      "Page 1",
      "Renamed",
    ]);
    expect(seenNames.flat()).not.toContain("Original");
    expect(remounted.result.current.automations[1].enabled).toBe(false);
    expect(fetcher).toHaveBeenCalledWith("/api/automations?limit=25&teamId=team-1&cursor=second");
    const remountedFiltered = renderHook(() => useAutomations("Original", "team-1"), {
      wrapper: TestWrapper,
    });
    await waitFor(() => expect(remountedFiltered.result.current.loading).toBe(false));
    expect(remountedFiltered.result.current.automations).toEqual([]);
    expect(remountedFiltered.result.current.error).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("/api/automations?limit=25&search=Original&teamId=team-1");
  });

  it("refreshes mounted collection, detail, and history after a trigger", async () => {
    const cache: Cache = new Map();
    let updated = false;
    const revised = { ...original, name: "Updated" };
    const fetcher = vi.fn(async (path: string) => {
      if (path.includes("/invocations?")) return { invocations: [], total: updated ? 1 : 0 };
      if (path === "/api/automations/auto-1") return { automation: updated ? revised : original };
      return { automations: [updated ? revised : original], hasMore: false, nextCursor: null };
    });
    const { result } = renderHook(
      () => ({
        list: useAutomations("", "team-1"),
        detail: useAutomation("auto-1"),
        history: useAutomationInvocations("auto-1"),
        actions: useAutomationActions(),
      }),
      { wrapper: wrapper(cache, fetcher) }
    );
    await waitFor(() => expect(result.current.list.automations).toHaveLength(1));
    await waitFor(() => expect(result.current.detail.automation?.name).toBe("Original"));
    await waitFor(() => expect(result.current.history.loading).toBe(false));
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      updated = true;
      return Response.json({});
    });
    await act(() => result.current.actions.act("auto-1", "trigger"));
    await waitFor(() => {
      expect(result.current.list.automations[0]?.name).toBe("Updated");
      expect(result.current.detail.automation?.name).toBe("Updated");
      expect(result.current.history.total).toBe(1);
    });
  });

  it("retains loaded detail and history when GETs reject after a successful trigger", async () => {
    const cache: Cache = new Map();
    const detailKey = "/api/automations/auto-1";
    const historyKey = "/api/automations/auto-1/invocations?limit=20&offset=0";
    const loadedDetail = { automation: original };
    const loadedHistory: ListAutomationInvocationsResponse = {
      invocations: [
        {
          id: "inv-1",
          automationId: "auto-1",
          status: "skipped",
          source: "manual",
          scheduledAt: null,
          skipReason: "concurrent_run_active",
          createdAt: 1,
          completedAt: 1,
          runs: [],
        },
      ],
      total: 1,
    };
    const failure = new Error("Resource GET failed (503)");
    let mutationSucceeded = false;
    const fetcher = vi.fn(async (path: string) => {
      if (mutationSucceeded) throw failure;
      return path === detailKey ? loadedDetail : loadedHistory;
    });
    vi.mocked(browserApiFetch).mockImplementation(async () => {
      mutationSucceeded = true;
      return Response.json({});
    });
    const params = Promise.resolve({ id: "auto-1" });
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <AutomationDetailPage params={params} />
        </Suspense>,
        { wrapper: wrapper(cache, fetcher) }
      );
    });
    await screen.findByRole("heading", { name: "Original" });
    await screen.findByText("Skipped because a previous run is still active");
    fireEvent.click(screen.getByRole("button", { name: "Trigger Now" }));
    await waitFor(() => {
      expect(cache.get(detailKey)?.error).toBe(failure);
      expect(cache.get(historyKey)?.error).toBe(failure);
    });
    expect(cache.get(detailKey)?.data).toEqual(loadedDetail);
    expect(cache.get(historyKey)?.data).toEqual(loadedHistory);
    expect(screen.getByRole("heading", { name: "Original" })).toBeInTheDocument();
    expect(screen.getByText("Skipped because a previous run is still active")).toBeInTheDocument();
    expect(screen.queryByText("Automation not found.")).not.toBeInTheDocument();
  });
});
