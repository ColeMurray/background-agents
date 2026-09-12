// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery, useMediaQuerySnapshot } from "./use-media-query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useMediaQuerySnapshot", () => {
  it("reads client state immediately, follows changes, and removes old query subscriptions", () => {
    const mobile = new EventTarget();
    const desktop = new EventTarget();
    const queries = {
      mobile: Object.assign(mobile, { matches: true }),
      desktop: Object.assign(desktop, { matches: false }),
    };
    const mobileRemove = vi.spyOn(mobile, "removeEventListener");
    const desktopRemove = vi.spyOn(desktop, "removeEventListener");
    vi.stubGlobal("matchMedia", (query: keyof typeof queries) => queries[query]);
    const { result, rerender, unmount } = renderHook(({ query }) => useMediaQuerySnapshot(query), {
      initialProps: { query: "mobile" },
    });
    expect(result.current).toBe(true);

    act(() => {
      queries.mobile.matches = false;
      mobile.dispatchEvent(new Event("change"));
    });
    expect(result.current).toBe(false);
    act(() => {
      queries.mobile.matches = true;
      mobile.dispatchEvent(new Event("change"));
    });
    expect(result.current).toBe(true);

    rerender({ query: "desktop" });
    expect(result.current).toBe(false);
    expect(mobileRemove).toHaveBeenCalledTimes(1);
    unmount();
    expect(desktopRemove).toHaveBeenCalledTimes(1);
  });

  it("preserves the boolean SSR fallback without hiding the real client viewport", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    function Probe() {
      return <span>{String(useMediaQuery("mobile"))}</span>;
    }
    expect(renderToString(<Probe />)).toBe("<span>false</span>");
    const { result } = renderHook(() => useMediaQuery("mobile"));
    expect(result.current).toBe(true);
  });
});
