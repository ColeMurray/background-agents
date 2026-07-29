// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarControls, SidebarLayout } from "./sidebar-layout";
import { useAuthSession } from "@/lib/auth-session";
import { useRouter } from "next/navigation";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  isMobile: false,
  sidebar: {
    isOpen: true,
    toggle: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: () => "/",
}));

vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock("@/hooks/use-sidebar", () => ({
  useSidebar: () => mocks.sidebar,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.isMobile = false;
  mocks.sidebar.isOpen = true;
});

describe("CollapsedSidebarControls", () => {
  it("renders the sidebar, search, and new session actions inline", () => {
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    const push = vi.fn();
    vi.mocked(useRouter).mockReturnValue({ push } as never);

    render(
      <SidebarLayout>
        <CollapsedSidebarControls />
      </SidebarLayout>
    );

    const controls = screen.getByRole("button", { name: /Open sidebar/ }).parentElement;
    expect(controls).toHaveClass("flex", "items-center");
    const buttons = controls?.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    expect(Array.from(buttons!, (button) => button.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Open sidebar/),
      expect.stringMatching(/^Search sessions/),
      expect.stringMatching(/^New session/),
    ]);

    fireEvent.click(buttons![2]);
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("mobile sidebar drag", () => {
  it("opens after swiping right from the left edge", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const dragHandle = screen.getByTestId("mobile-sidebar-drag-handle");
    fireEvent.pointerDown(dragHandle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 8,
      clientY: 200,
    });
    fireEvent.pointerMove(dragHandle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 202,
    });
    fireEvent.pointerUp(dragHandle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 100,
      clientY: 202,
    });

    expect(mocks.sidebar.open).toHaveBeenCalledOnce();
  });

  it("does not open when the swipe is too short", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useAuthSession).mockReturnValue({
      data: { user: { id: "user-1", name: "Test User" } },
      status: "authenticated",
    });
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const dragHandle = screen.getByTestId("mobile-sidebar-drag-handle");
    fireEvent.pointerDown(dragHandle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 8,
      clientY: 200,
    });
    fireEvent.pointerMove(dragHandle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 50,
      clientY: 200,
    });
    fireEvent.pointerUp(dragHandle, { pointerId: 1, pointerType: "touch" });

    expect(mocks.sidebar.open).not.toHaveBeenCalled();
  });
});
