import type { CreateSessionRequest } from "../types";
import type { SessionIdentityFields } from "./identity";

export type CreateSessionInput = CreateSessionRequest &
  SessionIdentityFields & {
    scmToken?: string;
    scmRefreshToken?: string;
    scmTokenExpiresAt?: number;
  };

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

  return { ok: true, input: parsed as unknown as CreateSessionInput };
}
