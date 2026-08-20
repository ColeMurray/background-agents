// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailsSidebar } from "./use-session-details-sidebar";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useSessionDetailsSidebar", () => {
  it("opens the sidebar by default", () => {
    const { result } = renderHook(() => useSessionDetailsSidebar());

    expect(result.current.isOpen).toBe(true);
  });

  it("persists and restores the closed preference", async () => {
    const firstRender = renderHook(() => useSessionDetailsSidebar());

    act(() => firstRender.result.current.toggle());

    expect(firstRender.result.current.isOpen).toBe(false);
    expect(localStorage.getItem("open-inspect-session-details-sidebar-open")).toBe("false");
    firstRender.unmount();

    const secondRender = renderHook(() => useSessionDetailsSidebar());

    await waitFor(() => expect(secondRender.result.current.isOpen).toBe(false));
  });

  it("applies multiple queued toggles in order", () => {
    const { result } = renderHook(() => useSessionDetailsSidebar());

    act(() => {
      result.current.toggle();
      result.current.toggle();
    });

    expect(result.current.isOpen).toBe(true);
    expect(localStorage.getItem("open-inspect-session-details-sidebar-open")).toBe("true");
  });

  it("keeps working when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const { result } = renderHook(() => useSessionDetailsSidebar());

    act(() => result.current.toggle());

    expect(result.current.isOpen).toBe(false);
  });
});
