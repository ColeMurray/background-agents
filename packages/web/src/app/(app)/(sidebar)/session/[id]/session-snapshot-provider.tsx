"use client";

import { createContext, useContext, useState } from "react";
import { notFound, redirect } from "next/navigation";
import {
  sessionSnapshotSchema,
  type SessionSnapshot,
} from "@open-inspect/shared/types/server-messages";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

const SessionSnapshotContext = createContext<{
  snapshot: SessionSnapshot;
  refresh: () => Promise<void>;
} | null>(null);

class SnapshotRequestError extends Error {
  constructor(readonly status: number) {
    super(`Unable to refresh session (${status})`);
  }
}

export function SessionSnapshotProvider({
  snapshot,
  children,
}: {
  snapshot: SessionSnapshot;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<{
    source: SessionSnapshot;
    current: SessionSnapshot;
    error: unknown;
  }>({ source: snapshot, current: snapshot, error: null });
  if (state.source !== snapshot) setState({ source: snapshot, current: snapshot, error: null });
  const path: BrowserApiPath = `/api/sessions/${encodeURIComponent(snapshot.session.id)}`;

  async function refresh() {
    try {
      const response = await browserApiFetch(path);
      if (!response.ok) throw new SnapshotRequestError(response.status);
      const current = sessionSnapshotSchema.parse(await response.json());
      setState({ source: snapshot, current, error: null });
    } catch (error) {
      setState((current) => ({ ...current, error }));
      throw error;
    }
  }

  if (state.error instanceof SnapshotRequestError) {
    if (state.error.status === 404) notFound();
    if (state.error.status === 401) redirect("/login");
  }
  const current = state.source === snapshot ? state.current : snapshot;
  const value = state.error
    ? { ...current, session: { ...current.session, capabilities: undefined } }
    : current;
  return (
    <SessionSnapshotContext.Provider value={{ snapshot: value, refresh }}>
      {children}
    </SessionSnapshotContext.Provider>
  );
}

export function useSessionSnapshot(): SessionSnapshot {
  const context = useContext(SessionSnapshotContext);
  if (!context) throw new Error("Session snapshot provider is missing");
  return context.snapshot;
}

export function useRefreshSessionSnapshot(): () => Promise<void> {
  const context = useContext(SessionSnapshotContext);
  if (!context) throw new Error("Session snapshot provider is missing");
  return context.refresh;
}
