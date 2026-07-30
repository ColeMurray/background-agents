// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutomationsPage from "./page";

expect.extend(matchers);

const { mockReplace, mockUseAutomations, mockSearchParamsState } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockUseAutomations: vi.fn(),
  mockSearchParamsState: { value: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/automations",
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParamsState.value,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: true }),
}));

vi.mock("@/hooks/use-automations", () => ({
  useAutomations: mockUseAutomations,
}));

vi.mock("@/components/automations/automations-list", () => ({
  AutomationsList: ({ automations }: { automations: Array<{ name: string }> }) => (
    <div>{automations.map((automation) => automation.name).join(", ")}</div>
  ),
}));

const defaultHookResult = {
  automations: [{ id: "auto-1", name: "Daily sync" }],
  loading: false,
  loadingMore: false,
  error: undefined,
  hasMore: false,
  loadMore: vi.fn(),
  mutate: vi.fn(),
};

describe("AutomationsPage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockReplace.mockReset();
    mockSearchParamsState.value = new URLSearchParams();
    mockUseAutomations.mockReturnValue(defaultHookResult);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("debounces name search and stores it in the URL", () => {
    render(<AutomationsPage />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations by name" }), {
      target: { value: "release" },
    });

    expect(mockUseAutomations).toHaveBeenLastCalledWith("");
    act(() => vi.advanceTimersByTime(300));

    expect(mockUseAutomations).toHaveBeenLastCalledWith("release");
    expect(mockReplace).toHaveBeenCalledWith("/automations?search=release", { scroll: false });
  });

  it("shows retry and load-more controls for their respective states", () => {
    const retry = vi.fn();
    const loadMore = vi.fn();
    mockUseAutomations.mockReturnValue({
      ...defaultHookResult,
      error: new Error("failed"),
      hasMore: true,
      loadMore,
      mutate: retry,
    });

    render(<AutomationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Load more automations" }));
    expect(retry).toHaveBeenCalled();
    expect(loadMore).toHaveBeenCalled();
    expect(screen.getByText("Daily sync")).toBeInTheDocument();
  });

  it("follows search URL changes from browser navigation", () => {
    const { rerender } = render(<AutomationsPage />);

    mockSearchParamsState.value = new URLSearchParams({ search: "weekly" });
    rerender(<AutomationsPage />);

    expect(screen.getByRole("searchbox", { name: "Search automations by name" })).toHaveValue(
      "weekly"
    );
    expect(mockUseAutomations).toHaveBeenLastCalledWith("weekly");
  });
});
