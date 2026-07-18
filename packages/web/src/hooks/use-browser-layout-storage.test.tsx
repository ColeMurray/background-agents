// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useDefaultLayout } from "react-resizable-panels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowserLayoutStorage } from "./use-browser-layout-storage";

function LayoutProbe() {
  const storage = useBrowserLayoutStorage();
  useDefaultLayout({ id: "ssr-layout-probe", panelIds: ["main"], storage });
  return null;
}

describe("useBrowserLayoutStorage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("provides explicit storage when a panel layout renders on the server", () => {
    expect(() => renderToString(<LayoutProbe />)).not.toThrow();
  });

  it("persists layouts after hydration", async () => {
    const { result } = renderHook(() => useBrowserLayoutStorage());

    await waitFor(() => {
      result.current.setItem("layout", "saved");
      expect(result.current.getItem("layout")).toBe("saved");
    });
    expect(window.localStorage.getItem("layout")).toBe("saved");
  });

  it("fails open when browser storage operations are restricted", async () => {
    const restrictedStorage = {
      getItem: vi.fn(() => {
        throw new DOMException("Storage denied", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("Storage denied", "SecurityError");
      }),
    } as unknown as Storage;
    vi.spyOn(window, "localStorage", "get").mockReturnValue(restrictedStorage);

    const { result } = renderHook(() => useBrowserLayoutStorage());

    await waitFor(() => expect(() => result.current.getItem("layout")).not.toThrow());
    expect(result.current.getItem("layout")).toBeNull();
    expect(() => result.current.setItem("layout", "saved")).not.toThrow();
  });

  it("fails open when browser storage cannot be accessed", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    const { result } = renderHook(() => useBrowserLayoutStorage());

    expect(result.current.getItem("layout")).toBeNull();
  });
});
