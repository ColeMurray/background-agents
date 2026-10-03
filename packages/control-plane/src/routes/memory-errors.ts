import { error } from "../http/responses";
import { MemoryError } from "../memory/errors";

/** Translate expected memory failures to HTTP responses while preserving unexpected errors. */
export function memoryErrorResponse(cause: unknown): Response {
  if (cause instanceof MemoryError) return error(cause.message, cause.status);
  throw cause;
}

/** The revision a mutation was reviewed against, from `If-Match` (quoted or bare). */
export function expectedRevision(request: Request): string | Response {
  const revision = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  return revision ? revision : error("If-Match revision is required", 428);
}
