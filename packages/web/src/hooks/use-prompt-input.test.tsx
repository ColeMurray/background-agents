// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
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

function PromptHarness({ canSubmit }: { canSubmit: boolean }) {
  const prompt = usePromptInput(
    "session-1",
    mocks.sendPrompt,
    mocks.sendTyping,
    "model-1",
    undefined,
    false,
    "active",
    canSubmit
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
});
