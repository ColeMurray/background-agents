// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionPromptComposer } from "./session-prompt-composer";

expect.extend(matchers);

vi.mock("@/components/action-bar", () => ({
  ActionBar: () => <div data-testid="action-bar" />,
}));
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
  vi.restoreAllMocks();
});

function ComposerHarness({
  initialValue = "",
  isProcessing = false,
  isUploading = false,
}: {
  initialValue?: string;
  isProcessing?: boolean;
  isUploading?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
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
        isProcessing,
        draftLocked: isUploading,
        inputRef,
        onSubmit: vi.fn(),
        onChange: (event) => setValue(event.target.value),
        onKeyDown: vi.fn(),
        onStopExecution: vi.fn(),
      }}
      attachments={{
        items: [],
        error: null,
        isUploading,
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
  it("disables autofill suggestions for the prompt", () => {
    render(<ComposerHarness />);

    expect(screen.getByPlaceholderText("Ask or build anything")).toHaveAttribute(
      "autocomplete",
      "off"
    );
  });

  it("starts with one row and grows and shrinks with its content", () => {
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockReturnValue(48);
    render(<ComposerHarness />);

    const input = screen.getByPlaceholderText<HTMLTextAreaElement>("Ask or build anything");
    expect(input).toHaveAttribute("rows", "1");
    expect(input).toHaveStyle({ height: "48px" });

    scrollHeight.mockReturnValue(112);
    fireEvent.change(input, { target: { value: "A prompt that wraps onto multiple lines" } });
    expect(input).toHaveStyle({ height: "112px" });

    scrollHeight.mockReturnValue(48);
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveStyle({ height: "48px" });

    scrollHeight.mockReturnValue(72);
    fireEvent(window, new Event("resize"));
    expect(input).toHaveStyle({ height: "72px" });
  });

  it("keeps processing and uploading controls in the mobile layout flow", () => {
    render(<ComposerHarness initialValue="Queued prompt" isProcessing isUploading />);

    const input = screen.getByPlaceholderText("Type your next message...");
    const actions = screen.getByTestId("prompt-actions");

    expect(screen.getByText("Uploading…")).toBeInTheDocument();
    expect(screen.getByText("Waiting...")).toBeInTheDocument();
    expect(screen.getByTitle("Stop")).toBeInTheDocument();
    expect(input).toHaveClass("min-w-48", "flex-1");
    expect(input).not.toHaveClass("pr-24");
    expect(input.parentElement).toHaveClass("flex-wrap", "justify-end");
    expect(actions).toHaveClass("shrink-0", "sm:absolute");
  });

  it("removes the action bar row and spacing below md", () => {
    render(<ComposerHarness />);

    expect(screen.getByTestId("action-bar").parentElement).toHaveClass(
      "hidden",
      "mb-3",
      "md:block"
    );
  });
});
