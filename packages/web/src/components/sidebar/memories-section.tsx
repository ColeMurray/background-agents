"use client";

import Link from "next/link";
import {
  memoryScopeLabel,
  type MemoryScopeType,
  type SessionMemorySelectionStatus,
} from "@open-inspect/shared/types/memories";
import { useSessionMemories } from "@/hooks/use-memories";
import { MEMORY_INCLUSION_LABELS, MEMORY_TYPE_LABELS, memorySettingsLink } from "@/lib/memories";
import { CollapsibleSection } from "./collapsible-section";

type MemoryItem = SessionMemorySelectionStatus["items"][number];

const SCOPE_ORDER: readonly MemoryScopeType[] = ["repository", "environment", "personal"];
const SCOPE_LABELS: Record<MemoryScopeType, string> = {
  repository: "Repository",
  environment: "Environment",
  personal: "Personal",
};

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(tokens);
}

function itemTooltip(item: MemoryItem): string {
  return [
    memoryScopeLabel(item.scope),
    `${MEMORY_TYPE_LABELS[item.memoryType].label} (${MEMORY_INCLUSION_LABELS[item.inclusion]})`,
    `Revision ${item.revisionNumber}`,
    `~${formatTokens(item.estimatedTokens)} tokens`,
    item.revisedSinceSelection ? "Revised since session start" : null,
    item.archivedSinceSelection ? "Archived since session start" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function MemoryRow({ item }: { item: MemoryItem }) {
  const isDirective = item.memoryType === "directive";
  return (
    <li className="flex min-w-0 items-center gap-2" title={itemTooltip(item)}>
      <span
        aria-label={MEMORY_TYPE_LABELS[item.memoryType].label}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          isDirective ? "bg-accent" : "border border-muted-foreground"
        }`}
      />
      <Link
        href={memorySettingsLink(item.scope, item.memoryId)}
        className={`min-w-0 flex-1 truncate hover:text-accent hover:underline ${
          item.archivedSinceSelection ? "text-muted-foreground line-through" : "text-foreground"
        }`}
      >
        {item.title}
      </Link>
      {item.revisedSinceSelection && (
        <span className="shrink-0 text-[10px] text-warning">revised</span>
      )}
      {item.archivedSinceSelection && (
        <span className="shrink-0 text-[10px] text-muted-foreground">archived</span>
      )}
    </li>
  );
}

/** Inspect the bounded pinned selection grouped by scope, with live drift/archive notices. */
export function MemoriesSection({ sessionId }: { sessionId: string }) {
  const { diagnostics, loading, error } = useSessionMemories(sessionId);
  if (loading) return <p className="text-xs text-muted-foreground">Loading memories…</p>;
  if (error) return <p className="text-xs text-muted-foreground">Memories unavailable.</p>;
  if (!diagnostics) return null;
  const groups = SCOPE_ORDER.map((type) => ({
    type,
    items: diagnostics.items.filter((item) => item.scope.type === type),
  })).filter((group) => group.items.length > 0);
  return (
    <CollapsibleSection title={`Memories (${diagnostics.items.length})`} defaultOpen={false}>
      <div className="space-y-3 text-xs">
        {groups.length === 0 && <p className="text-muted-foreground">No memories were loaded.</p>}
        {groups.map((group) => (
          <div key={group.type}>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
              {SCOPE_LABELS[group.type]} · {group.items.length}
            </p>
            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <MemoryRow key={item.memoryId} item={item} />
              ))}
            </ul>
          </div>
        ))}
        <p className="text-[10px] text-muted-foreground">
          ~{formatTokens(diagnostics.estimatedTokens)} tokens · personal{" "}
          {diagnostics.includePersonalMemories ? "included" : "excluded"}
          {diagnostics.omittedCount > 0 && (
            <span className="text-warning"> · {diagnostics.omittedCount} omitted for budget</span>
          )}
        </p>
      </div>
    </CollapsibleSection>
  );
}
