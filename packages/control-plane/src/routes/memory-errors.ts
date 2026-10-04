import type { MemoryAccessDenial } from "../authorization/memory-access";
import { error, json } from "../http/responses";
import { MemoryError, type MemoryErrorKind } from "../memory/errors";

const ERROR_STATUS: Record<MemoryErrorKind, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

/** Translate expected memory failures to HTTP responses while preserving unexpected errors. */
export function memoryErrorResponse(cause: unknown): Response {
  if (cause instanceof MemoryError) return error(cause.message, ERROR_STATUS[cause.kind]);
  throw cause;
}

const DENIAL_STATUS: Record<MemoryAccessDenial["reason"], number> = {
  not_found: 404,
  forbidden: 403,
};

/** The HTTP form of a memory access denial. */
export function memoryDenialResponse(denial: MemoryAccessDenial): Response {
  return json(
    {
      error: denial.message,
      code: denial.code,
      reason_code: denial.reasonCode,
      repository: denial.repository,
    },
    DENIAL_STATUS[denial.reason]
  );
}

/** The revision a mutation was reviewed against, from `If-Match` (quoted or bare). */
export function expectedRevision(request: Request): string | Response {
  const revision = request.headers.get("If-Match")?.replace(/^"|"$/g, "");
  return revision ? revision : error("If-Match revision is required", 428);
}
