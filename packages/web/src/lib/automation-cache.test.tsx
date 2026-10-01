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
import useSWR, { SWRConfig, type Cache } from "swr";
import { unstable_serialize } from "swr/infinite";
import type {
  AutomationListItem,
  ListAutomationInvocationsResponse,
  ListAutomationsResponse,
} from "@open-inspect/shared";
import AutomationDetailPage from "@/app/(app)/(sidebar)/automations/[id]/page";
import EditAutomationPage from "@/app/(app)/(sidebar)/automations/[id]/edit/page";
import NewAutomationPage from "@/app/(app)/(sidebar)/automations/new/page";
import { useAutomation, useAutomationInvocations, useAutomations } from "@/hooks/use-automations";
import { useAutomationActions } from "@/hooks/use-automation-actions";
import { browserApiFetch } from "./browser-api-fetch";
import { invalidateAutomationCache } from "./automation-cache";
import type { AutomationFormValues } from "@/components/automations/automation-form";

expect.extend(matchers);
afterEach(cleanup);
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("teamId=team-1"),
}));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: "user-1" } }, status: "authenticated" }),
}));
vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: () => ({ isOpen: true }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true, loading: false }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/components/automations/automation-form", () => ({
  AutomationForm: ({ onSubmit }: { onSubmit: (values: AutomationFormValues) => void }) => (
    <button
      onClick={() =>
        onSubmit({
          name: "Renamed",
          instructions: "Review code",
          harness: "opencode",
          model: "openai/gpt-5.4",
          reasoningEffort: null,
          triggerType: "schedule",
          scheduleCron: "0 9 * * *",
          scheduleTz: "UTC",
          repositories: [],
          environmentIds: [],
          providerSelections: {},
        })
      }
    >
      Submit automation
    </button>
  ),
}));

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
  it("clears enumerated pages and aggregates before any revalidation and isolates resources", async () => {
    const collectionKeys = [
      "/api/automations",
      "/api/automations?search=Original&teamId=team-1",
      "/api/automations?teamId=team-2&cursor=next",
      unstable_serialize(() => "/api/automations?search=Original&teamId=team-1"),
    ];
    const resourceKeys = [
      "/api/automations/auto-1",
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
            for (const resourceKey of resourceKeys) {
              expect(cache.get(resourceKey)?.data).toBe("retained");
            }
          }
        }
      );
    await invalidateAutomationCache({ cache, mutate }, "auto-1");
    for (const key of collectionKeys) {
      expect(mutate).toHaveBeenCalledWith(key, undefined, { revalidate: false });
      expect(mutate).toHaveBeenCalledWith(key);
    }
    for (const key of resourceKeys) {
      expect(mutate).not.toHaveBeenCalledWith(key, undefined, { revalidate: false });
      expect(mutate).toHaveBeenCalledWith(key);
    }
    for (const key of unrelated) {
      expect(cache.get(key)?.data).toBe("retained");
      expect(mutate).not.toHaveBeenCalledWith(key);
      expect(mutate).not.toHaveBeenCalledWith(key, undefined, { revalidate: false });
    }
    expect(mutate).toHaveBeenCalledTimes(collectionKeys.length * 2 + resourceKeys.length);
  });

  it("edits with real SWR after lists unmount, then remounts multiple pages without stale records", async () => {
    const cache: Cache = new Map();
    let updated = false;
    let releasePages!: () => void;
    const pageGate = new Promise<void>((resolve) => {
      releasePages = resolve;
    });
    const revised = { ...original, name: "Renamed", enabled: false };
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/automations/auto-1") return { automation: updated ? revised : original };
      if (!path.startsWith("/api/automations?")) return { resource: path };
      if (updated) await pageGate;
      const query = new URL(path, "https://example.com").searchParams;
      if (query.get("search") === "Original") {
        return { automations: updated ? [] : [original], hasMore: false, nextCursor: null };
      }
      const cursor = query.get("cursor");
      const page = cursor === "third" ? 3 : cursor === "second" ? 2 : 1;
      const automations = [
        page === 2
          ? updated
            ? revised
            : original
          : { ...original, id: `auto-${page + 1}`, name: `Page ${page}` },
      ];
      if (page === 3) {
        return { automations, hasMore: false, nextCursor: null } satisfies ListAutomationsResponse;
      }
      return {
        automations,
        hasMore: true,
        nextCursor: page === 1 ? "second" : "third",
      } satisfies ListAutomationsResponse;
    });
    const TestWrapper = wrapper(cache, fetcher);
    const list = renderHook(() => useAutomations("", "team-1"), { wrapper: TestWrapper });
    await waitFor(() => expect(list.result.current.automations).toHaveLength(1));
    await act(() => list.result.current.loadMore());
    await act(() => list.result.current.loadMore());
    expect(list.result.current.automations.map((item) => item.name)).toEqual([
      "Page 1",
      "Original",
      "Page 3",
    ]);
    list.unmount();
    const filtered = renderHook(() => useAutomations("Original", "team-1"), {
      wrapper: TestWrapper,
    });
    await waitFor(() => expect(filtered.result.current.automations).toHaveLength(1));
    filtered.unmount();
    const resources = renderHook(() => [useSWR("/api/repos"), useSWR("/api/automations/other")], {
      wrapper: TestWrapper,
    });
    await waitFor(() => expect(resources.result.current.every((item) => item.data)).toBe(true));
    resources.unmount();
    const unrelatedData = [
      cache.get("/api/repos")?.data,
      cache.get("/api/automations/other")?.data,
    ];

    vi.mocked(browserApiFetch).mockImplementation(async () => {
      updated = true;
      return Response.json({ automation: revised });
    });
    const params = Promise.resolve({ id: "auto-1" });
    let edit!: ReturnType<typeof render>;
    await act(async () => {
      edit = render(
        <Suspense fallback={null}>
          <EditAutomationPage params={params} />
        </Suspense>,
        { wrapper: TestWrapper }
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Submit automation" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1?teamId=team-1"));
    edit.unmount();
    for (const key of cache.keys()) {
      if (key.includes("/api/automations?")) expect(cache.get(key)?.data).toBeUndefined();
    }
    expect(cache.get("/api/automations/auto-1")?.data).toEqual({ automation: revised });
    expect([cache.get("/api/repos")?.data, cache.get("/api/automations/other")?.data]).toEqual(
      unrelatedData
    );

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
    await waitFor(() => expect(remounted.result.current.automations).toHaveLength(3));
    expect(remounted.result.current.automations.map((item) => item.name)).toEqual([
      "Page 1",
      "Renamed",
      "Page 3",
    ]);
    expect(seenNames.flat()).not.toContain("Original");
    expect(remounted.result.current.automations[1].enabled).toBe(false);
    expect(fetcher).toHaveBeenCalledWith("/api/automations?limit=25&teamId=team-1&cursor=third");
    expect(fetcher).not.toHaveBeenCalledWith("/api/repos");
    expect(fetcher).not.toHaveBeenCalledWith("/api/automations/other");
    const remountedFiltered = renderHook(() => useAutomations("Original", "team-1"), {
      wrapper: TestWrapper,
    });
    await waitFor(() => expect(remountedFiltered.result.current.loading).toBe(false));
    expect(remountedFiltered.result.current.automations).toEqual([]);
  });

  it.each(["pause", "resume", "trigger", "delete"] as const)(
    "refetches mounted collection, detail, and history after %s with real SWR",
    async (action) => {
      const cache: Cache = new Map();
      let updated = false;
      const revised = { ...original, name: "Updated" };
      const fetcher = vi.fn(async (path: string) => {
        if (path.includes("/invocations?")) return { invocations: [], total: updated ? 1 : 0 };
        if (path === "/api/automations/auto-1") {
          return { automation: updated ? (action === "delete" ? null : revised) : original };
        }
        return {
          automations: updated ? (action === "delete" ? [] : [revised]) : [original],
          hasMore: false,
          nextCursor: null,
        };
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
      vi.mocked(browserApiFetch).mockImplementation(async () => {
        updated = true;
        return Response.json({});
      });
      await act(() => result.current.actions.act("auto-1", action));
      await waitFor(() => {
        if (action === "delete") {
          expect(result.current.list.automations).toEqual([]);
          expect(result.current.detail.automation).toBeNull();
        } else {
          expect(result.current.list.automations[0]?.name).toBe("Updated");
          expect(result.current.detail.automation?.name).toBe("Updated");
        }
        expect(result.current.history.total).toBe(1);
      });
      expect(browserApiFetch).toHaveBeenCalledWith(
        action === "delete" ? "/api/automations/auto-1" : `/api/automations/auto-1/${action}`,
        { method: action === "delete" ? "DELETE" : "POST" }
      );
    }
  );

  it.each(["pause", "resume", "trigger", "save"] as const)(
    "retains loaded detail and history when GETs reject after successful %s",
    async (action) => {
      const cache: Cache = new Map();
      const detailKey = "/api/automations/auto-1";
      const historyKey = "/api/automations/auto-1/invocations?limit=20&offset=0";
      const loadedDetail = { automation: { ...original, enabled: action !== "resume" } };
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
      const TestWrapper = wrapper(cache, fetcher);
      const params = Promise.resolve({ id: "auto-1" });
      let page!: ReturnType<typeof render>;
      await act(async () => {
        page = render(
          <Suspense fallback={null}>
            <AutomationDetailPage params={params} />
          </Suspense>,
          { wrapper: TestWrapper }
        );
      });
      await screen.findByRole("heading", { name: "Original" });
      await screen.findByText("Skipped because a previous run is still active");
      if (action === "save") {
        page.unmount();
        await act(async () => {
          page = render(
            <Suspense fallback={null}>
              <EditAutomationPage params={params} />
            </Suspense>,
            { wrapper: TestWrapper }
          );
        });
        fireEvent.click(await screen.findByRole("button", { name: "Submit automation" }));
        await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/auto-1?teamId=team-1"));
        page.unmount();
        await act(async () => {
          render(
            <Suspense fallback={null}>
              <AutomationDetailPage params={params} />
            </Suspense>,
            { wrapper: TestWrapper }
          );
        });
      } else {
        const labels = { pause: "Pause", resume: "Resume", trigger: "Trigger Now" };
        fireEvent.click(screen.getByRole("button", { name: labels[action] }));
      }
      await waitFor(() => {
        expect(cache.get(detailKey)?.error).toBe(failure);
        expect(cache.get(historyKey)?.error).toBe(failure);
      });
      expect(cache.get(detailKey)?.data).toEqual(loadedDetail);
      expect(cache.get(historyKey)?.data).toEqual(loadedHistory);
      expect(screen.getByRole("heading", { name: "Original" })).toBeInTheDocument();
      expect(
        screen.getByText("Skipped because a previous run is still active")
      ).toBeInTheDocument();
      expect(screen.queryByText("Automation not found.")).not.toBeInTheDocument();
      expect(browserApiFetch).toHaveBeenCalledWith(
        action === "save" ? detailKey : `${detailKey}/${action}`,
        expect.objectContaining({ method: action === "save" ? "PUT" : "POST" })
      );
    }
  );

  it("invalidates inactive lists after creation with real SWR", async () => {
    const cache: Cache = new Map();
    const fetcher = vi.fn(async () => ({
      automations: [original],
      hasMore: false,
      nextCursor: null,
    }));
    const TestWrapper = wrapper(cache, fetcher);
    const list = renderHook(() => useAutomations("", "team-1"), { wrapper: TestWrapper });
    await waitFor(() => expect(list.result.current.automations).toHaveLength(1));
    list.unmount();
    vi.mocked(browserApiFetch).mockResolvedValue(Response.json({ automation: { id: "new-auto" } }));
    render(<NewAutomationPage />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole("button", { name: "Submit automation" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/automations/new-auto?teamId=team-1"));
    expect(cache.get("/api/automations?limit=25&teamId=team-1")?.data).toBeUndefined();
    expect(
      cache.get(unstable_serialize(() => "/api/automations?limit=25&teamId=team-1"))?.data
    ).toBeUndefined();
  });
});
