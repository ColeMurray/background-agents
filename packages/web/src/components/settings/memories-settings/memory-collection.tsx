"use client";

import { useState } from "react";
import {
  MEMORY_SEARCH_LIMITS,
  MEMORY_STATUSES,
  type MemoryAction,
  type MemoryContent,
  type MemoryDto,
  type MemoryListScope,
} from "@open-inspect/shared/types/memories";
import {
  applyBulkMemoryAction,
  applyMemoryAction,
  createMemory,
  reviseMemory,
} from "@/hooks/use-memories";
import { bulkActionSummary, errorMessage, MEMORY_STATUS_LABELS } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { SearchIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MemoryBulkActions } from "./memory-bulk-actions";
import { MemoryCard } from "./memory-card";
import { MemoryEditor } from "./memory-editor";
import { useMemoryCollection } from "./use-memory-collection";
import { useMemorySearch } from "./use-memory-search";
import { useMemorySelection } from "./use-memory-selection";

/**
 * The one open panel in a collection. Card-local panels key on the record ID so actions use the
 * live record; edits keep the snapshot the editor was seeded from so they fence on that revision.
 */
export type MemoryPanel =
  | { kind: "none" }
  | { kind: "create"; supersedesMemoryId?: string }
  | { kind: "edit"; record: MemoryDto }
  | { kind: "archive"; memoryId: string; archiveNote: string }
  | { kind: "history"; memoryId: string }
  | { kind: "bulk"; action: MemoryAction; archiveNote: string; selectionKey: string };

const NO_PANEL: MemoryPanel = { kind: "none" };
const STATUS_OPTIONS = MEMORY_STATUSES.map((value) => ({
  value,
  label: MEMORY_STATUS_LABELS[value],
}));

/** Manage a paginated scope using server capabilities and revision-fenced mutations. */
export function MemoryCollection({ scope }: { scope: MemoryListScope }) {
  const search = useMemorySearch();
  const collection = useMemoryCollection(scope, search.search);
  // Creation needs a concrete scope; the All view only browses and reviews.
  const canCreate = scope !== "shared" && collection.canCreate;
  const [panel, setPanel] = useState<MemoryPanel>(() =>
    collection.focusedId ? { kind: "history", memoryId: collection.focusedId } : NO_PANEL
  );
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selection = useMemorySelection(
    collection.records,
    `${collection.status}:${collection.offset}:${search.search}`
  );
  // A bulk confirmation was reviewed for one selection; any change to it closes the panel.
  if (panel.kind === "bulk" && panel.selectionKey !== selection.key) setPanel(NO_PANEL);

  /** Serialize mutations: one in flight, one error channel, one refresh. */
  async function run(mutation: () => Promise<unknown>, nextPanel: MemoryPanel = NO_PANEL) {
    setBusy(true);
    setMutationError(null);
    setNotice(null);
    try {
      await mutation();
      setPanel(nextPanel);
      await collection.refresh();
    } catch (cause) {
      setMutationError(errorMessage(cause, "Memory request failed"));
    } finally {
      setBusy(false);
    }
  }

  function save(content: MemoryContent) {
    if (panel.kind === "edit") void run(() => reviseMemory(panel.record, content));
    if (panel.kind === "create" && scope !== "shared") {
      void run(() =>
        createMemory({ ...content, scope, supersedesMemoryId: panel.supersedesMemoryId })
      );
    }
  }

  /**
   * Apply one action to the selection. Per-record failures are reported rather than thrown, so the
   * records that did change still refresh.
   */
  function runBulk(action: MemoryAction, archiveNote?: string) {
    const records = selection.selected;
    void run(async () => {
      const results = await applyBulkMemoryAction(records, action, archiveNote);
      const summary = bulkActionSummary(action, records, results);
      selection.clear();
      setNotice(summary.applied);
      setMutationError(summary.failed);
    });
  }

  function changePanel(next: MemoryPanel) {
    setMutationError(null);
    setNotice(null);
    setPanel(next);
  }

  const error = mutationError ?? (collection.error ? "Unable to load memories." : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <SegmentedControl
          label="Memory status"
          value={collection.status}
          options={STATUS_OPTIONS}
          onValueChange={(value) => {
            collection.setStatus(value);
            changePanel(NO_PANEL);
          }}
        />
        {canCreate && (
          <Button type="button" size="sm" onClick={() => changePanel({ kind: "create" })}>
            New memory
          </Button>
        )}
      </div>
      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label="Search memories"
          placeholder="Search title, description or content"
          value={search.text}
          maxLength={MEMORY_SEARCH_LIMITS.query}
          onChange={(event) => search.setText(event.target.value)}
          aria-invalid={search.problem ? true : undefined}
          aria-describedby={search.problem ? "memory-search-problem" : undefined}
          className="pl-9"
        />
      </div>
      {search.problem && (
        <p id="memory-search-problem" role="alert" className="text-sm text-destructive">
          {search.problem}
        </p>
      )}
      {collection.truncated && (
        <p className="text-sm text-muted-foreground">
          All-view browsing limit reached. Select a scope or narrow your search to find more
          memories.
        </p>
      )}
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
      <MemoryBulkActions
        selection={selection}
        panel={panel}
        busy={busy}
        onPanelChange={changePanel}
        onAction={runBulk}
      />
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
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {collection.loading && <p className="text-sm text-muted-foreground">Loading memories…</p>}
      {!collection.loading && !collection.error && collection.records.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No {MEMORY_STATUS_LABELS[collection.status].toLowerCase()} memories{" "}
          {search.search
            ? `match “${search.search}”.`
            : scope === "shared"
              ? "across your accessible repositories and environments."
              : "for this scope."}
        </p>
      )}
      {collection.records.map((record) => (
        <MemoryCard
          key={record.id}
          record={record}
          panel={panel}
          busy={busy}
          canCreate={canCreate}
          showScope={scope === "shared"}
          selected={selection.isSelected(record.id)}
          onSelectedChange={
            record.capabilities.actions.length
              ? (checked) => selection.toggle(record.id, checked)
              : undefined
          }
          onPanelChange={changePanel}
          onAction={(action, archiveNote) =>
            void run(() => applyMemoryAction(record, action, archiveNote))
          }
          onRevertToRevision={(content) => void run(() => reviseMemory(record, content), panel)}
        />
      ))}
    </div>
  );
}
