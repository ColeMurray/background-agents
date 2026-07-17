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
        id="session-changes-layout"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="session-main" defaultSize={changes ? "58%" : "100%"} minSize="30%">
          {workspace}
        </Panel>
        {changes && (
          <>
            <PanelResizeHandle className="w-1.5 cursor-col-resize border-x border-border-muted bg-muted/40 transition-colors hover:bg-accent" />
            <Panel id="session-changes" defaultSize="42%" minSize="520px" maxSize="70%">
              {changes}
            </Panel>
          </>
        )}
      </PanelGroup>
      {!changes && sidebar}
    </>
  );
}
