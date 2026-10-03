// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  type KeyboardShortcutBinding,
} from "@open-inspect/shared/types/keyboard-shortcuts";
import { usePromptInput } from "./use-prompt-input";

expect.extend(matchers);

const mocks = vi.hoisted(() => ({
  sendPrompt: vi.fn(),
  sendTyping: vi.fn(),
  clearAttachments: vi.fn(),
  uploadAll: vi.fn(),
  userId: "user-1",
}));

vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({ data: { user: { id: mocks.userId } }, status: "authenticated" }),
}));

vi.mock("@/hooks/use-session-attachments", () => ({
  DEFAULT_ATTACHMENT_ONLY_MESSAGE: "See the attached files.",
  useSessionAttachments: () => ({
    attachments: [],
    attachmentError: null,
    isUploading: false,
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: mocks.clearAttachments,
    hasAttachments: () => false,
    uploadAll: mocks.uploadAll,
  }),
}));

function PromptHarness({
  canSubmit,
  sessionId = "session-1",
  sendShortcut = DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"],
}: {
  canSubmit: boolean;
  sessionId?: string;
  sendShortcut?: KeyboardShortcutBinding;
}) {
  const prompt = usePromptInput(
    sessionId,
    mocks.sendPrompt,
    mocks.sendTyping,
    "model-1",
    undefined,
    false,
    "active",
    canSubmit,
    sendShortcut
  );

  return (
    <textarea
      aria-label="Prompt"
      value={prompt.prompt}
      onChange={prompt.handleInputChange}
      onKeyDown={prompt.handleKeyDown}
    />
  );
}

beforeEach(() => {
  mocks.sendPrompt.mockReset();
  mocks.sendTyping.mockReset();
  mocks.clearAttachments.mockReset();
  mocks.uploadAll.mockReset();
  mocks.userId = "user-1";
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("usePromptInput", () => {
  it("accepts draft edits but blocks the send shortcut before the session is ready", () => {
    render(<PromptHarness canSubmit={false} />);

    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Draft while connecting" } });
    expect(input).toHaveValue("Draft while connecting");

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(input).toHaveValue("Draft while connecting");
  });

  it("submits with the configured send shortcut instead of the default", () => {
    mocks.sendPrompt.mockResolvedValue({ ok: true });
    render(
      <PromptHarness
        canSubmit
        sendShortcut={{ code: "KeyJ", primary: false, alt: true, shift: false }}
      />
    );
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Ship it" } });

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "j", code: "KeyJ", altKey: true });
    expect(mocks.sendPrompt).toHaveBeenCalledOnce();
  });

  it.each([
    ["Enter", false],
    ["Shift+Enter", true],
  ])("submits with %s when configured", (_label, shiftKey) => {
    mocks.sendPrompt.mockResolvedValue({ ok: true });
    render(
      <PromptHarness
        canSubmit
        sendShortcut={{ code: "Enter", primary: false, alt: false, shift: shiftKey }}
      />
    );
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Ship it" } });

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey });

    expect(mocks.sendPrompt).toHaveBeenCalledOnce();
  });

  it("restores an unsent draft for the same session after a reload", async () => {
    const { unmount } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Draft before reload" },
    });
    unmount();

    render(<PromptHarness canSubmit />);

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Draft before reload")
    );
  });

  it("keeps drafts separate per session", () => {
    const { unmount } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Draft for session one" },
    });
    unmount();

    render(<PromptHarness canSubmit sessionId="session-2" />);

    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
  });

  it("clears the stored draft once the prompt is sent", async () => {
    mocks.sendPrompt.mockResolvedValue({ ok: true });
    const { unmount } = render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Ship it" } });

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(input).toHaveValue(""));
    unmount();

    render(<PromptHarness canSubmit />);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
  });

  it("keeps the stored draft when the prompt fails to send", async () => {
    mocks.sendPrompt.mockResolvedValue({ ok: false, reason: "disconnected" });
    const { unmount } = render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Ship it" } });

    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledOnce());
    unmount();

    render(<PromptHarness canSubmit />);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Ship it")
    );
  });

  it("does not restore another user's draft", () => {
    const { unmount } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Private draft" },
    });
    unmount();

    mocks.userId = "user-2";
    render(<PromptHarness canSubmit />);

    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("");
  });

  it("does not carry an in-memory draft into another account without a remount", async () => {
    const { rerender } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Private draft" },
    });

    mocks.userId = "user-2";
    rerender(<PromptHarness canSubmit />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(""));
    expect(sessionStorage.getItem("open-inspect-prompt-draft:user-2:session-1")).toBeNull();
  });

  it("keeps drafts in tab-scoped storage", () => {
    render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Tab draft" },
    });

    expect(sessionStorage.getItem("open-inspect-prompt-draft:user-1:session-1")).toBe("Tab draft");
    expect(localStorage.length).toBe(0);
  });

  it("does not erase a newer draft when an earlier send completes after a remount", async () => {
    let resolveSend: (result: { ok: true }) => void = () => {};
    mocks.sendPrompt.mockReturnValue(new Promise((resolve) => (resolveSend = resolve)));
    const { unmount } = render(<PromptHarness canSubmit />);
    const firstInput = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(firstInput, { target: { value: "First prompt" } });
    fireEvent.keyDown(firstInput, { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledOnce());
    unmount();

    render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(input).toHaveValue("First prompt"));
    fireEvent.change(input, { target: { value: "Newer draft" } });
    resolveSend({ ok: true });
    await Promise.resolve();

    await waitFor(() =>
      expect(sessionStorage.getItem("open-inspect-prompt-draft:user-1:session-1")).toBe(
        "Newer draft"
      )
    );
    expect(input).toHaveValue("Newer draft");
  });

  it("reuses the unconfirmed request ID when retrying the restored draft after a reload", async () => {
    mocks.sendPrompt.mockResolvedValue({ ok: false, reason: "timeout" });
    const { unmount } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Ship it" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    });
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledOnce());
    const firstRequestId = mocks.sendPrompt.mock.calls[0][4];
    unmount();

    render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(input).toHaveValue("Ship it"));
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(2));
    expect(mocks.sendPrompt.mock.calls[1][4]).toBe(firstRequestId);
  });

  it("uses a new request ID once the restored draft is edited", async () => {
    mocks.sendPrompt.mockResolvedValue({ ok: false, reason: "timeout" });
    const { unmount } = render(<PromptHarness canSubmit />);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Ship it" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    });
    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledOnce());
    const firstRequestId = mocks.sendPrompt.mock.calls[0][4];
    unmount();

    render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    await waitFor(() => expect(input).toHaveValue("Ship it"));
    fireEvent.change(input, { target: { value: "Ship it now" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ctrlKey: true });

    await waitFor(() => expect(mocks.sendPrompt).toHaveBeenCalledTimes(2));
    expect(mocks.sendPrompt.mock.calls[1][4]).not.toBe(firstRequestId);
  });

  it("drops the stored draft instead of restoring a stale one when saving fails", async () => {
    const { unmount } = render(<PromptHarness canSubmit />);
    const input = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(input, { target: { value: "Partial" } });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    fireEvent.change(input, { target: { value: "Partial draft that no longer fits" } });
    expect(input).toHaveValue("Partial draft that no longer fits");
    vi.restoreAllMocks();
    unmount();

    render(<PromptHarness canSubmit />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(""));
    expect(sessionStorage.getItem("open-inspect-prompt-draft:user-1:session-1")).toBeNull();
  });
});
