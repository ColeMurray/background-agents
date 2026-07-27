import { createSessionInputSchema, type CreateSessionInput } from "@open-inspect/shared";

export type { CreateSessionInput };

export type CreateSessionInputParseResult =
  /**
   * `raw` is the pre-Zod JSON object. The schema is strip-mode, so
   * forbidden-identity-field checks must inspect the raw keys, not `input`.
   */
  | { ok: true; input: CreateSessionInput; raw: Record<string, unknown> }
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

  const result = createSessionInputSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, message: "Invalid session request body" };
  }

  return { ok: true, input: result.data, raw: parsed };
}
