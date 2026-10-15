export interface SessionTitleUpdateOptions {
  onlyIfUnset?: boolean;
}

type SessionTitleUpdateErrorReason = "invalid" | "not_found" | "already_set";

export type SessionTitleValidationResult =
  | { ok: true; title: string }
  | { ok: false; reason: "invalid"; error: string };

export type SessionTitleUpdateResult =
  | { ok: true; title: string }
  | { ok: false; reason: SessionTitleUpdateErrorReason; error: string };

export function normalizeSessionTitle(title: unknown): SessionTitleValidationResult {
  if (typeof title !== "string") {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be a non-empty string",
    };
  }

  const trimmed = title.trim();
  if (!trimmed) {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be a non-empty string",
    };
  }

  if (trimmed.length > 200) {
    return {
      ok: false,
      reason: "invalid",
      error: "title must be 200 characters or fewer",
    };
  }

  return { ok: true, title: trimmed };
}

/** Longest fallback title derived from a prompt when the harness suggests none. */
export const FALLBACK_SESSION_TITLE_MAX_LENGTH = 80;

/**
 * Derive a session title from the first prompt's text: first non-empty line,
 * whitespace collapsed, truncated on a word boundary where one exists.
 * Returns null when the prompt has no usable text.
 */
export function deriveFallbackSessionTitle(content: string): string | null {
  const line = content
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  if (line.length <= FALLBACK_SESSION_TITLE_MAX_LENGTH) return line;
  const cut = line.slice(0, FALLBACK_SESSION_TITLE_MAX_LENGTH);
  const boundary = cut.lastIndexOf(" ");
  const head = boundary > FALLBACK_SESSION_TITLE_MAX_LENGTH / 2 ? cut.slice(0, boundary) : cut;
  return `${head.trimEnd()}…`;
}
