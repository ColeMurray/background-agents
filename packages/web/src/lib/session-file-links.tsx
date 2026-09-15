"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { createDiffFileLinkResolver, type DiffFileLinkResolver } from "./diff-file-links";
import type { DiffSelection } from "./session-diffs";

interface SessionFileLinks {
  resolve: DiffFileLinkResolver;
  open(selection: DiffSelection): void;
}

const SessionFileLinksContext = createContext<SessionFileLinks | null>(null);

const resolveNothing: DiffFileLinkResolver = () => null;

/** Lets markdown in the session timeline open changed files in the changes panel. */
export function SessionFileLinksProvider({
  manifest,
  onOpen,
  children,
}: {
  manifest: SessionDiffManifest | null;
  onOpen: (selection: DiffSelection) => void;
  children: ReactNode;
}) {
  // Keep one manifest per revision: SWR revalidation hands back a new object for the same
  // revision, and a new context value would re-render every visible markdown row.
  const [revisionManifest, setRevisionManifest] = useState(manifest);
  if ((manifest?.revisionId ?? null) !== (revisionManifest?.revisionId ?? null)) {
    setRevisionManifest(manifest);
  }

  const resolve = useMemo(
    () => (revisionManifest ? createDiffFileLinkResolver(revisionManifest) : resolveNothing),
    [revisionManifest]
  );
  const value = useMemo<SessionFileLinks>(() => ({ resolve, open: onOpen }), [resolve, onOpen]);

  return (
    <SessionFileLinksContext.Provider value={value}>{children}</SessionFileLinksContext.Provider>
  );
}

/** Null outside a session page, where markdown links keep their plain behavior. */
export function useSessionFileLinks(): SessionFileLinks | null {
  return useContext(SessionFileLinksContext);
}
