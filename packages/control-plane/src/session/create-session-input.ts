import { createSessionInputSchema, type CreateSessionInput } from "@open-inspect/shared";

export type { CreateSessionInput };

export const NO_REPOSITORY_SESSIONS_AUTOMATION_ONLY_ERROR =
  "No-repository sessions can only be created by automations";

export type CreateSessionInputParseResult =
  | { ok: true; input: CreateSessionInput }
  | { ok: false; message: string };

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function parseCreateSessionInput(
  request: Request
): Promise<CreateSessionInputParseResult> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, message: "Invalid JSON body" };
  }

  if (!isObjectBody(parsed)) {
    return { ok: false, message: "JSON body must be an object" };
  }

  const repoOwnerMissing = parsed.repoOwner == null || parsed.repoOwner === "";
  const repoNameMissing = parsed.repoName == null || parsed.repoName === "";
  if (repoOwnerMissing && repoNameMissing) {
    return { ok: false, message: NO_REPOSITORY_SESSIONS_AUTOMATION_ONLY_ERROR };
  }

  const result = createSessionInputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: "Invalid session request body" };
  }

  return { ok: true, input: result.data };
}
