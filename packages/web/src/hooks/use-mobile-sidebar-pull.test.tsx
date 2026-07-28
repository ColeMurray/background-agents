// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_SIDEBAR_HOLD_MS, useMobileSidebarPull } from "./use-mobile-sidebar-pull";

function Harness({
  isMobile = true,
  isSidebarOpen = false,
  onOpen,
}: {
  isMobile?: boolean;
  isSidebarOpen?: boolean;
  onOpen: () => void;
}) {
  const pull = useMobileSidebarPull({
    isMobile,
    isSidebarOpen,
    getSidebarWidth: () => 288,
    onOpen,
  });

  return (
    <div
      data-testid="handle"
      data-dragging={pull.isDragging}
      onPointerDown={pull.handlePointerDown}
      onPointerMove={pull.handlePointerMove}
      onPointerUp={pull.handlePointerUp}
      onPointerCancel={pull.reset}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useMobileSidebarPull", () => {
  it("cancels a held gesture when movement becomes vertical", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 40,
      clientY: 200,
    });
    act(() => vi.advanceTimersByTime(MOBILE_SIDEBAR_HOLD_MS));
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 38,
      clientY: 250,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });

    expect(handle.dataset.dragging).toBe("false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    { change: "leaves mobile layout", props: { isMobile: false } },
    { change: "opens through another action", props: { isSidebarOpen: true } },
  ])("cancels a pending hold when the sidebar $change", ({ props }) => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const { getByTestId, rerender } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 40,
      clientY: 200,
    });
    rerender(<Harness onOpen={onOpen} {...props} />);
    act(() => vi.advanceTimersByTime(MOBILE_SIDEBAR_HOLD_MS));
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 128,
      clientY: 200,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });

    expect(onOpen).not.toHaveBeenCalled();
  });
});
