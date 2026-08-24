import type { SessionRow } from "./types";

/**
 * The session's externally visible identifier.
 *
 * A session is addressed publicly by its `session_name` when it has one, and by
 * the internal row id otherwise. Before `init` writes a row there is nothing to
 * read, so the Durable Object's own id is the last resort — callers pass it as a
 * plain string, which keeps this resolution independent of the Workers runtime.
 */
export function resolvePublicSessionId(
  session: SessionRow | null | undefined,
  durableObjectId: string
): string {
  return session?.session_name || session?.id || durableObjectId;
}
