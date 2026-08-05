// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarControls, SidebarLayout } from "./sidebar-layout";
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
  it("opens after swiping right from the inset activation zone", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const gestureBoundary = screen.getByTestId("mobile-sidebar-gesture-boundary");
    expect(gestureBoundary).toHaveClass("touch-pan-y");
    fireEvent.pointerDown(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 124,
      clientY: 202,
    });
    fireEvent.pointerUp(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 124,
      clientY: 202,
    });

    expect(mocks.sidebar.open).toHaveBeenCalledOnce();
  });

  it("does not open when the swipe is too short", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);

    render(<SidebarLayout>Session</SidebarLayout>);

    vi.spyOn(screen.getByTestId("mobile-sidebar-drawer"), "getBoundingClientRect").mockReturnValue({
      width: 288,
    } as DOMRect);
    const gestureBoundary = screen.getByTestId("mobile-sidebar-gesture-boundary");
    fireEvent.pointerDown(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(gestureBoundary, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 74,
      clientY: 200,
    });
    fireEvent.pointerUp(gestureBoundary, { pointerId: 1, pointerType: "touch" });

    expect(mocks.sidebar.open).not.toHaveBeenCalled();
  });

  it("delivers taps in the activation zone to underlying content", () => {
    mocks.isMobile = true;
    mocks.sidebar.isOpen = false;
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
    const onPointerDown = vi.fn();
    const onClick = vi.fn();

    render(
      <SidebarLayout>
        <button onPointerDown={onPointerDown} onClick={onClick}>
          Content action
        </button>
      </SidebarLayout>
    );

    const contentAction = screen.getByRole("button", { name: "Content action" });
    fireEvent.pointerDown(contentAction, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerUp(contentAction, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.click(contentAction);

    expect(onPointerDown).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
    expect(mocks.sidebar.open).not.toHaveBeenCalled();
  });
});
