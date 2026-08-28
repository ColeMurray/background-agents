"use client";

import { useLayoutEffect, useRef } from "react";
import { PromptSkillTextarea } from "@/components/prompt-skill-autocomplete";
import { ActionBar } from "@/components/action-bar";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import { ModelReasoningSelector } from "@/components/model-reasoning-selector";
import { PaperclipIcon, SendIcon, StopIcon } from "@/components/ui/icons";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import { ATTACHMENT_ACCEPT, type PendingAttachment } from "@/hooks/use-session-attachments";
import type { Artifact } from "@/types/session";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";
import type { PromptSkillSuggestionSource } from "@/lib/prompt-skill-completion";
import type { ModelCategory, ReasoningEffort, ValidModel } from "@open-inspect/shared/models";

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
    sendBlocked: boolean;
    submitError: string | null;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    onSubmit: (e: React.FormEvent) => void;
    onValueChange: (value: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onStopExecution: () => void;
  };
  skillSuggestions: PromptSkillSuggestionSource;
  attachments: {
    items: PendingAttachment[];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  model: {
    selectedModel: ValidModel;
    reasoningEffort: ReasoningEffort | undefined;
    items: ModelCategory[];
    onModelChange: (model: ValidModel) => void;
    onReasoningEffortChange: (value: ReasoningEffort | undefined) => void;
  };
};

export function SessionPromptComposer({
  session,
  prompt,
  skillSuggestions,
  attachments,
  model,
}: SessionPromptComposerProps) {
  const { labels } = useKeyboardShortcuts();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContent = prompt.value.trim().length > 0 || attachments.items.length > 0;
  const sessionPromptable = isSessionPromptable(session.status);
  const sendDisabled =
    !hasContent || prompt.draftLocked || prompt.sendBlocked || !sessionPromptable;
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
    <footer className="min-w-0 flex-shrink-0 border-t border-border-muted bg-background/95 backdrop-blur-sm">
      <form
        onSubmit={prompt.onSubmit}
        className="mx-auto w-full min-w-0 max-w-3xl p-3 pb-4 sm:p-4 sm:pb-5"
      >
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
          className={`rounded-xl border bg-input shadow-sm transition-shadow ${
            isDraggingOver ? "border-accent ring-2 ring-accent/30" : "border-border-muted"
          }`}
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
            <PromptSkillTextarea
              ref={prompt.inputRef}
              value={prompt.value}
              suggestions={skillSuggestions}
              onValueChange={prompt.onValueChange}
              onKeyDown={prompt.onKeyDown}
              maxLength={MAX_WEB_PROMPT_CHARS}
              disabled={prompt.draftLocked}
              onPaste={handlePaste}
              autoComplete="off"
              placeholder={prompt.isProcessing ? "Add a follow-up..." : "Ask or build anything"}
              className="min-h-12 max-h-40 w-0 min-w-48 flex-1 resize-none overflow-y-auto bg-transparent px-4 py-3 leading-6 text-foreground placeholder:text-secondary-foreground focus:outline-none sm:block sm:min-h-20 sm:w-full sm:px-4 sm:pt-4 sm:pb-12"
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
                className="rounded-md p-2 text-secondary-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                title="Attach images"
                aria-label="Attach images"
              >
                <PaperclipIcon className="w-5 h-5" />
              </button>
              {prompt.isProcessing && (
                <button
                  type="button"
                  onClick={prompt.onStopExecution}
                  className="rounded-md p-2 text-destructive transition hover:bg-destructive-muted"
                  title="Stop current prompt; queued prompts will continue"
                  aria-label="Stop current prompt; queued prompts will continue"
                >
                  <StopIcon className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                disabled={sendDisabled}
                className="flex items-center gap-1 rounded-md bg-primary p-2 text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
                title={
                  prompt.isProcessing
                    ? "Queue follow-up; runs after the current prompt"
                    : `Send (${labels["send-prompt"]})`
                }
                aria-label={
                  prompt.isProcessing
                    ? "Queue follow-up; runs after the current prompt"
                    : `Send (${labels["send-prompt"]})`
                }
              >
                {prompt.isProcessing && <span className="text-xs font-medium">Queue</span>}
                <SendIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-border-muted px-4 py-2 sm:flex-row sm:items-center sm:gap-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
              <ModelReasoningSelector
                selectedModel={model.selectedModel}
                reasoningEffort={model.reasoningEffort}
                items={model.items}
                onModelChange={model.onModelChange}
                onReasoningEffortChange={model.onReasoningEffortChange}
                disabled={prompt.draftLocked || !sessionPromptable}
              />
            </div>
          </div>
          {prompt.submitError && (
            <p
              role="alert"
              className="border-t border-destructive-border px-4 py-2 text-sm text-destructive"
            >
              {prompt.submitError}
            </p>
          )}
        </div>
      </form>
    </footer>
  );
}
