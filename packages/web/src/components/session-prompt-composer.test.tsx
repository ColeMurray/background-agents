// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionPromptComposer } from "./session-prompt-composer";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";
import type { SessionCapabilities } from "@/lib/session-capabilities";

expect.extend(matchers);

const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  sandboxAccess: true,
};

vi.mock("@/components/action-bar", () => ({
  ActionBar: () => <div data-testid="action-bar" />,
}));
vi.mock("@/components/attachment-preview-strip", () => ({
  AttachmentPreviewStrip: () => null,
}));
vi.mock("@/components/model-reasoning-selector", () => ({
  ModelReasoningSelector: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled} aria-label="Model and effort">
      Model and effort
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ComposerHarness({
  initialValue = "",
  isProcessing = false,
  isUploading = false,
  connecting = false,
  status = "active",
  submitError = null,
  withSkill = false,
  canManageLifecycle = true,
}: {
  initialValue?: string;
  isProcessing?: boolean;
  isUploading?: boolean;
  connecting?: boolean;
  status?: "active" | "archived" | "cancelled";
  submitError?: string | null;
  withSkill?: boolean;
  canManageLifecycle?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <SessionPromptComposer
      session={{
        id: "session-1",
        status,
        artifacts: [],
        onArchive: vi.fn(),
        onUnarchive: vi.fn(),
        capabilities: { ...FULL_CAPABILITIES, lifecycle: canManageLifecycle },
      }}
      prompt={{
        value,
        isProcessing,
        draftLocked: isUploading,
        sendBlocked: connecting,
        submitError,
        inputRef,
        onSubmit: vi.fn(),
        onValueChange: setValue,
        onKeyDown: vi.fn(),
        onStopExecution: vi.fn(),
      }}
      skillSuggestions={{
        status: "ready",
        skills: withSkill
          ? [{ skillId: "skill-1", name: "review-pr", description: "Review a pull request" }]
          : [],
      }}
      attachments={{
        items: [],
        error: null,
        isUploading,
        onAdd: vi.fn(),
        onRemove: vi.fn(),
      }}
      model={{
        selectedModel: "anthropic/claude-sonnet-4-6",
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
    expect(screen.getByPlaceholderText("Ask or build anything")).toHaveAttribute(
      "maxlength",
      String(MAX_WEB_PROMPT_CHARS)
    );
  });

  it("allows drafting while the session connection is not ready", () => {
    render(<ComposerHarness initialValue="Draft while connecting" connecting />);

    const input = screen.getByDisplayValue("Draft while connecting");
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "Updated while connecting" } });
    expect(screen.getByDisplayValue("Updated while connecting")).toBeEnabled();
    expect(screen.getByTitle("Attach images")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Model and effort" })).toBeEnabled();
    expect(screen.getByTitle(/Send/)).toBeDisabled();
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

  it("keeps queue, stop, and uploading controls in the mobile layout flow", () => {
    render(<ComposerHarness initialValue="Queued prompt" isProcessing isUploading />);

    const input = screen.getByPlaceholderText("Add a follow-up...");
    const actions = screen.getByTestId("prompt-actions");

    expect(screen.getByText("Uploading…")).toBeInTheDocument();
    expect(screen.queryByText("Waiting...")).not.toBeInTheDocument();
    expect(screen.getByText("Queue")).toBeInTheDocument();
    expect(
      screen.getByTitle("Stop current prompt; queued prompts will continue")
    ).toBeInTheDocument();
    expect(screen.getByTitle("Queue follow-up; runs after the current prompt")).toBeDisabled();
    expect(input).toHaveClass("min-w-48", "flex-1");
    expect(input).not.toHaveClass("pr-24");
    expect(input.parentElement).toHaveClass("flex-wrap", "justify-end");
    expect(actions).toHaveClass("shrink-0", "sm:absolute");
  });

  it("keeps model controls editable while processing and blocks terminal sessions", () => {
    const { rerender } = render(<ComposerHarness initialValue="Follow up" isProcessing />);
    expect(screen.getByTitle("Queue follow-up; runs after the current prompt")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Model and effort" })).toBeEnabled();

    rerender(<ComposerHarness initialValue="Cannot send" status="archived" />);
    expect(screen.getByTitle(/Send/)).toBeDisabled();
  });

  it("hides stop controls without lifecycle permission", () => {
    render(
      <ComposerHarness initialValue="Queued prompt" isProcessing canManageLifecycle={false} />
    );

    expect(
      screen.queryByTitle("Stop current prompt; queued prompts will continue")
    ).not.toBeInTheDocument();
  });

  it("shows an inline submission error", () => {
    render(<ComposerHarness initialValue="Keep me" submitError="The prompt queue is full" />);
    expect(screen.getByRole("alert")).toHaveTextContent("The prompt queue is full");
    expect(screen.getByDisplayValue("Keep me")).toBeInTheDocument();
  });

  it("offers pinned skills in the follow-up textarea", async () => {
    const user = userEvent.setup();
    render(<ComposerHarness withSkill />);
    const input = screen.getByPlaceholderText("Ask or build anything");

    await user.click(input);
    await user.type(input, "$rev");

    expect(await screen.findByRole("option", { name: /review-pr/i })).toBeInTheDocument();
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
