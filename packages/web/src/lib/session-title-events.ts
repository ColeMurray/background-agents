type SessionTitleListener = (sessionId: string, title: string | null) => void;

const listeners = new Set<SessionTitleListener>();

/** Keeps mounted views with retained rows in sync with confirmed renames. */
export function subscribeSessionTitleChanges(listener: SessionTitleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSessionTitle(sessionId: string, title: string | null): void {
  for (const listener of listeners) listener(sessionId, title);
}
