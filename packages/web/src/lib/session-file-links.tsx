"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { resolveDiffFileLink } from "./diff-file-links";
import type { DiffSelection } from "./session-diffs";

interface SessionFileLinks {
  resolve(href: string | undefined): DiffSelection | null;
  open(selection: DiffSelection): void;
}

const SessionFileLinksContext = createContext<SessionFileLinks | null>(null);

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
  // The value is keyed on the revision rather than on manifest identity: SWR revalidation
  // hands back a new object for the same revision, and a new context value would
  // re-render every visible markdown row in the timeline.
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;
  const revisionId = manifest?.revisionId ?? null;

  const value = useMemo<SessionFileLinks>(
    () => ({
      resolve: (href) =>
        manifestRef.current ? resolveDiffFileLink(manifestRef.current, href) : null,
      open: onOpen,
    }),
    // revisionId is the cache key for manifestRef.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revisionId, onOpen]
  );

  return (
    <SessionFileLinksContext.Provider value={value}>{children}</SessionFileLinksContext.Provider>
  );
}

/** Null outside a session page, where markdown links keep their plain behavior. */
export function useSessionFileLinks(): SessionFileLinks | null {
  return useContext(SessionFileLinksContext);
}
