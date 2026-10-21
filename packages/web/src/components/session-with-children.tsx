"use client";

import { Fragment } from "react";
import { SessionListItem, ChildSessionListItem } from "@/components/session-list-item";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";

/** Unread sessions anywhere in the tree rendered below the root. */
function countUnreadDescendants(rootId: string, childrenMap: Map<string, SessionItem[]>): number {
  let count = 0;
  const visitedIds = new Set([rootId]);
  const pendingIds = [rootId];
  for (let parentId = pendingIds.pop(); parentId; parentId = pendingIds.pop()) {
    for (const child of childrenMap.get(parentId) ?? []) {
      if (visitedIds.has(child.id)) continue;
      visitedIds.add(child.id);
      pendingIds.push(child.id);
      if (child.readState.unread) count += 1;
    }
  }
  return count;
}

export function SessionWithChildren({
  session,
  environmentName,
  childrenMap,
  currentSessionId,
  isMobile,
  onArchive,
  onSessionSelect,
  onMarkLatestMessageRead,
  onMarkHierarchyRead,
}: {
  session: SessionItem;
  environmentName?: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
  onMarkHierarchyRead: (rootSessionId: string) => Promise<void>;
}) {
  return (
    <>
      <SessionListItem
        session={session}
        environmentName={environmentName}
        isActive={session.id === currentSessionId}
        isMobile={isMobile}
        unreadDescendantCount={countUnreadDescendants(session.id, childrenMap)}
        onArchive={onArchive}
        onSessionSelect={onSessionSelect}
        onMarkLatestMessageRead={onMarkLatestMessageRead}
        onMarkHierarchyRead={onMarkHierarchyRead}
      />
      <ChildSessionTree
        parentId={session.id}
        childrenMap={childrenMap}
        currentSessionId={currentSessionId}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
        onMarkLatestMessageRead={onMarkLatestMessageRead}
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
  onMarkLatestMessageRead,
  visitedIds,
  depth = 1,
}: {
  parentId: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  onMarkLatestMessageRead: (sessionId: string) => Promise<void>;
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
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          depth={depth}
        />
        <ChildSessionTree
          parentId={child.id}
          childrenMap={childrenMap}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          onMarkLatestMessageRead={onMarkLatestMessageRead}
          visitedIds={nextVisitedIds}
          depth={depth + 1}
        />
      </Fragment>
    );
  });
}
