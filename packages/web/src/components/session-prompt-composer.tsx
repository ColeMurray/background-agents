"use client";

import { ActionBar } from "@/components/action-bar";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ModelIcon, SendIcon, StopIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import type { Artifact } from "@/types/session";
import type { ModelCategory } from "@open-inspect/shared";

type SessionPromptComposerProps = {
  sessionId: string;
  sessionStatus: string;
  artifacts: Artifact[];
  prompt: string;
  isProcessing: boolean;
  selectedModel: string;
  reasoningEffort: string | undefined;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (e: React.FormEvent) => void;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (value: string | undefined) => void;
  onStopExecution: () => void;
  onArchive: () => void | Promise<void>;
  onUnarchive: () => void | Promise<void>;
  modelOptions: ModelCategory[];
};

export function SessionPromptComposer({
  sessionId,
  sessionStatus,
  artifacts,
  prompt,
  isProcessing,
  selectedModel,
  reasoningEffort,
  inputRef,
  onSubmit,
  onInputChange,
  onKeyDown,
  onModelChange,
  onReasoningEffortChange,
  onStopExecution,
  onArchive,
  onUnarchive,
  modelOptions,
}: SessionPromptComposerProps) {
  return (
    <footer className="border-t border-border-muted flex-shrink-0">
      <form onSubmit={onSubmit} className="max-w-4xl mx-auto p-4 pb-6">
        {/* Action bar above input */}
        <div className="mb-3">
          <ActionBar
            sessionId={sessionId}
            sessionStatus={sessionStatus}
            artifacts={artifacts}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
          />
        </div>

        {/* Input container */}
        <div className="border border-border bg-input">
          {/* Text input area with floating send button */}
          <div className="relative">
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={onInputChange}
              onKeyDown={onKeyDown}
              placeholder={isProcessing ? "Type your next message..." : "Ask or build anything"}
              className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
              rows={3}
            />
            {/* Floating action buttons */}
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              {isProcessing && prompt.trim() && (
                <span className="text-xs text-warning">Waiting...</span>
              )}
              {isProcessing && (
                <button
                  type="button"
                  onClick={onStopExecution}
                  className="p-2 text-destructive hover:bg-destructive-muted transition"
                  title="Stop"
                >
                  <StopIcon className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                disabled={!prompt.trim() || isProcessing}
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title={
                  isProcessing && prompt.trim()
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
                aria-label={
                  isProcessing && prompt.trim()
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
              >
                <SendIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Footer row with model selector, reasoning pills, and agent label */}
          <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
            {/* Left side - Model selector + Reasoning pills */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
              <Combobox
                value={selectedModel}
                onChange={onModelChange}
                items={
                  modelOptions.map((group) => ({
                    category: group.category,
                    options: group.models.map((model) => ({
                      value: model.id,
                      label: model.name,
                      description: model.description,
                    })),
                  })) as ComboboxGroup[]
                }
                direction="up"
                dropdownWidth="w-56"
                disabled={isProcessing}
                triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <ModelIcon className="w-3.5 h-3.5" />
                <span className="truncate max-w-[9rem] sm:max-w-none">
                  {formatModelNameLower(selectedModel)}
                </span>
              </Combobox>

              {/* Reasoning effort pills */}
              <ReasoningEffortPills
                selectedModel={selectedModel}
                reasoningEffort={reasoningEffort}
                onSelect={onReasoningEffortChange}
                disabled={isProcessing}
              />
            </div>

            {/* Right side - Agent label */}
            <span className="hidden sm:inline text-sm text-muted-foreground">build agent</span>
          </div>
        </div>
      </form>
    </footer>
  );
}
