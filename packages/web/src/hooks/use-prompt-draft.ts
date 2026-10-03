"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthSession } from "@/lib/auth-session";
import {
  promptDraftStorageKey,
  readStoredPromptDraft,
  writeStoredPromptDraft,
} from "@/lib/prompt-drafts";
import type { PromptRequestIdentity } from "@/lib/prompt-request-id";

/**
 * Prompt text that survives page reloads, scoped to the signed-in user and
 * kept in tab-scoped sessionStorage so drafts end with the tab. The
 * draft starts empty so server and client render the same markup, then adopts
 * the stored draft once the user is known. Setting an empty prompt removes the
 * stored draft.
 *
 * The draft also remembers the identity of a send that has not been confirmed,
 * in the same stored record, so a retry after reload reuses its idempotency
 * key. Any prompt change clears it.
 */
export function usePromptDraft(draftId: string) {
  const { data: authSession } = useAuthSession();
  const userId = authSession?.user?.id;
  const storageKey = userId ? promptDraftStorageKey(userId, draftId) : null;
  const [prompt, setPromptState] = useState("");
  const promptRef = useRef(prompt);
  const pendingRequestRef = useRef<PromptRequestIdentity | null>(null);
  const previousOwnerRef = useRef({ userId, draftId });

  useEffect(() => {
    const previous = previousOwnerRef.current;
    previousOwnerRef.current = { userId, draftId };
    if (previous.draftId !== draftId || (previous.userId && previous.userId !== userId)) {
      // A different draft or account must not inherit the previous one's text.
      promptRef.current = "";
      setPromptState("");
      pendingRequestRef.current = null;
    }
    if (!storageKey) return;
    const stored = readStoredPromptDraft(storageKey);
    if (stored) {
      promptRef.current = stored.prompt;
      setPromptState(stored.prompt);
      pendingRequestRef.current = stored.pendingRequest;
    } else if (promptRef.current) {
      // Keep text typed before the user was known instead of discarding it.
      writeStoredPromptDraft(storageKey, { prompt: promptRef.current, pendingRequest: null });
    }
  }, [draftId, storageKey, userId]);

  const setPendingRequest = useCallback(
    (identity: PromptRequestIdentity | null) => {
      pendingRequestRef.current = identity;
      if (storageKey) {
        writeStoredPromptDraft(storageKey, {
          prompt: promptRef.current,
          pendingRequest: identity,
        });
      }
    },
    [storageKey]
  );

  const setPrompt = useCallback(
    (value: string) => {
      promptRef.current = value;
      setPromptState(value);
      pendingRequestRef.current = null;
      if (storageKey) writeStoredPromptDraft(storageKey, { prompt: value, pendingRequest: null });
    },
    [storageKey]
  );

  /**
   * Clears a sent prompt without erasing a newer draft: a send can finish after
   * this composer unmounts and a fresh one has stored different text.
   */
  const clearSubmittedPrompt = useCallback(
    (submitted: string) => {
      if (promptRef.current === submitted) {
        promptRef.current = "";
        setPromptState("");
        pendingRequestRef.current = null;
      }
      if (storageKey && readStoredPromptDraft(storageKey)?.prompt === submitted) {
        writeStoredPromptDraft(storageKey, null);
      }
    },
    [storageKey]
  );

  return {
    prompt,
    promptRef,
    setPrompt,
    clearSubmittedPrompt,
    pendingRequestRef,
    setPendingRequest,
  };
}
