import {
  memoryScopeToSearchParams,
  type BulkMemoryActionResponse,
  type MemoryAction,
  type MemoryArchiveKind,
  type MemoryAuthorKind,
  type MemoryDto,
  type MemoryInclusion,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from "@open-inspect/shared/types/memories";
import type { SettingsCategory } from "@/components/settings/settings-registry";

export const MEMORY_TYPE_LABELS: Record<
  MemoryType,
  { label: string; plural: string; hint: string }
> = {
  fact: { label: "Fact", plural: "facts", hint: "read when relevant" },
  directive: { label: "Directive", plural: "directives", hint: "always included" },
};

export const MEMORY_INCLUSION_LABELS: Record<MemoryInclusion, string> = {
  full: "included in full",
  summary: "catalog summary",
};

export const MEMORY_STATUS_LABELS: Record<MemoryStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  archived: "Archived",
};

export const MEMORY_ARCHIVE_KIND_LABELS: Record<MemoryArchiveKind, string> = {
  manual: "Archived manually",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const MEMORY_AUTHOR_LABELS: Record<MemoryAuthorKind, string> = {
  user: "User",
  agent: "Agent",
};

export const MEMORY_ACTION_LABELS: Record<MemoryAction, string> = {
  approve: "Approve",
  reject: "Reject",
  archive: "Archive",
  restore: "Restore",
};

const MEMORY_ACTION_PAST_LABELS: Record<MemoryAction, string> = {
  approve: "Approved",
  reject: "Rejected",
  archive: "Archived",
  restore: "Restored",
};

export function memoryCount(count: number): string {
  return `${count} ${count === 1 ? "memory" : "memories"}`;
}

/**
 * Describe a bulk action's outcome: how many records it applied to, and each failure by title with
 * the server's reason. Either part is null when there is nothing to report.
 */
export function bulkActionSummary(
  action: MemoryAction,
  records: readonly Pick<MemoryDto, "id" | "title">[],
  results: BulkMemoryActionResponse["results"]
): { applied: string | null; failed: string | null } {
  const titles = new Map(records.map((record) => [record.id, record.title]));
  const failures = results.flatMap((result) =>
    result.ok ? [] : [`“${titles.get(result.id) ?? result.id}” (${result.error})`]
  );
  const applied = results.length - failures.length;
  return {
    applied: applied
      ? `${MEMORY_ACTION_PAST_LABELS[action]} ${
          failures.length ? `${applied} of ${memoryCount(results.length)}` : memoryCount(applied)
        }.`
      : null,
    failed: failures.length
      ? `Could not ${MEMORY_ACTION_LABELS[action].toLowerCase()} ${memoryCount(failures.length)}: ${failures.join(", ")}.`
      : null,
  };
}

export const PERSONAL_MEMORY_DISCLOSURE =
  "Only your own prompts can search, read or save your personal memories. Once someone else prompts a session, searching stops there and what your prompts save waits for your review. Those loaded when a session starts still shape every prompt in it, and agent responses are visible to anyone who can see the session.";

export function memoryTypeLabel(type: MemoryType): string {
  const { label, hint } = MEMORY_TYPE_LABELS[type];
  return `${label} · ${hint}`;
}

function memorySettingsCategory(scope: MemoryScope): SettingsCategory {
  switch (scope.type) {
    case "personal":
      return "memories";
    case "repository":
    case "environment":
      return "shared-memories";
  }
}

/** Repository display names may be stale; focus those records by ID in the All view. */
export function memorySettingsLink(scope: MemoryScope, id: string): string {
  const query =
    scope.type === "repository"
      ? new URLSearchParams({ scope: "shared" })
      : memoryScopeToSearchParams(scope);
  query.set("tab", memorySettingsCategory(scope));
  query.set("memoryId", id);
  return `/settings?${query}`;
}

/** A mutation failure's message for display, or `fallback` for non-Error throws. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
