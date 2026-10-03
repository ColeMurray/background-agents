"use client";

import { memorySettingsLink, useSessionMemories } from "@/hooks/use-memories";
import { CollapsibleSection } from "./collapsible-section";

/** Inspect the bounded pinned selection with live drift/archive notices, never expanded fact bodies. */
export function MemoriesSection({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useSessionMemories(sessionId);
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading memories…</p>;
  if (error) return <p className="text-xs text-muted-foreground">Memories unavailable.</p>;
  if (!data) return null;
  return (
    <CollapsibleSection title={`Memories (${data.items.length})`} defaultOpen={false}>
      <div className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          About {data.estimatedTokens.toLocaleString()} tokens ·{" "}
          {data.includePersonalMemories
            ? "Personal memories included"
            : "Personal memories excluded"}
        </p>
        {data.items.length === 0 && <p>No memories were loaded.</p>}
        {data.items.map((item) => (
          <div key={item.memoryId} className="border-l border-border pl-3">
            <a
              href={memorySettingsLink(item.scope, item.memoryId)}
              className="font-medium underline"
            >
              {item.title}
            </a>
            <p className="text-muted-foreground">
              {item.scope.type} · r{item.revisionNumber} · {item.inclusion}
              {item.changed ? " · revised since start" : ""}
              {item.archived ? " · archived" : ""}
            </p>
          </div>
        ))}
        {data.truncatedCount > 0 && <p>{data.truncatedCount} memories omitted for budget.</p>}
      </div>
    </CollapsibleSection>
  );
}
