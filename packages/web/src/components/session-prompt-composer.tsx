"use client";

import { useLayoutEffect, useRef } from "react";
import { ActionBar } from "@/components/action-bar";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { ModelIcon, PaperclipIcon, SendIcon, StopIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import { ATTACHMENT_ACCEPT, type PendingAttachment } from "@/hooks/use-session-attachments";
import type { Artifact } from "@/types/session";
import type { SessionStatus } from "@open-inspect/shared";

type SessionPromptComposerProps = {
  session: {
    id: string;
    status: SessionStatus;
    artifacts: Artifact[];
    primaryRepo?: { repoOwner: string; repoName: string } | null;
    onArchive: () => void | Promise<void>;
    onUnarchive: () => void | Promise<void>;
  };
  prompt: {
    value: string;
    isProcessing: boolean;
    draftLocked: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    onSubmit: (e: React.FormEvent) => void;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onStopExecution: () => void;
  };
  attachments: {
    items: PendingAttachment[];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  model: {
    selectedModel: string;
    reasoningEffort: string | undefined;
    items: ComboboxGroup[];
    onModelChange: (model: string) => void;
    onReasoningEffortChange: (value: string | undefined) => void;
  };
};

export function SessionPromptComposer({
  session,
  prompt,
  attachments,
  model,
}: SessionPromptComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContent = prompt.value.trim().length > 0 || attachments.items.length > 0;
  const sendDisabled = !hasContent || prompt.isProcessing || prompt.draftLocked;
  // Keep the complete draft stable while its attachments upload and until
  // the server confirms that the matching prompt was queued.
  const attachmentsLocked = prompt.draftLocked;
  const {
    isDraggingOver,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = useAttachmentDropZone({ locked: attachmentsLocked, onAdd: attachments.onAdd });

  useLayoutEffect(() => {
    const input = prompt.inputRef.current;
    if (!input) return;

    const resizeInput = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };

    resizeInput();
    window.addEventListener("resize", resizeInput);
    return () => window.removeEventListener("resize", resizeInput);
  }, [prompt.inputRef, prompt.value]);

  return (
    <footer className="min-w-0 border-t border-border-muted flex-shrink-0">
      <form onSubmit={prompt.onSubmit} className="w-full min-w-0 max-w-4xl mx-auto p-4 pb-6">
        {/* Action bar above input */}
        <div className="hidden mb-3 md:block">
          <ActionBar
            sessionId={session.id}
            sessionStatus={session.status}
            artifacts={session.artifacts}
            primaryRepo={session.primaryRepo}
            onArchive={session.onArchive}
            onUnarchive={session.onUnarchive}
          />
        </div>

        {/* Input container */}
        <div
          className={`border bg-input ${isDraggingOver ? "border-accent" : "border-border"}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Pending attachment previews */}
          <AttachmentPreviewStrip
            items={attachments.items}
            error={attachments.error}
            onRemove={attachments.onRemove}
            disabled={attachmentsLocked}
          />

          {/* Text input area with floating send button */}
          <div className="relative flex flex-wrap items-end justify-end sm:block">
            <textarea
              ref={prompt.inputRef}
              value={prompt.value}
              onChange={prompt.onChange}
              onKeyDown={prompt.onKeyDown}
              onPaste={handlePaste}
              disabled={prompt.draftLocked}
              autoComplete="off"
              placeholder={
                prompt.isProcessing ? "Type your next message..." : "Ask or build anything"
              }
              className="min-h-12 max-h-40 w-0 min-w-48 flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3 leading-6 text-foreground placeholder:text-secondary-foreground focus:outline-none sm:block sm:min-h-[7.75rem] sm:w-full sm:px-4 sm:pt-4 sm:pb-12"
              rows={1}
            />
            {/* Floating action buttons */}
            <div
              data-testid="prompt-actions"
              className="flex shrink-0 items-center gap-1 pb-1.5 pr-2 sm:absolute sm:bottom-3 sm:right-3 sm:gap-2 sm:p-0"
            >
              {attachments.isUploading && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">Uploading…</span>
              )}
              {prompt.isProcessing && prompt.value.trim() && (
                <span className="whitespace-nowrap text-xs text-warning">Waiting...</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={attachmentsLocked}
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title="Attach images"
                aria-label="Attach images"
              >
                <PaperclipIcon className="w-5 h-5" />
              </button>
              {prompt.isProcessing && (
                <button
                  type="button"
                  onClick={prompt.onStopExecution}
                  className="p-2 text-destructive hover:bg-destructive-muted transition"
                  title="Stop"
                >
                  <StopIcon className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                disabled={sendDisabled}
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title={
                  prompt.isProcessing && hasContent
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
                aria-label={
                  prompt.isProcessing && hasContent
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
                value={model.selectedModel}
                onChange={model.onModelChange}
                items={model.items}
                direction="up"
                dropdownWidth="w-56"
                disabled={prompt.isProcessing || prompt.draftLocked}
                triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <ModelIcon className="w-3.5 h-3.5" />
                <span className="truncate max-w-[9rem] sm:max-w-none">
                  {formatModelNameLower(model.selectedModel)}
                </span>
              </Combobox>

              {/* Reasoning effort pills */}
              <ReasoningEffortPills
                selectedModel={model.selectedModel}
                reasoningEffort={model.reasoningEffort}
                onSelect={model.onReasoningEffortChange}
                disabled={prompt.isProcessing || prompt.draftLocked}
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
