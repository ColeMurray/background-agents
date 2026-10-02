"use client";

import type { MemoryContent, MemoryView } from "@open-inspect/shared/types/memories";
import { useMemoryRevisions } from "@/hooks/use-memories";
import { Button } from "@/components/ui/button";

export function MemoryHistory({
  record,
  onRestore,
}: {
  record: MemoryView;
  onRestore: (content: MemoryContent) => Promise<void>;
}) {
  const { data, error, isLoading } = useMemoryRevisions(record.id);
  if (isLoading) return <p className="text-sm">Loading history…</p>;
  if (error) return <p role="alert">Unable to load memory history.</p>;
  return (
    <div className="space-y-3">
      {data?.revisions.map((revision, index) => {
        const previous = data.revisions[index + 1];
        const text = `${revision.memoryType}: ${revision.title}\n${revision.description}\n\n${revision.content}`;
        const before = previous
          ? `${previous.memoryType}: ${previous.title}\n${previous.description}\n\n${previous.content}`
          : "";
        return (
          <details key={revision.id} className="rounded-sm border border-border p-3">
            <summary className="cursor-pointer text-sm">
              Revision {revision.revisionNumber} · {revision.authorKind} ·{" "}
              {new Date(revision.createdAt).toLocaleString()}
            </summary>
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <div>
                <p className="font-medium">Before</p>
                <pre className="whitespace-pre-wrap break-words bg-destructive/5 p-2">
                  <del>{before || "No previous revision"}</del>
                </pre>
              </div>
              <div>
                <p className="font-medium">After</p>
                <pre className="whitespace-pre-wrap break-words bg-accent/10 p-2">
                  <ins className="no-underline">{text}</ins>
                </pre>
              </div>
            </div>
            {record.capabilities.canEdit && revision.id !== record.currentRevisionId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void onRestore({
                    memoryType: revision.memoryType,
                    title: revision.title,
                    description: revision.description,
                    content: revision.content,
                  })
                }
              >
                Restore as new revision
              </Button>
            )}
          </details>
        );
      })}
    </div>
  );
}
