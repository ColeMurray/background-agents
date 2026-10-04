import {
  allowedMemoryActions,
  canReviseMemory,
  type MemoryDto,
  type MemorySelectionSummary,
  type SessionMemorySelectionStatus,
} from "@open-inspect/shared/types/memories";
import { partitionScope } from "./partition";
import type { MemoryRecord, PinnedItemDrift, SessionMemorySelection } from "./types";

/**
 * Project a record for the management UI. Capabilities combine the shared lifecycle table with
 * the caller's authority, so the UI never infers permissions from status alone.
 */
export function toMemoryDto(
  record: MemoryRecord,
  canManage: boolean,
  supersededByMemoryIds: readonly string[]
): MemoryDto {
  return {
    id: record.id,
    scope: partitionScope(record.partition),
    memoryType: record.memoryType,
    title: record.title,
    description: record.description,
    content: record.content,
    status: record.status,
    archiveKind: record.archiveKind,
    archiveNote: record.archiveNote,
    currentRevisionId: record.currentRevisionId,
    revisionNumber: record.revisionNumber,
    authorKind: record.authorKind,
    authorUserId: record.authorUserId,
    authorSessionId: record.authorSessionId,
    supersedesMemoryId: record.supersedesMemoryId,
    supersededByMemoryIds: [...supersededByMemoryIds],
    approvedAt: record.approvedAt,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    capabilities: {
      canEdit: canManage && canReviseMemory(record),
      actions: canManage ? allowedMemoryActions(record) : [],
    },
  };
}

/** A selection as people see it: items and sizes, without the owner, hash, or timestamps. */
export function toSelectionSummary(manifest: SessionMemorySelection): MemorySelectionSummary {
  return {
    includePersonalMemories: manifest.includePersonalMemories,
    directiveChars: manifest.directiveChars,
    catalogChars: manifest.catalogChars,
    estimatedTokens: manifest.estimatedTokens,
    omittedCount: manifest.omittedCount,
    items: manifest.items.map((item) => ({
      memoryId: item.memoryId,
      revisionNumber: item.revisionNumber,
      scope: item.scope,
      memoryType: item.memoryType,
      title: item.title,
      inclusion: item.inclusion,
      estimatedTokens: item.estimatedTokens,
    })),
  };
}

/** A live session's selection summary with each item's drift since it was pinned. */
export function toSelectionStatus(
  manifest: SessionMemorySelection,
  drift: readonly PinnedItemDrift[]
): SessionMemorySelectionStatus {
  const summary = toSelectionSummary(manifest);
  return { ...summary, items: summary.items.map((item, index) => ({ ...item, ...drift[index] })) };
}
