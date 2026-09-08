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

/**
 * A per-use resolver over the live session row that latches once a row exists.
 *
 * Components built during the init request — before the row is written — must
 * re-read until the public id resolves. Afterwards the id is immutable
 * (`session_name` is only ever written by the init-time insert and the row id
 * never changes), so further reads are pure waste on hot paths like per-log-
 * line context derivation. The latch never captures the Durable Object id
 * fallback, only a row-backed id.
 */
export function createLatchedPublicSessionIdResolver(
  getSession: () => SessionRow | null,
  durableObjectId: string
): () => string {
  let latched: string | undefined;
  return () => {
    if (latched !== undefined) return latched;
    const session = getSession();
    const resolved = resolvePublicSessionId(session, durableObjectId);
    if (session) latched = resolved;
    return resolved;
  };
}
