import {
  allowedMemoryActions,
  canReviseMemory,
  type MemoryDto,
} from "@open-inspect/shared/types/memories";
import { partitionScope } from "./partition";
import type { MemoryRecord } from "./types";

/**
 * Project a record for the management UI. Capabilities combine the shared lifecycle table with
 * the caller's authority, so the UI never infers permissions from status alone.
 */
export function toMemoryDto(
  record: MemoryRecord,
  canManage: boolean,
  replacementMemoryIds: readonly string[]
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
    replacementMemoryIds: [...replacementMemoryIds],
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
