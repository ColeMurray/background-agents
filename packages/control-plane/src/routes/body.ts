import type { z } from "zod";
import { error } from "../http/responses";

/** The first issue of a body schema failure, prefixed with its field path when it has one. */
export function bodyIssue(failure: z.ZodError): string {
  const issue = failure.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Read the untrusted request body as JSON, or answer the route's 400.
 *
 * For routes that validate the raw value themselves; `parseBody` is the
 * schema-backed form. Callers must validate the returned value before use.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
}

/**
 * Parse a request's JSON body with `schema`, or answer the route's 400.
 *
 * A body that is not JSON answers `Invalid JSON body`. A schema failure
 * answers `message` when the route names its own wording, otherwise the
 * first issue prefixed with the field it concerns.
 */
export async function parseBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  message?: string
): Promise<z.output<Schema> | Response> {
  const raw = await parseJsonBody(request);
  if (raw instanceof Response) return raw;
  const result = await schema.safeParseAsync(raw);
  if (!result.success) return error(message ?? bodyIssue(result.error), 400);
  return result.data;
}
