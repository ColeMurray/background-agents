import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  MEMORY_LIST_PAGE_SIZE,
  memoryScopeDisplayKey,
  type MemoryDto,
  type MemoryScope,
  type MemoryStatus,
} from "@open-inspect/shared/types/memories";
import { useMemories, useMemory } from "@/hooks/use-memories";

/** One status tab of a scope's records, paged, with any deep-linked record kept visible. */
export function useMemoryCollection(scope: MemoryScope) {
  const focusedId = useSearchParams().get("memoryId");
  const focused = useMemory(focusedId);
  const [selectedStatus, setSelectedStatus] = useState<MemoryStatus | null>(null);
  const status = selectedStatus ?? focused.memory?.status ?? "active";
  const [offset, setOffset] = useState(0);
  const page = useMemories(scope, status, offset);

  // Deep links remain visible even when their record is outside the current page.
  const focusedRecord = focused.memory;
  const records: MemoryDto[] =
    focusedRecord &&
    focusedRecord.status === status &&
    memoryScopeDisplayKey(focusedRecord.scope) === memoryScopeDisplayKey(scope) &&
    !page.memories.some((record) => record.id === focusedRecord.id)
      ? [focusedRecord, ...page.memories]
      : page.memories;

  return {
    focusedId,
    status,
    setStatus(next: MemoryStatus) {
      setSelectedStatus(next);
      setOffset(0);
    },
    records,
    canCreate: page.canCreate,
    loading: page.loading,
    error: page.error,
    hasPreviousPage: offset > 0,
    hasNextPage: page.nextOffset !== null,
    previousPage() {
      setOffset((current) => Math.max(0, current - MEMORY_LIST_PAGE_SIZE));
    },
    nextPage() {
      if (page.nextOffset !== null) setOffset(page.nextOffset);
    },
    /** Refresh the page and any deep-linked record after a mutation. */
    async refresh() {
      await Promise.all([page.mutate(), focused.mutate()]);
    },
  };
}
