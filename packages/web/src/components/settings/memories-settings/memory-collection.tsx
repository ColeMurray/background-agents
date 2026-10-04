"use client";

import { useState } from "react";
import {
  MEMORY_STATUSES,
  type MemoryAction,
  type MemoryContent,
  type MemoryDto,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { applyMemoryAction, createMemory, reviseMemory } from "@/hooks/use-memories";
import { MEMORY_STATUS_LABELS } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { MemoryCard } from "./memory-card";
import { MemoryEditor } from "./memory-editor";
import { useMemoryCollection } from "./use-memory-collection";

/**
 * The one open panel in a collection. Card-local panels key on the record ID so actions use the
 * live record; edits keep the snapshot the editor was seeded from so they fence on that revision.
 */
export type MemoryPanel =
  | { kind: "none" }
  | { kind: "create"; supersedesMemoryId?: string }
  | { kind: "edit"; record: MemoryDto }
  | { kind: "archive"; memoryId: string; archiveNote: string }
  | { kind: "history"; memoryId: string };

const NO_PANEL: MemoryPanel = { kind: "none" };

/** Manage a paginated scope using server capabilities and revision-fenced mutations. */
export function MemoryCollection({ scope }: { scope: MemoryScope }) {
  const collection = useMemoryCollection(scope);
  const [panel, setPanel] = useState<MemoryPanel>(() =>
    collection.focusedId ? { kind: "history", memoryId: collection.focusedId } : NO_PANEL
  );
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  /** Serialize mutations: one in flight, one error channel, one refresh. */
  async function run(mutation: () => Promise<unknown>, nextPanel: MemoryPanel = NO_PANEL) {
    setBusy(true);
    setMutationError(null);
    try {
      await mutation();
      setPanel(nextPanel);
      await collection.refresh();
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "Memory request failed");
    } finally {
      setBusy(false);
    }
  }

  function save(content: MemoryContent) {
    if (panel.kind === "edit") void run(() => reviseMemory(panel.record, content));
    if (panel.kind === "create") {
      void run(() =>
        createMemory({ ...content, scope, supersedesMemoryId: panel.supersedesMemoryId })
      );
    }
  }

  function changePanel(next: MemoryPanel) {
    setMutationError(null);
    setPanel(next);
  }

  const error = mutationError ?? (collection.error ? "Unable to load memories." : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Memory status">
          {MEMORY_STATUSES.map((value) => (
            <Button
              key={value}
              type="button"
              role="tab"
              aria-selected={collection.status === value}
              variant={collection.status === value ? "primary" : "outline"}
              size="sm"
              onClick={() => {
                collection.setStatus(value);
                changePanel(NO_PANEL);
              }}
            >
              {MEMORY_STATUS_LABELS[value]}
            </Button>
          ))}
        </div>
        {collection.canCreate && (
          <Button type="button" size="sm" onClick={() => changePanel({ kind: "create" })}>
            New memory
          </Button>
        )}
      </div>
      <nav className="flex gap-2" aria-label="Memory pages">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!collection.hasPreviousPage || collection.loading}
          onClick={collection.previousPage}
        >
          Previous page
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!collection.hasNextPage || collection.loading}
          onClick={collection.nextPage}
        >
          Next page
        </Button>
      </nav>
      {(panel.kind === "create" || panel.kind === "edit") && (
        <MemoryEditor
          key={
            panel.kind === "edit"
              ? panel.record.currentRevisionId
              : (panel.supersedesMemoryId ?? "new")
          }
          record={panel.kind === "edit" ? panel.record : undefined}
          busy={busy}
          onSave={save}
          onCancel={() => changePanel(NO_PANEL)}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {collection.loading && <p className="text-sm text-muted-foreground">Loading memories…</p>}
      {!collection.loading && !collection.error && collection.records.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No {MEMORY_STATUS_LABELS[collection.status].toLowerCase()} memories for this scope.
        </p>
      )}
      {collection.records.map((record) => (
        <MemoryCard
          key={record.id}
          record={record}
          panel={panel}
          busy={busy}
          canCreate={collection.canCreate}
          onPanelChange={changePanel}
          onAction={(action: MemoryAction, archiveNote?: string) =>
            void run(() => applyMemoryAction(record, action, archiveNote))
          }
          onRestoreRevision={(content) => void run(() => reviseMemory(record, content), panel)}
        />
      ))}
    </div>
  );
}
