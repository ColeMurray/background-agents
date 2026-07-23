// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionPromptComposer } from "./session-prompt-composer";

expect.extend(matchers);

vi.mock("@/components/action-bar", () => ({ ActionBar: () => null }));
vi.mock("@/components/attachment-preview-strip", () => ({
  AttachmentPreviewStrip: () => null,
}));
vi.mock("@/components/reasoning-effort-pills", () => ({
  ReasoningEffortPills: () => null,
}));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

afterEach(() => {
  cleanup();
});

function ComposerHarness() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <SessionPromptComposer
      session={{
        id: "session-1",
        status: "active",
        artifacts: [],
        onArchive: vi.fn(),
        onUnarchive: vi.fn(),
      }}
      prompt={{
        value,
        isProcessing: false,
        draftLocked: false,
        inputRef,
        onSubmit: vi.fn(),
        onChange: (event) => setValue(event.target.value),
        onKeyDown: vi.fn(),
        onStopExecution: vi.fn(),
      }}
      attachments={{
        items: [],
        error: null,
        isUploading: false,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }}
      model={{
        selectedModel: "model-1",
        reasoningEffort: undefined,
        items: [],
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }}
    />
  );
}

describe("SessionPromptComposer", () => {
  it("starts with one row and grows and shrinks with its content", () => {
    render(<ComposerHarness />);

    const input = screen.getByPlaceholderText<HTMLTextAreaElement>("Ask or build anything");
    expect(input).toHaveAttribute("rows", "1");

    let scrollHeight = 48;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    scrollHeight = 112;
    fireEvent.change(input, { target: { value: "A prompt that wraps onto multiple lines" } });
    expect(input).toHaveStyle({ height: "112px" });

    scrollHeight = 48;
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveStyle({ height: "48px" });

    scrollHeight = 72;
    fireEvent(window, new Event("resize"));
    expect(input).toHaveStyle({ height: "72px" });
  });
});
