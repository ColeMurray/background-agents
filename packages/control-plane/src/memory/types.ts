import type { HarnessId } from "@open-inspect/shared/harnesses";
import type {
  MemoryArchiveKind,
  MemoryAuthorKind,
  MemoryContent,
  MemoryInclusion,
  MemoryScope,
  MemoryStatus,
  MemoryType,
} from "@open-inspect/shared/types/memories";
import type { MemoryPartition } from "./partition";

/** A live record with its current revision; server-only (the web receives `MemoryDto`). */
export interface MemoryRecord extends MemoryContent {
  id: string;
  partition: MemoryPartition;
  status: MemoryStatus;
  archiveKind: MemoryArchiveKind | null;
  archiveNote: string | null;
  currentRevisionId: string;
  revisionNumber: number;
  /** The original creator; later editors are recorded on their revisions. */
  authorKind: MemoryAuthorKind;
  authorUserId: string | null;
  authorSessionId: string | null;
  supersedesMemoryId: string | null;
  approvedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** A selection candidate: directives carry their body, facts only their catalog summary. */
export type MemoryCandidate = Omit<MemoryRecord, "memoryType" | "content"> &
  ({ memoryType: "directive"; content: string } | { memoryType: "fact"; content: null });

/** Server-derived provenance; never populate identity or auto-save eligibility from tool arguments. */
export type MemoryActor =
  | { kind: "user"; userId: string; requestId: string }
  | {
      kind: "agent";
      userId: string | null;
      sessionId: string;
      requestId: string;
    };

/**
 * Where a session draws memory from: its environment, its repositories in session order, and the
 * pinned personal owner (null when personal memory is excluded). Priority follows that order.
 */
export interface MemorySources {
  personalOwnerUserId: string | null;
  repositories: readonly { repoOwner: string; repoName: string; repoId: number | null }[];
  environmentId: string | null;
}

/** Who a session acts for: its owning team, or (for workspace sessions) its owner. */
export interface SessionPrincipal {
  userId: string | null;
  ownerTeamId: string | null;
}

/** A session as memory operations see it: who it acts for and which memory it reaches. */
export interface MemorySession {
  id: string;
  /** Who shared-partition access is evaluated for (owning team, or the workspace owner). */
  principal: SessionPrincipal;
  /** Where this session draws memory from. */
  sources: MemorySources;
  /** Rendering format for this session's boot context. */
  harness: HarnessId;
  /** Agent-spawned children consume their parent's pinned selection rather than their own. */
  isChildSession: boolean;
  /**
   * Whether personal facts written by this session may skip review. Only private,
   * collaborator-free root sessions are eligible; the store rechecks at commit time.
   */
  personalAutoSaveEligible: boolean;
}

/** One pinned revision ready to render: directives in full, facts as a summary. */
export type PinnedMemoryEntry = {
  memoryId: string;
  revisionId: string;
  /** Display scope pinned with the selection. */
  scope: MemoryScope;
  /** Live partition, used to recheck access before rendering boot context. */
  partition: MemoryPartition;
  title: string;
} & ({ inclusion: "full"; content: string } | { inclusion: "summary"; description: string });

/** One selected revision; omitted records are counted, never persisted as items. */
export interface SessionMemoryItem {
  memoryId: string;
  revisionId: string;
  revisionNumber: number;
  /** Display scope pinned with the selection. */
  scope: MemoryScope;
  memoryType: MemoryType;
  title: string;
  inclusion: MemoryInclusion;
  estimatedTokens: number;
}

/**
 * The selection pinned for a session's lifetime, inherited by children and reused on restore.
 * Server-only: it carries the personal owner and selection hash, so people are shown a
 * `MemorySelectionSummary` instead. Token estimates include rendering overhead.
 */
export interface SessionMemorySelection {
  selectionVersion: number;
  manifestSha256: string;
  resolvedAt: number;
  includePersonalMemories: boolean;
  personalOwnerUserId: string | null;
  directiveChars: number;
  catalogChars: number;
  estimatedTokens: number;
  omittedCount: number;
  items: SessionMemoryItem[];
}

/** How a pinned item's record has changed since the selection was made. */
export interface PinnedItemDrift {
  revisedSinceSelection: boolean;
  archivedSinceSelection: boolean;
}
