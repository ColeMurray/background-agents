// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  sendShortcut = DEFAULT_KEYBOARD_SHORTCUTS["send-prompt"],
}: {
  canSubmit: boolean;
  sendShortcut?: KeyboardShortcutBinding;
}) {
  const prompt = usePromptInput(
    "session-1",
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
});

afterEach(cleanup);

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
});
