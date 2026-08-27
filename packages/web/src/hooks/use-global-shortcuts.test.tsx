// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import { useGlobalShortcuts } from "./use-global-shortcuts";

const shortcuts = {
  ...DEFAULT_KEYBOARD_SHORTCUTS,
  "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
  "new-session": { code: "KeyN", primary: true, alt: false, shift: true },
  "toggle-sidebar": { code: "KeyB", primary: true, alt: false, shift: false },
};

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts }),
}));

describe("useGlobalShortcuts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches the configured action and removes its listener", () => {
    const onOpenCommandMenu = vi.fn();
    const onNewSession = vi.fn();
    const onToggleSidebar = vi.fn();
    const { unmount } = renderHook(() =>
      useGlobalShortcuts({
        onOpenCommandMenu,
        onNewSession,
        onToggleSidebar,
      })
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", ctrlKey: true }));
    expect(onOpenCommandMenu).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyK", ctrlKey: true }));
    expect(onOpenCommandMenu).toHaveBeenCalledOnce();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyN", ctrlKey: true, shiftKey: true })
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true }));
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(onToggleSidebar).toHaveBeenCalledOnce();

    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", ctrlKey: true }));
    expect(onOpenCommandMenu).toHaveBeenCalledOnce();
  });
});
