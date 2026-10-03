"use client";

import {
  MEMORY_LIMITS,
  type MemoryAction,
  type MemoryContent,
  type MemoryDto,
} from "@open-inspect/shared/types/memories";
import {
  MEMORY_ACTION_LABELS,
  MEMORY_ARCHIVE_KIND_LABELS,
  memorySettingsLink,
  memoryTypeLabel,
} from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MemoryHistory } from "./memory-history";
import type { MemoryPanel } from "./memory-collection";

/** Render one record with the actions the server granted; the collection owns transport. */
export function MemoryCard({
  record,
  panel,
  busy,
  canCreate,
  onPanelChange,
  onAction,
  onRestoreRevision,
}: {
  record: MemoryDto;
  panel: MemoryPanel;
  busy: boolean;
  canCreate: boolean;
  onPanelChange: (panel: MemoryPanel) => void;
  onAction: (action: MemoryAction, reason?: string) => void;
  onRestoreRevision: (content: MemoryContent) => void;
}) {
  const archiving = panel.kind === "archive" && panel.memoryId === record.id ? panel : null;
  const historyOpen = panel.kind === "history" && panel.memoryId === record.id;
  return (
    <article id={record.id} className="space-y-3 rounded-sm border border-border p-4">
      <div>
        <h3 className="font-medium">{record.title}</h3>
        <p className="text-xs text-muted-foreground">
          {memoryTypeLabel(record.memoryType)} · Revision {record.revisionNumber} ·{" "}
          {record.authorKind === "agent" && record.authorSessionId ? (
            <a
              className="underline"
              href={`/session/${encodeURIComponent(record.authorSessionId)}`}
            >
              Agent session
            </a>
          ) : (
            "User-authored"
          )}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">{record.description}</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-sm">
        {record.content}
      </pre>
      {record.archiveKind && (
        <p className="text-xs text-muted-foreground">
          {MEMORY_ARCHIVE_KIND_LABELS[record.archiveKind]}
          {record.archiveNote ? `: ${record.archiveNote}` : ""}
        </p>
      )}
      {record.supersedesMemoryId && (
        <p className="text-xs text-muted-foreground">
          Replaces{" "}
          <a
            className="underline"
            href={memorySettingsLink(record.scope, record.supersedesMemoryId)}
          >
            {record.supersedesMemoryId}
          </a>
          {record.status === "proposed" ? " after approval" : ""}
        </p>
      )}
      {record.replacementMemoryIds.map((id) => (
        <p key={id} className="text-xs text-muted-foreground">
          Replacement:{" "}
          <a className="underline" href={memorySettingsLink(record.scope, id)}>
            {id}
          </a>
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {record.capabilities.canEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onPanelChange({ kind: "edit", record })}
          >
            Edit
          </Button>
        )}
        {canCreate && record.status === "active" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onPanelChange({ kind: "create", supersedesMemoryId: record.id })}
          >
            Replace
          </Button>
        )}
        {record.capabilities.actions.map((action) => (
          <Button
            key={action}
            type="button"
            variant={action === "approve" ? "primary" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() =>
              action === "archive"
                ? onPanelChange({ kind: "archive", memoryId: record.id, reason: "" })
                : onAction(action)
            }
          >
            {MEMORY_ACTION_LABELS[action]}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onPanelChange(historyOpen ? { kind: "none" } : { kind: "history", memoryId: record.id })
          }
        >
          Revision history
        </Button>
      </div>
      {archiving && (
        <div className="space-y-2">
          <label className="text-sm">
            Archive reason (optional)
            <Input
              value={archiving.reason}
              maxLength={MEMORY_LIMITS.archiveNote}
              onChange={(event) => onPanelChange({ ...archiving, reason: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            New sessions will omit this memory. Text already included in a running session cannot be
            removed.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onAction("archive", archiving.reason)}
          >
            Confirm archive
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onPanelChange({ kind: "none" })}
          >
            Cancel
          </Button>
        </div>
      )}
      {historyOpen && (
        <MemoryHistory
          key={record.currentRevisionId}
          record={record}
          busy={busy}
          onRestore={onRestoreRevision}
        />
      )}
    </article>
  );
}
