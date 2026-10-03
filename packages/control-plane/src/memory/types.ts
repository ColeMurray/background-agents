import type { HarnessId } from "@open-inspect/shared/harnesses";
import type {
  MemoryArchiveKind,
  MemoryAuthorKind,
  MemoryContent,
  MemoryScope,
  MemoryStatus,
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
      /** Only private, collaborator-free root sessions may save personal facts without review. */
      personalAutoSave: boolean;
    };

/**
 * The scopes a session draws memory from, in priority order (environment, repositories,
 * personal). `personalOwnerUserId` is null when personal memory is excluded.
 */
export interface MemoryTarget {
  personalOwnerUserId: string | null;
  repositories: readonly { repoOwner: string; repoName: string; repoId: number | null }[];
  environmentId: string | null;
}

/** Everything sandbox memory requests need to know about their authenticated session. */
export interface SessionMemoryContext extends MemoryTarget {
  sessionId: string;
  sessionUserId: string | null;
  ownerTeamId: string | null;
  harness: HarnessId;
  /** Children consume their parent's pinned selection rather than resolving their own. */
  inherited: boolean;
  personalAutoSave: boolean;
}

/** One pinned revision ready to render: directives in full, facts as a summary. */
export type PinnedMemoryEntry = {
  memoryId: string;
  revisionId: string;
  /** Display scope pinned with the selection. */
  scope: MemoryScope;
  /** Live partition, used to recheck access before installation. */
  partition: MemoryPartition;
  title: string;
} & ({ inclusion: "full"; content: string } | { inclusion: "summary"; description: string });
