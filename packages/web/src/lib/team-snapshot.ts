import type { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";

export class TeamRequestError extends Error {
  constructor(
    message: string,
    readonly disposition: "transient" | "authoritative-denial" | "invalid-payload" | "request-error"
  ) {
    super(message);
    this.name = "TeamRequestError";
  }
}

export type TeamSnapshot<T> =
  | { kind: "ready"; value: T }
  | { kind: "denied"; error: TeamRequestError };

export function teamSnapshot<T>(value: T): TeamSnapshot<T> {
  return { kind: "ready", value };
}

export function isRetryableTeamError(error: unknown): boolean {
  return error instanceof TeamRequestError && error.disposition === "transient";
}

/** Cache authoritative answers as data; transport failures leave the last answer intact. */
export async function fetchTeamSnapshot<T>(
  path: BrowserApiPath,
  schema: z.ZodType<T>
): Promise<TeamSnapshot<T>> {
  let response: Response;
  try {
    response = await browserApiFetch(path);
  } catch (cause) {
    throw new TeamRequestError(`Failed to load teams (${String(cause)})`, "transient");
  }
  if (!response.ok) {
    const disposition = [401, 403, 404].includes(response.status)
      ? "authoritative-denial"
      : response.status >= 500 || response.status === 408 || response.status === 429
        ? "transient"
        : "request-error";
    const error = new TeamRequestError(`Failed to load teams (${response.status})`, disposition);
    if (disposition === "authoritative-denial") return { kind: "denied", error };
    throw error;
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new TeamRequestError(`Failed to read team response (${String(cause)})`, "transient");
  }
  try {
    return teamSnapshot(schema.parse(JSON.parse(body)));
  } catch {
    return {
      kind: "denied",
      error: new TeamRequestError("Invalid team response", "invalid-payload"),
    };
  }
}
