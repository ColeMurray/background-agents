export interface SessionTitleRevision {
  sessionId: string;
  title: string | null;
  updatedAt: number;
}

type Listener = (revision: SessionTitleRevision) => void;

const revisions = new Map<string, SessionTitleRevision>();
const listeners = new Set<Listener>();

/** Keep the newest title committed by the session Durable Object. */
export function reconcileSessionTitleRevision(
  candidate: SessionTitleRevision
): SessionTitleRevision {
  const current = revisions.get(candidate.sessionId);
  if (current && current.updatedAt >= candidate.updatedAt) return current;

  revisions.set(candidate.sessionId, candidate);
  listeners.forEach((listener) => listener(candidate));
  return candidate;
}

export function getSessionTitleRevision(sessionId: string): SessionTitleRevision | undefined {
  return revisions.get(sessionId);
}

export function subscribeSessionTitleReconciliation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applySessionTitleRevision<
  T extends { id: string; title: string | null; updatedAt: number },
>(session: T): T {
  const revision = revisions.get(session.id);
  if (!revision || session.updatedAt > revision.updatedAt) {
    revisions.set(session.id, {
      sessionId: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
    });
    return session;
  }
  if (revision.updatedAt === session.updatedAt) return session;
  return { ...session, title: revision.title, updatedAt: revision.updatedAt };
}

export function clearSessionTitleRevisions(): void {
  revisions.clear();
}
