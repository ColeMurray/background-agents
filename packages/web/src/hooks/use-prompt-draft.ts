"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthSession } from "@/lib/auth-session";
import {
  parseStoredPromptRequest,
  promptDraftRequestStorageKey,
  promptDraftStorageKey,
  readStoredValue,
  writeStoredValue,
} from "@/lib/prompt-drafts";
import type { PromptRequestIdentity } from "@/lib/prompt-request-id";

/**
 * Prompt text that survives page reloads, scoped to the signed-in user. The
 * draft starts empty so server and client render the same markup, then adopts
 * the stored draft once the user is known. Setting an empty prompt removes the
 * stored draft.
 *
 * The draft also remembers the identity of a send that has not been confirmed,
 * so a retry after reload reuses its idempotency key. Any prompt change clears it.
 */
export function usePromptDraft(draftId: string) {
  const { data: authSession } = useAuthSession();
  const userId = authSession?.user?.id;
  const storageKey = userId ? promptDraftStorageKey(userId, draftId) : null;
  const [prompt, setPromptState] = useState("");
  const promptRef = useRef(prompt);
  const pendingRequestRef = useRef<PromptRequestIdentity | null>(null);

  useEffect(() => {
    if (!storageKey) return;
    const stored = readStoredValue(storageKey);
    if (stored !== null) {
      promptRef.current = stored;
      setPromptState(stored);
      pendingRequestRef.current = parseStoredPromptRequest(
        readStoredValue(promptDraftRequestStorageKey(storageKey))
      );
    } else if (promptRef.current) {
      // Keep text typed before the user was known instead of discarding it.
      writeStoredValue(storageKey, promptRef.current);
    }
  }, [storageKey]);

  const setPendingRequest = useCallback(
    (identity: PromptRequestIdentity | null) => {
      pendingRequestRef.current = identity;
      if (storageKey) {
        writeStoredValue(
          promptDraftRequestStorageKey(storageKey),
          identity ? JSON.stringify(identity) : null
        );
      }
    },
    [storageKey]
  );

  const setPrompt = useCallback(
    (value: string) => {
      promptRef.current = value;
      setPromptState(value);
      setPendingRequest(null);
      if (storageKey) writeStoredValue(storageKey, value || null);
    },
    [setPendingRequest, storageKey]
  );

  return { prompt, promptRef, setPrompt, pendingRequestRef, setPendingRequest };
}
