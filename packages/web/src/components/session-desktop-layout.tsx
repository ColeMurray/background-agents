"use client";

import type { ReactNode } from "react";

interface SessionDesktopLayoutProps {
  workspace: ReactNode;
  sidebar: ReactNode;
  changes: ReactNode | null;
}

/**
 * An open diff takes over the main column beside the details sidebar. The
 * timeline/terminal subtree stays mounted underneath, so scroll position and the
 * composer draft survive opening and closing it.
 */
export function SessionDesktopLayout({ workspace, sidebar, changes }: SessionDesktopLayoutProps) {
  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-clip">
        <div hidden={Boolean(changes)} className="h-full min-h-0 min-w-0 flex-1 overflow-clip">
          {workspace}
        </div>
        {changes && <div className="h-full min-h-0 min-w-0 flex-1">{changes}</div>}
      </div>
      {sidebar}
    </>
  );
}
