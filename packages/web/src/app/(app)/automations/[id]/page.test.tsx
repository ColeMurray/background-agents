// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { Suspense, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { Automation, AutomationRunGroup } from "@open-inspect/shared";
import AutomationDetailPage from "./page";

expect.extend(matchers);

const { mockPush, mockUseAutomation, mockUseAutomationRuns, mockUseSidebarContext } = vi.hoisted(
  () => ({
    mockPush: vi.fn(),
    mockUseAutomation: vi.fn(),
    mockUseAutomationRuns: vi.fn(),
    mockUseSidebarContext: vi.fn(),
  })
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
}));

vi.mock("@/hooks/use-automations", () => ({
  useAutomation: mockUseAutomation,
  useAutomationRuns: mockUseAutomationRuns,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function createAutomation(): Automation {
  return {
    id: "auto-1",
    name: "Weekly sweep",
    targetMode: "fixed_multi_repo",
    repoOwner: null,
    repoName: null,
    repoId: null,
    baseBranch: null,
    targets: [
      { repoOwner: "acme", repoName: "web-app", repoId: 1, baseBranch: null },
      { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: null },
    ],
    instructions: "Run the weekly sweep.",
    triggerType: "schedule",
    scheduleCron: "0 9 * * 1",
    scheduleTz: "UTC",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    enabled: true,
    nextRunAt: null,
    consecutiveFailures: 0,
    createdBy: "user-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    eventType: null,
    triggerConfig: null,
  };
}

function createGroup(id: string, skipReason: string): AutomationRunGroup {
  return {
    id,
    automationId: "auto-1",
    status: "skipped",
    skipReason,
    failureReason: null,
    scheduledAt: Date.now(),
    startedAt: Date.now(),
    completedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    startingRuns: 0,
    runningRuns: 0,
    completedRuns: 0,
    failedRuns: 0,
    skippedRuns: 0,
    runs: [],
  };
}

describe("AutomationDetailPage run history pagination", () => {
  it("loads more runs with a fixed page size and advancing offset", async () => {
    mockUseSidebarContext.mockReturnValue({ isOpen: true, toggle: vi.fn() });
    mockUseAutomation.mockReturnValue({
      automation: createAutomation(),
      loading: false,
      mutate: vi.fn(),
    });
    mockUseAutomationRuns.mockReturnValue({
      runs: [],
      groups: [createGroup("group-1", "First page group")],
      total: 2,
      loading: false,
      mutate: vi.fn(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        runs: [],
        groups: [createGroup("group-2", "Second page group")],
        total: 3,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(
        <Suspense fallback={null}>
          <AutomationDetailPage params={Promise.resolve({ id: "auto-1" })} />
        </Suspense>
      );
    });

    expect(await screen.findByText("First page group")).toBeInTheDocument();
    expect(mockUseAutomationRuns).toHaveBeenCalledWith("auto-1", 20, 0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more (1 of 2)" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/automations/auto-1/runs?limit=20&offset=1");
    });
    expect(await screen.findByText("Second page group")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more (2 of 3)" })).toBeInTheDocument();
  });
});
