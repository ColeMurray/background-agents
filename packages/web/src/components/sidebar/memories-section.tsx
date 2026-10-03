"use client";

import { memoryScopeLabel } from "@open-inspect/shared/types/memories";
import { useSessionMemories } from "@/hooks/use-memories";
import { MEMORY_INCLUSION_LABELS, MEMORY_TYPE_LABELS, memorySettingsLink } from "@/lib/memories";
import { CollapsibleSection } from "./collapsible-section";

/** Inspect the bounded pinned selection with live drift/archive notices, never expanded fact bodies. */
export function MemoriesSection({ sessionId }: { sessionId: string }) {
  const { diagnostics, loading, error } = useSessionMemories(sessionId);
  if (loading) return <p className="text-xs text-muted-foreground">Loading memories…</p>;
  if (error) return <p className="text-xs text-muted-foreground">Memories unavailable.</p>;
  if (!diagnostics) return null;
  return (
    <CollapsibleSection title={`Memories (${diagnostics.items.length})`} defaultOpen={false}>
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          About {diagnostics.estimatedTokens.toLocaleString()} tokens ·{" "}
          {diagnostics.includePersonalMemories
            ? "Personal memories included"
            : "Personal memories excluded"}
        </p>
        {diagnostics.items.length === 0 && <p>No memories were loaded.</p>}
        {diagnostics.items.map((item) => (
          <div key={item.memoryId} className="border-l border-border pl-3">
            <a
              href={memorySettingsLink(item.scope, item.memoryId)}
              className="font-medium underline"
            >
              {item.title}
            </a>
            <p className="text-muted-foreground">
              {memoryScopeLabel(item.scope)} · {MEMORY_TYPE_LABELS[item.memoryType].label} · r
              {item.revisionNumber} · {MEMORY_INCLUSION_LABELS[item.inclusion]}
              {item.changed ? " · revised since start" : ""}
              {item.archived ? " · archived" : ""}
            </p>
          </div>
        ))}
        {diagnostics.truncatedCount > 0 && (
          <p>{diagnostics.truncatedCount} memories omitted for budget.</p>
        )}
      </div>
    </CollapsibleSection>
  );
}
