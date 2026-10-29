"use client";

import type { MemoryContent, MemoryDto } from "@open-inspect/shared/types/memories";
import { useMemoryRevisions } from "@/hooks/use-memories";
import { MEMORY_AUTHOR_LABELS, MEMORY_TYPE_LABELS } from "@/lib/memories";
import { Button } from "@/components/ui/button";

function formatRevision({ memoryType, title, description, content }: MemoryContent): string {
  return `${MEMORY_TYPE_LABELS[memoryType].label}: ${title}\n${description}\n\n${content}`;
}

/** Inspect immutable revisions; restoring content creates a new revision rather than rewriting history. */
export function MemoryHistory({
  record,
  busy,
  onRevert,
}: {
  record: MemoryDto;
  busy: boolean;
  onRevert: (content: MemoryContent) => void;
}) {
  const { revisions, loading, error } = useMemoryRevisions(record.id);
  if (loading) return <p className="text-sm">Loading history…</p>;
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        Unable to load memory history.
      </p>
    );
  return (
    <div className="space-y-3">
      {revisions.map((revision, index) => {
        const previous = revisions[index + 1];
        return (
          <details key={revision.id} className="rounded-sm border border-border p-3">
            <summary className="cursor-pointer text-sm">
              Revision {revision.revisionNumber} · {MEMORY_AUTHOR_LABELS[revision.authorKind]} ·{" "}
              {new Date(revision.createdAt).toLocaleString()}
            </summary>
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <p className="font-medium">Before</p>
                <pre className="whitespace-pre-wrap break-words bg-destructive/5 p-2">
                  <del>{previous ? formatRevision(previous) : "No previous revision"}</del>
                </pre>
              </div>
              <div>
                <p className="font-medium">After</p>
                <pre className="whitespace-pre-wrap break-words bg-accent/10 p-2">
                  <ins className="no-underline">{formatRevision(revision)}</ins>
                </pre>
              </div>
            </div>
            {record.capabilities.canEdit && revision.id !== record.currentRevisionId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onRevert(revision)}
              >
                Revert to this revision
              </Button>
            )}
          </details>
        );
      })}
    </div>
  );
}
