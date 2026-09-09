"use client";

import { createContext, useContext } from "react";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";

const SessionSnapshotContext = createContext<SessionSnapshot | null>(null);

export function SessionSnapshotProvider({
  snapshot,
  children,
}: {
  snapshot: SessionSnapshot;
  children: React.ReactNode;
}) {
  return (
    <SessionSnapshotContext.Provider value={snapshot}>{children}</SessionSnapshotContext.Provider>
  );
}

export function useSessionSnapshot(): SessionSnapshot {
  const snapshot = useContext(SessionSnapshotContext);
  if (!snapshot) throw new Error("Session snapshot provider is missing");
  return snapshot;
}
