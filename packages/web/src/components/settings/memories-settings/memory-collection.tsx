"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  MEMORY_SEARCH_LIMITS,
  MEMORY_STATUSES,
  type MemoryContent,
  type MemoryDto,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { applyMemoryAction, createMemory, reviseMemory } from "@/hooks/use-memories";
import { errorMessage, MEMORY_STATUS_LABELS } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { SearchIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
const STATUS_OPTIONS = MEMORY_STATUSES.map((value) => ({
  value,
  label: MEMORY_STATUS_LABELS[value],
}));

/** Manage a paginated scope using server capabilities and revision-fenced mutations. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search text typed into the box, committed after a pause and mirrored in `?search=` so a filtered
 * list can be shared or reloaded (the same pattern as the automations list).
 */
function useCommittedSearch() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const urlSearch = params.get("search") ?? "";
  const [input, setInput] = useState(urlSearch);
  const [committed, setCommitted] = useState(urlSearch.trim());
  // Navigation that changes `?search=` (a link, back/forward) replaces whatever was typed, so the
  // pending write below never puts the old text back.
  const [lastUrlSearch, setLastUrlSearch] = useState(urlSearch);
  if (urlSearch !== lastUrlSearch) {
    setLastUrlSearch(urlSearch);
    // Our own write echoes back as the trimmed input; keep the box as typed (e.g. a trailing space).
    if (urlSearch !== input.trim()) setInput(urlSearch);
    setCommitted(urlSearch.trim());
  }
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const next = input.trim();
      setCommitted(next);
      const query = new URLSearchParams(params.toString());
      if (next) query.set("search", next);
      else query.delete("search");
      if (query.toString() !== params.toString()) {
        const queryString = query.toString();
        router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [input, params, pathname, router]);
  return { input, setInput, committed };
}

export function MemoryCollection({ scope }: { scope: MemoryScope }) {
  const search = useCommittedSearch();
  const collection = useMemoryCollection(scope, search.committed);
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
      setMutationError(errorMessage(cause, "Memory request failed"));
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
        <SegmentedControl
          label="Memory status"
          value={collection.status}
          options={STATUS_OPTIONS}
          onValueChange={(value) => {
            collection.setStatus(value);
            changePanel(NO_PANEL);
          }}
        />
        {collection.canCreate && (
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
          value={search.input}
          maxLength={MEMORY_SEARCH_LIMITS.query}
          onChange={(event) => search.setInput(event.target.value)}
          className="pl-9"
        />
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
          {search.committed
            ? `No ${MEMORY_STATUS_LABELS[collection.status].toLowerCase()} memories match “${search.committed}”.`
            : `No ${MEMORY_STATUS_LABELS[collection.status].toLowerCase()} memories for this scope.`}
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
          onAction={(action, archiveNote) =>
            void run(() => applyMemoryAction(record, action, archiveNote))
          }
          onRevertToRevision={(content) => void run(() => reviseMemory(record, content), panel)}
        />
      ))}
    </div>
  );
}
