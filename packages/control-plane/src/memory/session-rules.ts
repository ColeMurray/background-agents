import type { MemoryPromptContext, MemorySession } from "./types";

/** Treated as someone else's prompt: no personal reads, writes, or auto-save. */
export const UNATTRIBUTED_PROMPT: MemoryPromptContext = {
  authorUserId: null,
  othersPrompted: true,
};

const PERSONAL_EXCLUDED = "Personal memory is excluded from this session";
const PERSONAL_OWNER_PROMPTS_ONLY =
  "Personal memory is available only on the session owner's own prompts";
const PERSONAL_OTHERS_PROMPTED =
  "Personal memory search is off in this session because someone else has prompted it";

/** Whether the active prompt is the personal owner's own. */
function isOwnerPrompt(session: MemorySession, prompt: MemoryPromptContext): boolean {
  const owner = session.sources.personalOwnerUserId;
  return owner !== null && prompt.authorUserId === owner;
}

/**
 * How much of the personal store the active prompt may read live. Only the personal owner's own
 * prompts read it, and none do once someone else has prompted the session (or a session that
 * spawned it): that prompt can leave something running in the sandbox that reads on the owner's
 * later prompts. Children see only personal records pinned in the selection they inherited, so a
 * later preference or new personal record never widens a delegated session's context.
 */
export function personalReadAccess(
  session: MemorySession,
  prompt: MemoryPromptContext
): "none" | "pinned" | "all" {
  if (!isOwnerPrompt(session, prompt) || prompt.othersPrompted) return "none";
  return session.isChildSession ? "pinned" : "all";
}

/** Why the active prompt cannot read personal memory; meaningful when access is `"none"`. */
export function personalReadDenial(session: MemorySession, prompt: MemoryPromptContext): string {
  if (!session.sources.personalOwnerUserId) return PERSONAL_EXCLUDED;
  if (!isOwnerPrompt(session, prompt)) return PERSONAL_OWNER_PROMPTS_ONLY;
  return PERSONAL_OTHERS_PROMPTED;
}

/**
 * Only the personal owner's own prompts, in a session they own, may write to their personal store.
 * Returns why not, or null when the write may proceed.
 */
export function personalWriteDenial(
  session: MemorySession,
  prompt: MemoryPromptContext
): string | null {
  if (!session.sources.personalOwnerUserId) return PERSONAL_EXCLUDED;
  if (!isOwnerPrompt(session, prompt)) return PERSONAL_OWNER_PROMPTS_ONLY;
  // A collaborator-owned legacy child consumes inherited context but cannot mutate the original
  // owner's personal store.
  if (session.principal.userId !== session.sources.personalOwnerUserId)
    return "Personal memory owner differs from this session owner";
  return null;
}
