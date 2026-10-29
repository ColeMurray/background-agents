import type {
  SessionInboxPage,
  SessionInboxSnapshot,
} from "@open-inspect/shared/types/session-inbox";

export function item(id: string) {
  return {
    rootSession: {
      id,
      title: id,
      repoOwner: null,
      repoName: null,
      baseBranch: null,
      status: "active" as const,
      parentSessionId: null,
      spawnSource: "user" as const,
      environmentId: null,
      createdAt: 1,
      updatedAt: 2,
      readState: { latestMessageId: null, version: 0, unread: false as const },
    },
    descendantSessions: [],
  };
}

export function page(ids: string[], nextCursor: string | null = null): SessionInboxPage {
  const items = ids.map(item);
  return nextCursor === null
    ? { items, hasMore: false, nextCursor: null }
    : { items, hasMore: true, nextCursor };
}

export function snapshot(
  overrides: Partial<SessionInboxSnapshot["categories"]> = {}
): SessionInboxSnapshot {
  return {
    categories: {
      needs_attention: page(["attention"]),
      in_progress: page(["running"]),
      finished: page(["finished"]),
      ...overrides,
    },
  };
}
