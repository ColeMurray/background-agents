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

/**
 * One status tab of a scope's records, paged and optionally filtered by search text, with any
 * deep-linked record kept visible.
 */
export function useMemoryCollection(scope: MemoryScope, search: string = "") {
  const focusedId = useSearchParams().get("memoryId");
  const focused = useMemory(focusedId);
  const [selectedStatus, setSelectedStatus] = useState<MemoryStatus | null>(null);
  const status = selectedStatus ?? focused.memory?.status ?? "active";
  // Any change of search starts again at page one, including clearing it (an offset reached
  // before the search must not come back). State is adjusted during render, not in an effect.
  const [paging, setPaging] = useState({ search, offset: 0 });
  if (paging.search !== search) setPaging({ search, offset: 0 });
  const offset = paging.search === search ? paging.offset : 0;
  const setOffset = (next: number | ((current: number) => number)) =>
    setPaging((current) => ({
      search,
      offset:
        typeof next === "function" ? next(current.search === search ? current.offset : 0) : next,
    }));
  const page = useMemories(scope, status, offset, search);

  // Deep links remain visible even when their record is outside the current page, unless a
  // search is narrowing the list (the linked record may not match it).
  const focusedRecord = focused.memory;
  const records: MemoryDto[] =
    focusedRecord &&
    !search &&
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
