// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePanelWidth } from "./use-panel-width";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  emitWidth(width: number): void {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    );
  }
}

function panelElement(width: number): HTMLElement {
  const element = document.createElement("section");
  element.getBoundingClientRect = () => ({ width }) as DOMRect;
  return element;
}

afterEach(() => {
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

describe("usePanelWidth", () => {
  it("measures the element on mount and follows resize notifications", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const ref = { current: panelElement(800) };
    const { result } = renderHook(() => usePanelWidth(ref, { enabled: true }));

    expect(result.current).toBe(800);
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observed).toEqual([ref.current]);
    act(() => observer.emitWidth(640));
    expect(result.current).toBe(640);
  });

  it("does not observe when disabled", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const ref = { current: panelElement(800) };
    const { result } = renderHook(() => usePanelWidth(ref, { enabled: false }));

    expect(result.current).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
  });

  it("disconnects the observer on unmount", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const ref = { current: panelElement(800) };
    const { unmount } = renderHook(() => usePanelWidth(ref, { enabled: true }));

    unmount();
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
  });

  it("stays at zero when ResizeObserver is unavailable", () => {
    const ref = { current: panelElement(800) };
    const { result } = renderHook(() => usePanelWidth(ref, { enabled: true }));

    expect(result.current).toBe(0);
  });
});
