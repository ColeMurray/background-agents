// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMobileSidebarPull } from "./use-mobile-sidebar-pull";

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
      onPointerCancel={pull.handlePointerCancel}
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("useMobileSidebarPull", () => {
  it("cancels a swipe when movement becomes vertical", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 36,
      clientY: 250,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });

    expect(handle.dataset.dragging).toBe("false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each([
    { change: "leaves mobile layout", props: { isMobile: false } },
    { change: "opens through another action", props: { isSidebarOpen: true } },
  ])("cancels an active swipe when the sidebar $change", ({ props }) => {
    const onOpen = vi.fn();
    const { getByTestId, rerender } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    rerender(<Harness onOpen={onOpen} {...props} />);
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 152,
      clientY: 200,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores pulls that start in the browser edge gesture zone", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 8,
      clientY: 200,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 128,
      clientY: 200,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });

    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores events from pointers that did not initiate the drag", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Harness onOpen={onOpen} />);
    const handle = getByTestId("handle");

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 112,
      clientY: 200,
    });
    fireEvent.pointerDown(handle, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 32,
      clientY: 200,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 152,
      clientY: 200,
    });
    fireEvent.pointerCancel(handle, { pointerId: 2, pointerType: "touch" });
    fireEvent.pointerUp(handle, { pointerId: 2, pointerType: "touch" });

    expect(handle.dataset.dragging).toBe("true");
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "touch" });
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
