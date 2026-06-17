"use client";

import { ActionBar } from "@/components/action-bar";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";
import { FileIcon, ModelIcon, SendIcon, StopIcon } from "@/components/ui/icons";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import type { Artifact } from "@/types/session";
import { PROMPT_ATTACHMENT_ACCEPT } from "@open-inspect/shared";
import type { Attachment } from "@open-inspect/shared";
import { useRef } from "react";

type SessionPromptComposerProps = {
  session: {
    id: string;
    status: string;
    artifacts: Artifact[];
    onArchive: () => void | Promise<void>;
    onUnarchive: () => void | Promise<void>;
  };
  prompt: {
    value: string;
    isProcessing: boolean;
    attachments: Attachment[];
    attachmentError: string | null;
    isUploadingAttachments: boolean;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    onSubmit: (e: React.FormEvent) => void;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onAttachmentFilesSelected: (files: FileList) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onStopExecution: () => void;
  };
  model: {
    selectedModel: string;
    reasoningEffort: string | undefined;
    items: ComboboxGroup[];
    onModelChange: (model: string) => void;
    onReasoningEffortChange: (value: string | undefined) => void;
  };
};

export function SessionPromptComposer({ session, prompt, model }: SessionPromptComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasAttachments = prompt.attachments.length > 0;

  return (
    <footer className="border-t border-border-muted flex-shrink-0">
      <form onSubmit={prompt.onSubmit} className="max-w-4xl mx-auto p-4 pb-6">
        {/* Action bar above input */}
        <div className="mb-3">
          <ActionBar
            sessionId={session.id}
            sessionStatus={session.status}
            artifacts={session.artifacts}
            onArchive={session.onArchive}
            onUnarchive={session.onUnarchive}
          />
        </div>

        {/* Input container */}
        <div className="border border-border bg-input">
          {/* Text input area with floating send button */}
          <div className="relative">
            <textarea
              ref={prompt.inputRef}
              value={prompt.value}
              onChange={prompt.onChange}
              onKeyDown={prompt.onKeyDown}
              placeholder={
                prompt.isProcessing ? "Type your next message..." : "Ask or build anything"
              }
              className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
              rows={3}
            />
            {/* Floating action buttons */}
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              {prompt.isProcessing && prompt.value.trim() && (
                <span className="text-xs text-warning">Waiting...</span>
              )}
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
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={PROMPT_ATTACHMENT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                  if (event.currentTarget.files) {
                    prompt.onAttachmentFilesSelected(event.currentTarget.files);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={prompt.isProcessing || prompt.isUploadingAttachments}
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title="Attach files"
                aria-label="Attach files"
              >
                <FileIcon className="w-5 h-5" />
              </button>
              <button
                type="submit"
                disabled={
                  !prompt.value.trim() || prompt.isProcessing || prompt.isUploadingAttachments
                }
                className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                title={
                  prompt.isProcessing && prompt.value.trim()
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
                aria-label={
                  prompt.isProcessing && prompt.value.trim()
                    ? "Wait for execution to complete"
                    : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                }
              >
                <SendIcon className="w-5 h-5" />
              </button>
            </div>
          </div>

          {(hasAttachments || prompt.attachmentError || prompt.isUploadingAttachments) && (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
              {prompt.attachments.map((attachment) => {
                const key = attachment.id ?? attachment.name;
                return (
                  <span
                    key={key}
                    className="inline-flex max-w-full items-center gap-2 border border-border-muted bg-background px-2 py-1 text-xs text-muted-foreground"
                  >
                    <FileIcon className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="max-w-48 truncate">{attachment.name}</span>
                    <button
                      type="button"
                      onClick={() => prompt.onRemoveAttachment(key)}
                      className="text-secondary-foreground hover:text-foreground"
                      aria-label={`Remove ${attachment.name}`}
                    >
                      x
                    </button>
                  </span>
                );
              })}
              {prompt.isUploadingAttachments && (
                <span className="text-xs text-muted-foreground">Uploading...</span>
              )}
              {prompt.attachmentError && (
                <span className="text-xs text-destructive">{prompt.attachmentError}</span>
              )}
            </div>
          )}

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
                disabled={prompt.isProcessing}
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
                disabled={prompt.isProcessing}
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
