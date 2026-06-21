export interface SessionTitleUpdateOptions {
  onlyIfUnset?: boolean;
}

export type SessionTitleUpdateErrorReason = "invalid" | "not_found" | "already_set";

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
