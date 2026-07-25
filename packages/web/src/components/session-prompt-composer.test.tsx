// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { SessionPromptComposer } from "./session-prompt-composer";

expect.extend(matchers);

vi.mock("@/components/action-bar", () => ({ ActionBar: () => null }));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      Model
    </button>
  ),
}));
vi.mock("@/components/reasoning-effort-pills", () => ({
  ReasoningEffortPills: ({ disabled }: { disabled?: boolean }) => (
    <button type="button" disabled={disabled}>
      Reasoning
    </button>
  ),
}));
vi.mock("@/components/voice-input-button", () => ({
  VoiceInputButton: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button type="button" onClick={() => onTranscript("Run the voice-input tests.")}>
      Voice input
    </button>
  ),
}));

afterEach(cleanup);

function renderComposer(
  overrides: {
    isCompacting?: boolean;
    submissionError?: string;
    isSubmitting?: boolean;
  } = {}
) {
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  const onStopExecution = vi.fn();
  const onTranscript = vi.fn();
  render(
    <SessionPromptComposer
      session={{
        id: "session-1",
        status: "active",
        artifacts: [],
        onArchive: vi.fn(),
        onUnarchive: vi.fn(),
      }}
      prompt={{
        value: "Run the tests next",
        isProcessing: !overrides.isCompacting,
        isCompacting: overrides.isCompacting ?? false,
        isSubmitting: overrides.isSubmitting ?? false,
        submissionError: overrides.submissionError ?? null,
        inputRef: { current: null },
        onSubmit,
        onChange: vi.fn(),
        onKeyDown: vi.fn(),
        onStopExecution,
        onCompactContext: vi.fn(),
        onTranscript,
      }}
      model={{
        selectedModel: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        items: [],
        onModelChange: vi.fn(),
        onReasoningEffortChange: vi.fn(),
      }}
    />
  );
  return { onSubmit, onStopExecution, onTranscript };
}

describe("SessionPromptComposer", () => {
  it("offers cancellation while context compaction is active", () => {
    renderComposer({ isCompacting: true });

    expect(screen.getByRole("button", { name: "Cancel context compaction" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask or build anything")).toBeInTheDocument();
  });

  it("offers Queue and Stop as separate actions during an active run", () => {
    const { onSubmit, onStopExecution } = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /queue/i }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStopExecution).toHaveBeenCalledTimes(1);
  });

  it("keeps model controls available while an active run accepts follow-ups", () => {
    renderComposer();

    expect(screen.getByRole("button", { name: "Model" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reasoning" })).toBeEnabled();
  });

  it("keeps a rejected submission visible and retryable", () => {
    renderComposer({ submissionError: "Not connected. Reconnect and try again." });

    expect(screen.getByDisplayValue("Run the tests next")).toBeInTheDocument();
    expect(screen.getByText("Not connected. Reconnect and try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /queue/i })).toBeEnabled();
  });

  it("returns voice transcripts to the editable draft", () => {
    const { onSubmit, onTranscript } = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Voice input" }));

    expect(onTranscript).toHaveBeenCalledWith("Run the voice-input tests.");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
