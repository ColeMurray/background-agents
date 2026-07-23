"use client";

import type { ReactNode } from "react";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  type Layout,
} from "react-resizable-panels";

interface SessionDesktopLayoutProps {
  workspace: ReactNode;
  sidebar: ReactNode;
  changes: ReactNode | null;
  defaultLayout?: Layout;
  onLayoutChanged?: (layout: Layout) => void;
}

export const SESSION_CHANGES_LAYOUT_ID = "session-changes-layout-v2";

/** Keeps the timeline/terminal subtree stable while swapping the right-side surface. */
export function SessionDesktopLayout({
  workspace,
  sidebar,
  changes,
  defaultLayout,
  onLayoutChanged,
}: SessionDesktopLayoutProps) {
  return (
    <>
      <PanelGroup
        orientation="horizontal"
        id={SESSION_CHANGES_LAYOUT_ID}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="session-main" defaultSize={changes ? "45%" : "100%"} minSize="25%">
          {workspace}
        </Panel>
        {changes && (
          <>
            <PanelResizeHandle className="w-1.5 cursor-col-resize border-x border-border-muted bg-muted/40 transition-colors hover:bg-accent" />
            <Panel id="session-changes" defaultSize="55%" minSize="520px" maxSize="75%">
              {changes}
            </Panel>
          </>
        )}
      </PanelGroup>
      {!changes && sidebar}
    </>
  );
}
