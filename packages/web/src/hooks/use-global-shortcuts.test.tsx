// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import { useGlobalShortcuts } from "./use-global-shortcuts";

const mocks = vi.hoisted(() => ({ canCreateSession: true }));

const shortcuts = {
  ...DEFAULT_KEYBOARD_SHORTCUTS,
  "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
  "new-session": { code: "KeyN", primary: true, alt: false, shift: true },
  "toggle-sidebar": { code: "KeyB", primary: true, alt: false, shift: false },
};

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts }),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission === "sessions.create" && mocks.canCreateSession,
  }),
}));

describe("useGlobalShortcuts", () => {
  afterEach(() => {
    mocks.canCreateSession = true;
    vi.restoreAllMocks();
  });

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

  it("ignores the new session shortcut without session creation permission", () => {
    mocks.canCreateSession = false;
    const onNewSession = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({
        onOpenCommandMenu: vi.fn(),
        onNewSession,
        onToggleSidebar: vi.fn(),
      })
    );

    const event = new KeyboardEvent("keydown", {
      code: "KeyN",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(onNewSession).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
