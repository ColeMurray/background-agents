import type { PromptRequestIdentity } from "@/lib/prompt-request-id";

const PROMPT_DRAFT_STORAGE_KEY_PREFIX = "open-inspect-prompt-draft:";

/** Draft ID for the new-session composer, which has no session ID yet. */
export const NEW_SESSION_PROMPT_DRAFT_ID = "new-session";

export function promptDraftStorageKey(userId: string, draftId: string): string {
  return `${PROMPT_DRAFT_STORAGE_KEY_PREFIX}${userId}:${draftId}`;
}

export function promptDraftRequestStorageKey(draftStorageKey: string): string {
  return `${draftStorageKey}:request`;
}

export function readStoredValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Writes or removes a value; a failed write drops the stale value so it is never restored. */
export function writeStoredValue(key: string, value: string | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, value);
    }
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Storage is unavailable; the draft lives only in memory.
    }
  }
}

export function parseStoredPromptRequest(value: string | null): PromptRequestIdentity | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "signature" in parsed &&
      "clientRequestId" in parsed &&
      typeof parsed.signature === "string" &&
      typeof parsed.clientRequestId === "string"
    ) {
      return { signature: parsed.signature, clientRequestId: parsed.clientRequestId };
    }
  } catch {
    // Ignore malformed values; the next send uses a fresh request ID.
  }
  return null;
}

/** Removes this tab's stored drafts so prompt text does not outlive the signed-in account. */
export function clearStoredPromptDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PROMPT_DRAFT_STORAGE_KEY_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch {
    // Storage is unavailable, so there are no drafts to clear.
  }
}
