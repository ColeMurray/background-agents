"use client";

import { Fragment } from "react";
import { SessionListItem, ChildSessionListItem } from "@/components/session-list-item";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";

export function SessionWithChildren({
  session,
  environmentName,
  childrenMap,
  currentSessionId,
  isMobile,
  onArchive,
  onSessionSelect,
  onSessionRenamed,
  onMarkLatestTerminalOutcomeRead,
}: {
  session: SessionItem;
  environmentName?: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
  onMarkLatestTerminalOutcomeRead: (sessionId: string) => Promise<void>;
}) {
  return (
    <>
      <SessionListItem
        session={session}
        environmentName={environmentName}
        isActive={session.id === currentSessionId}
        isMobile={isMobile}
        onArchive={onArchive}
        onSessionSelect={onSessionSelect}
        onSessionRenamed={onSessionRenamed}
        onMarkLatestTerminalOutcomeRead={onMarkLatestTerminalOutcomeRead}
      />
      <ChildSessionTree
        parentId={session.id}
        childrenMap={childrenMap}
        currentSessionId={currentSessionId}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
        onMarkLatestTerminalOutcomeRead={onMarkLatestTerminalOutcomeRead}
        visitedIds={new Set([session.id])}
      />
    </>
  );
}

function ChildSessionTree({
  parentId,
  childrenMap,
  currentSessionId,
  isMobile,
  onSessionSelect,
  onMarkLatestTerminalOutcomeRead,
  visitedIds,
  depth = 1,
}: {
  parentId: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onMarkLatestTerminalOutcomeRead: (sessionId: string) => Promise<void>;
  visitedIds: Set<string>;
  depth?: number;
}) {
  const childSessions = childrenMap.get(parentId);
  if (!childSessions?.length) return null;

  return childSessions.map((child) => {
    if (visitedIds.has(child.id)) return null;

    const nextVisitedIds = new Set(visitedIds);
    nextVisitedIds.add(child.id);

    return (
      <Fragment key={child.id}>
        <ChildSessionListItem
          session={child}
          isActive={child.id === currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestTerminalOutcomeRead={onMarkLatestTerminalOutcomeRead}
          depth={depth}
        />
        <ChildSessionTree
          parentId={child.id}
          childrenMap={childrenMap}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestTerminalOutcomeRead={onMarkLatestTerminalOutcomeRead}
          visitedIds={nextVisitedIds}
          depth={depth + 1}
        />
      </Fragment>
    );
  });
}
