import { z } from "zod";
import type { PullRequestSummary, SessionReadState, SessionStatus, SpawnSource } from "./sessions";
import type { SessionListRepository } from "./repositories";

/** Viewer-specific session row in session inbox page and snapshot payloads. */
export interface SessionListItem {
  id: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseBranch: string | null;
  status: SessionStatus;
  parentSessionId: string | null;
  spawnSource: SpawnSource;
  environmentId: string | null;
  createdAt: number;
  updatedAt: number;
  repositories?: SessionListRepository[];
  pullRequestSummary?: PullRequestSummary;
  readState: SessionReadState;
}

export const sessionInboxCategorySchema = z.enum(["needs_attention", "in_progress", "finished"]);
export type SessionInboxCategory = z.infer<typeof sessionInboxCategorySchema>;

export interface SessionInboxItem {
  rootSession: SessionListItem;
  descendantSessions: SessionListItem[];
}

export interface SessionInboxPage {
  items: SessionInboxItem[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionInboxSnapshot {
  categories: Record<SessionInboxCategory, SessionInboxPage>;
}
