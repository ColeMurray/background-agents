"use client";

import { useId } from "react";
import {
  MEMORY_CONTENT_LIMITS,
  memoryActionAcceptsNote,
  type MemoryAction,
} from "@open-inspect/shared/types/memories";
import { MEMORY_ACTION_LABELS, memoryCount } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { MemoryPanel } from "./memory-collection";
import type { MemorySelection } from "./use-memory-selection";

/**
 * Select records on the page and apply one action every selected record allows. Actions that
 * archive ask for confirmation and an optional shared note; the collection owns transport.
 */
export function MemoryBulkActions({
  selection,
  panel,
  busy,
  onPanelChange,
  onAction,
}: {
  selection: MemorySelection;
  panel: MemoryPanel;
  busy: boolean;
  onPanelChange: (panel: MemoryPanel) => void;
  onAction: (action: MemoryAction, archiveNote?: string) => void;
}) {
  const selectAllId = useId();
  const count = selection.selected.length;
  if (!selection.selectable.length) return null;
  const confirming = panel.kind === "bulk" ? panel : null;
  return (
    <div className="space-y-3 rounded-sm border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          id={selectAllId}
          checked={count === selection.selectable.length ? true : count ? "indeterminate" : false}
          disabled={busy}
          onCheckedChange={(checked) => selection.toggleAll(checked === true)}
        />
        <label htmlFor={selectAllId} className="text-sm">
          Select all on this page
        </label>
        {count > 0 && (
          <span className="text-sm text-muted-foreground">{memoryCount(count)} selected</span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {selection.actions.map((action) => (
            <Button
              key={action}
              type="button"
              variant={action === "approve" ? "primary" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() =>
                memoryActionAcceptsNote(action)
                  ? onPanelChange({
                      kind: "bulk",
                      action,
                      archiveNote: "",
                      selectionKey: selection.key,
                    })
                  : onAction(action)
              }
            >
              {MEMORY_ACTION_LABELS[action]} selected
            </Button>
          ))}
        </div>
      </div>
      {confirming && (
        <div className="space-y-2">
          <label className="text-sm">
            Archive note for all selected (optional)
            <Input
              value={confirming.archiveNote}
              disabled={busy}
              maxLength={MEMORY_CONTENT_LIMITS.archiveNote}
              onChange={(event) =>
                onPanelChange({ ...confirming, archiveNote: event.target.value })
              }
            />
          </label>
          <p className="text-xs text-muted-foreground">
            New sessions will omit these memories. Text already included in a running session cannot
            be removed.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onAction(confirming.action, confirming.archiveNote)}
          >
            {MEMORY_ACTION_LABELS[confirming.action]} {memoryCount(count)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onPanelChange({ kind: "none" })}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
