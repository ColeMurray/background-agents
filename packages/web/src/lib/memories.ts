import {
  memoryScopeToSearchParams,
  type MemoryAction,
  type MemoryArchiveKind,
  type MemoryAuthorKind,
  type MemoryInclusion,
  type MemoryPreviewInput,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from "@open-inspect/shared/types/memories";
import type { SettingsCategory } from "@/components/settings/settings-registry";
import type { SessionTargetRequestFields } from "@/lib/session-target";

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

export const PERSONAL_MEMORY_DISCLOSURE =
  "Personal memories included in a session may appear in agent responses and be visible to collaborators.";

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

/** Link to the appropriate personal/shared management view and selected record. */
export function memorySettingsLink(scope: MemoryScope, id: string): string {
  const query = memoryScopeToSearchParams(scope);
  query.set("tab", memorySettingsCategory(scope));
  query.set("memoryId", id);
  return `/settings?${query}`;
}

/** A per-session override of the saved personal-memory default. */
export type PersonalMemoryChoice = "default" | "include" | "exclude";

/** The request field for a choice; `undefined` lets the server apply the saved default. */
export function includePersonalMemoriesInput(choice: PersonalMemoryChoice): boolean | undefined {
  switch (choice) {
    case "default":
      return undefined;
    case "include":
      return true;
    case "exclude":
      return false;
  }
}

/** Preview the selection for the composer's current target without creating a session. */
export function memoryPreviewInput(
  fields: SessionTargetRequestFields | null,
  choice: PersonalMemoryChoice
): MemoryPreviewInput | null {
  if (!fields) return null;
  const includePersonalMemories = includePersonalMemoriesInput(choice);
  if ("environmentId" in fields) {
    return { environmentId: fields.environmentId, includePersonalMemories };
  }
  if ("repositories" in fields) {
    return { repositories: fields.repositories, includePersonalMemories };
  }
  if (!fields.repoOwner || !fields.repoName) return { includePersonalMemories };
  const { repoOwner, repoName, branch } = fields;
  return {
    repositories: [{ repoOwner, repoName, ...(branch ? { baseBranch: branch } : {}) }],
    includePersonalMemories,
  };
}

/** A mutation failure's message for display, or `fallback` for non-Error throws. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
