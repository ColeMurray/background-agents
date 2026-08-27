"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { KeyboardShortcutBinding } from "@open-inspect/shared/types/keyboard-shortcuts";
import {
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import type { useSessionSocket } from "@/hooks/use-session-socket";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import {
  promptRequestSignature,
  resolvePromptRequestIdentity,
  type PromptRequestIdentity,
} from "@/lib/prompt-request-id";
import { restoreQueuedPrompt } from "@/lib/restore-queued-prompt";
import { matchesShortcut } from "@/lib/keyboard-shortcuts";

const TYPING_DEBOUNCE_MS = 300;

/** Prompt state and handlers for submission, keyboard shortcuts, and typing indicators. */
export function usePromptInput(
  sessionId: string,
  sendPrompt: ReturnType<typeof useSessionSocket>["sendPrompt"],
  sendTyping: ReturnType<typeof useSessionSocket>["sendTyping"],
  selectedModel: string,
  reasoningEffort: string | undefined,
  loadingEnabledModels: boolean,
  sessionStatus: SessionStatus,
  canSubmit: boolean,
  sendShortcut: KeyboardShortcutBinding
) {
  const [prompt, setPromptState] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sessionAttachments = useSessionAttachments();
  const hasDraftAttachments = sessionAttachments.hasAttachments;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const submitInFlightRef = useRef(false);
  const restoreFocusAfterSubmitRef = useRef(false);
  const retryRequestRef = useRef<PromptRequestIdentity | null>(null);
  const attachmentDraftSignature = sessionAttachments.attachments
    .map((attachment) => attachment.id)
    .join("\u0000");
  const promptRef = useRef(prompt);
  const setPrompt = useCallback((value: string) => {
    promptRef.current = value;
    setPromptState(value);
  }, []);

  const clearTypingTimeout = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTypingTimeout, [clearTypingTimeout]);
  useEffect(() => {
    retryRequestRef.current = null;
  }, [selectedModel, reasoningEffort, attachmentDraftSignature]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (
      submitInFlightRef.current ||
      !canSubmit ||
      (!prompt.trim() && !hasAttachments) ||
      sessionStatus === "archived" ||
      sessionStatus === "cancelled" ||
      loadingEnabledModels ||
      sessionAttachments.isUploading
    ) {
      return;
    }

    submitInFlightRef.current = true;
    restoreFocusAfterSubmitRef.current = document.activeElement === inputRef.current;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const content = prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE;
      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : "Failed to upload attachments");
          return;
        }
      }

      clearTypingTimeout();
      const signature = promptRequestSignature({
        content,
        model: selectedModel,
        reasoningEffort,
        attachmentIds: sessionAttachments.attachments.map((attachment) => attachment.id),
      });
      const requestIdentity = resolvePromptRequestIdentity(signature, retryRequestRef.current);
      retryRequestRef.current = requestIdentity;
      const result = await sendPrompt(
        content,
        selectedModel,
        reasoningEffort,
        attachments,
        requestIdentity.clientRequestId
      );
      if (!result.ok) {
        setSubmitError(
          result.message ??
            (result.reason === "timeout"
              ? "Confirmation timed out. Retry while this page is open to reuse the same request."
              : result.reason === "disconnected"
                ? "Disconnected before confirmation. Retry on this page after reconnecting."
                : "The prompt could not be queued.")
        );
        return;
      }

      retryRequestRef.current = null;
      setPrompt("");
      sessionAttachments.clearAttachments();
      mutate(isUnarchivedSessionListKey);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      if (restoreFocusAfterSubmitRef.current) {
        restoreFocusAfterSubmitRef.current = false;
        requestAnimationFrame(() => {
          if (document.activeElement === document.body) inputRef.current?.focus();
        });
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (matchesShortcut(e.nativeEvent, sendShortcut)) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInputValueChange = (value: string) => {
    setPrompt(value);
    setSubmitError(null);
    retryRequestRef.current = null;

    clearTypingTimeout();
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping();
    }, TYPING_DEBOUNCE_MS);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleInputValueChange(e.target.value);
  };

  const restorePrompt = useCallback(
    (content: string) =>
      restoreQueuedPrompt({
        content,
        currentPrompt: promptRef.current,
        hasAttachments: hasDraftAttachments(),
        setPrompt,
        input: inputRef.current,
      }),
    [hasDraftAttachments, setPrompt]
  );

  return {
    prompt,
    sessionAttachments,
    inputRef,
    isSubmitting,
    submitError,
    setSubmitError,
    handleSubmit,
    handleInputChange,
    handleInputValueChange,
    handleKeyDown,
    restorePrompt,
  };
}
