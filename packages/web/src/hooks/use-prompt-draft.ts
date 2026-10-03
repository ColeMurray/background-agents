"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PROMPT_DRAFT_STORAGE_KEY_PREFIX = "open-inspect-prompt-draft:";

/** Draft ID for the new-session composer, which has no session ID yet. */
export const NEW_SESSION_PROMPT_DRAFT_ID = "new-session";

function promptDraftStorageKey(draftId: string): string {
  return `${PROMPT_DRAFT_STORAGE_KEY_PREFIX}${draftId}`;
}

/**
 * Prompt text that survives page reloads. The draft starts empty so server and
 * client render the same markup, then adopts the stored draft after hydration.
 * Setting an empty prompt removes the stored draft.
 */
export function usePromptDraft(draftId: string) {
  const storageKey = promptDraftStorageKey(draftId);
  const [prompt, setPromptState] = useState("");
  const promptRef = useRef(prompt);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(storageKey);
    } catch {
      // Storage is optional; the composer starts empty when it is unavailable.
    }
    promptRef.current = stored ?? "";
    setPromptState(stored ?? "");
  }, [storageKey]);

  const setPrompt = useCallback(
    (value: string) => {
      promptRef.current = value;
      setPromptState(value);
      try {
        if (value) {
          localStorage.setItem(storageKey, value);
        } else {
          localStorage.removeItem(storageKey);
        }
      } catch {
        // Continue with the in-memory draft when storage is unavailable or full.
      }
    },
    [storageKey]
  );

  return { prompt, promptRef, setPrompt };
}
