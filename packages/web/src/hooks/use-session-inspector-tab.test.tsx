// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionInspectorTab } from "./use-session-inspector-tab";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("useSessionInspectorTab", () => {
  it("opens on Info by default", () => {
    const { result } = renderHook(() => useSessionInspectorTab());

    expect(result.current.tab).toBe("info");
  });

  it("persists and restores the chosen tab", async () => {
    const firstRender = renderHook(() => useSessionInspectorTab());

    act(() => firstRender.result.current.selectTab("tasks"));

    expect(firstRender.result.current.tab).toBe("tasks");
    expect(localStorage.getItem("open-inspect-session-inspector-tab")).toBe("tasks");
    firstRender.unmount();

    const secondRender = renderHook(() => useSessionInspectorTab());

    await waitFor(() => expect(secondRender.result.current.tab).toBe("tasks"));
  });

  it("shows a tab without replacing the remembered choice", () => {
    const { result } = renderHook(() => useSessionInspectorTab());

    act(() => result.current.selectTab("info"));
    act(() => result.current.showTab("changes"));

    expect(result.current.tab).toBe("changes");
    expect(localStorage.getItem("open-inspect-session-inspector-tab")).toBe("info");
  });

  it("ignores a stored value that is not a tab", async () => {
    localStorage.setItem("open-inspect-session-inspector-tab", "pull-requests");
    const { result } = renderHook(() => useSessionInspectorTab());

    await waitFor(() => expect(result.current.tab).toBe("info"));
  });

  it("keeps working when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const { result } = renderHook(() => useSessionInspectorTab());

    act(() => result.current.selectTab("tools"));

    expect(result.current.tab).toBe("tools");
  });
});
