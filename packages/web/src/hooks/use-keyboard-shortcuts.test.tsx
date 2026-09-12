// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KEYBOARD_SHORTCUTS_KEY, useKeyboardShortcuts } from "./use-keyboard-shortcuts";

function wrapper(fallback?: unknown) {
  return function TestWrapper({ children }: { children: ReactNode }) {
    return (
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: fallback === undefined ? undefined : { [KEYBOARD_SHORTCUTS_KEY]: fallback },
          revalidateIfStale: false,
          shouldRetryOnError: false,
        }}
      >
        {children}
      </SWRConfig>
    );
  };
}

describe("useKeyboardShortcuts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns validated saved shortcuts and formatted labels", () => {
    const custom = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
    };
    const { result } = renderHook(() => useKeyboardShortcuts(), {
      wrapper: wrapper({ shortcuts: custom }),
    });

    expect(result.current.shortcuts).toEqual(custom);
    expect(result.current.labels["open-command-menu"]).toBe("Cmd/Ctrl+P");
  });

  it("falls back to defaults when cached data is malformed", () => {
    const { result } = renderHook(() => useKeyboardShortcuts(), {
      wrapper: wrapper({ shortcuts: {} }),
    });
    expect(result.current.shortcuts).toEqual(DEFAULT_KEYBOARD_SHORTCUTS);
  });

  it("keeps shortcut identity stable across unrelated renders", () => {
    const { result, rerender } = renderHook(() => useKeyboardShortcuts(), {
      wrapper: wrapper({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS }),
    });
    const first = result.current.shortcuts;
    rerender();
    expect(result.current.shortcuts).toBe(first);
  });

  it("saves and updates the shared cache", async () => {
    const custom = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "toggle-sidebar": { code: "KeyB", primary: true, alt: false, shift: false },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shortcuts: custom }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useKeyboardShortcuts(), {
      wrapper: wrapper({ shortcuts: DEFAULT_KEYBOARD_SHORTCUTS }),
    });

    await act(() => result.current.save(custom));

    expect(fetchMock).toHaveBeenCalledWith(
      KEYBOARD_SHORTCUTS_KEY,
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ shortcuts: custom }) })
    );
    expect(result.current.shortcuts).toEqual(custom);
  });
});
