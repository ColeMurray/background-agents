// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { DEFAULT_KEYBOARD_SHORTCUTS } from "@open-inspect/shared/types/keyboard-shortcuts";
import { KeyboardShortcutsSettings } from "./keyboard-shortcuts-settings";

const save = vi.fn();
let shortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
let loading = false;

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => ({ shortcuts, loading, error: undefined, save }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

expect.extend(matchers);
afterEach(cleanup);

describe("KeyboardShortcutsSettings", () => {
  beforeEach(() => {
    shortcuts = DEFAULT_KEYBOARD_SHORTCUTS;
    loading = false;
    save.mockReset();
  });

  it("records a valid shortcut and saves the complete set", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);

    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Control>}p{/Control}");

    expect(screen.getByText("Cmd/Ctrl+P")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
    });
  });

  it.each([
    ["{Enter}", "Enter", false, "Shift+Enter"],
    ["{Shift>}{Enter}{/Shift}", "Shift+Enter", true, "Enter"],
  ])("records %s for sending prompts", async (keys, label, shift, newlineLabel) => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);

    await user.click(screen.getByRole("button", { name: /Record shortcut for Send prompt/ }));
    await user.keyboard(keys);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            `In the composer, ${label} sends and ${newlineLabel} creates a newline.`
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "send-prompt": { code: "Enter", primary: false, alt: false, shift },
    });
  });

  it("cancels recording with Escape", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Escape}");
    expect(screen.getByText("Cmd/Ctrl+K")).toBeInTheDocument();
  });

  it("identifies collisions and disables save", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(screen.getAllByText("This shortcut is already in use.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("resets a customized draft to the shipped defaults", async () => {
    shortcuts = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "toggle-sidebar": { code: "KeyB", primary: true, alt: false, shift: false },
    };
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(screen.getByText("Cmd/Ctrl+/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("does not capture a shortcut until the recorder is activated", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    const recorder = screen.getByRole("button", { name: /Record shortcut for Command menu/ });
    recorder.focus();
    await user.keyboard("{Control>}p{/Control}");
    expect(recorder).toHaveTextContent("Cmd/Ctrl+K");
  });

  it("toggles an active recorder off", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    const recorder = screen.getByRole("button", { name: /Record shortcut for Command menu/ });
    await user.click(recorder);
    expect(recorder).toHaveTextContent("Press shortcut");
    await user.click(recorder);
    expect(recorder).toHaveTextContent("Cmd/Ctrl+K");
  });

  it("records modified Escape but cancels with bare Escape", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Control>}{Escape}{/Control}");
    expect(screen.getByText("Cmd/Ctrl+Escape")).toBeInTheDocument();
  });

  it("adopts revalidated server values while the draft is clean", () => {
    loading = true;
    const { rerender } = render(<KeyboardShortcutsSettings />);
    shortcuts = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "open-command-menu": { code: "KeyP", primary: true, alt: false, shift: false },
    };
    loading = false;
    rerender(<KeyboardShortcutsSettings />);
    expect(screen.getByText("Cmd/Ctrl+P")).toBeInTheDocument();
  });

  it("preserves a dirty draft when server values revalidate", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Control>}p{/Control}");
    shortcuts = {
      ...DEFAULT_KEYBOARD_SHORTCUTS,
      "open-command-menu": { code: "KeyQ", primary: true, alt: false, shift: false },
    };
    rerender(<KeyboardShortcutsSettings />);
    expect(screen.getByText("Cmd/Ctrl+P")).toBeInTheDocument();
  });

  it("retains a dirty draft after a failed save", async () => {
    save.mockRejectedValueOnce(new Error("Save failed"));
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    await user.click(screen.getByRole("button", { name: /Record shortcut for Command menu/ }));
    await user.keyboard("{Control>}p{/Control}");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.getByText("Cmd/Ctrl+P")).toBeInTheDocument();
  });

  it("associates collision errors with recorder controls", async () => {
    const user = userEvent.setup();
    render(<KeyboardShortcutsSettings />);
    const recorder = screen.getByRole("button", { name: /Record shortcut for Command menu/ });
    await user.click(recorder);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(recorder).toHaveAttribute("aria-invalid", "true");
    expect(recorder).toHaveAccessibleDescription("This shortcut is already in use.");
  });
});
