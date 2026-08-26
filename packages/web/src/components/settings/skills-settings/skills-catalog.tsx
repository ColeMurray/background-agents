"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  deleteSkill,
  revalidateSkillCatalogPage,
  setSkillEnabled,
  useSkill,
  useSkillCatalogPage,
} from "@/hooks/use-managed-skills";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PlusIcon, SparkleIcon } from "@/components/ui/icons";
import { SkillEditor } from "./skill-editor";
import { SkillImport } from "./skill-import";
import { errorMessage } from "./utils";

export function SkillsCatalog() {
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const cursor = cursorHistory.at(-1) ?? null;
  const { skills, hasMore, nextCursor, loading, error } = useSkillCatalogPage(cursor);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const {
    skill,
    loading: loadingSkill,
    error: skillError,
    mutate: mutateSkill,
  } = useSkill(selectedId);
  const hasPreviousPage = cursorHistory.length > 0;
  const showPagination = hasPreviousPage || (!loading && !error && skills.length > 0);

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      await setSkillEnabled(id, { enabled });
      await revalidateSkillCatalogPage(cursor);
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete ${name}? Existing sessions keep their pinned copy.`)) return;
    try {
      await deleteSkill(id);
      if (selectedId === id) setSelectedId(null);
      const moveToPreviousPage = skills.length === 1 && cursorHistory.length > 0;
      if (moveToPreviousPage) {
        setCursorHistory((history) => history.slice(0, -1));
      }
      await revalidateSkillCatalogPage(
        moveToPreviousPage ? (cursorHistory.at(-2) ?? null) : cursor
      );
      toast.success("Skill deleted");
    } catch (requestError) {
      toast.error(errorMessage(requestError));
    }
  }

  if (creating) {
    return (
      <SkillEditor
        creating
        onCancel={() => setCreating(false)}
        onSaved={async (id) => {
          setCreating(false);
          setSelectedId(id);
          setCursorHistory([]);
          await revalidateSkillCatalogPage(null);
        }}
      />
    );
  }
  if (importing) {
    return (
      <SkillImport
        onCancel={() => setImporting(false)}
        onImported={async (id) => {
          setImporting(false);
          setSelectedId(id);
          setCursorHistory([]);
          await revalidateSkillCatalogPage(null);
        }}
      />
    );
  }
  if (selectedId) {
    if (skillError)
      return <p className="text-sm text-destructive">Failed to load this managed skill.</p>;
    if (loadingSkill || !skill)
      return <p className="text-sm text-muted-foreground">Loading skill...</p>;
    return (
      <SkillEditor
        key={`${skill.id}:${skill.currentRevisionId}`}
        skill={skill}
        creating={false}
        onCancel={() => setSelectedId(null)}
        onSaved={async () => {
          await Promise.all([revalidateSkillCatalogPage(cursor), mutateSkill()]);
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">Shared skills</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage reusable instructions assigned to repositories and environments.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="subtle" onClick={() => setImporting(true)}>
            Import from repository
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="h-4 w-4" /> New skill
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-destructive">Failed to load managed skills.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading skills...</p>
      ) : skills.length === 0 && !hasPreviousPage ? (
        <div className="rounded border border-dashed border-border p-8 text-center">
          <SparkleIcon className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm text-foreground">No shared skills yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to give agents consistent workflows and context.
          </p>
        </div>
      ) : skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills on this page.</p>
      ) : (
        <div className="divide-y divide-border-muted rounded border border-border-muted">
          {skills.map((item) => (
            <div key={item.id} className="flex items-start gap-3 p-4">
              <button
                type="button"
                onClick={() => setSelectedId(item.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-medium text-foreground">
                    {item.name}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    r{item.revisionNumber}
                  </span>
                  {item.source && (
                    <span
                      className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      title={`Imported from ${item.source.repoOwner}/${item.source.repoName} at ${item.source.commitSha}`}
                    >
                      {item.source.repoOwner}/{item.source.repoName}
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {item.description}
                </p>
                <p className="mt-2 flex flex-wrap gap-x-2.5 text-xs text-muted-foreground">
                  <span>
                    {item.assignments.length} assignment{item.assignments.length === 1 ? "" : "s"}
                  </span>
                  <span>· Created by {item.creatorDisplayName || item.createdBy}</span>
                </p>
              </button>
              <Switch
                checked={item.enabled}
                onCheckedChange={(value) => toggleEnabled(item.id, value)}
                aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}
              />
              <Button variant="ghost" size="xs" onClick={() => remove(item.id, item.name)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
      {showPagination && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Page {cursorHistory.length + 1}</p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPreviousPage}
              onClick={() => setCursorHistory((history) => history.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || Boolean(error) || !hasMore || !nextCursor}
              onClick={() => {
                if (nextCursor) setCursorHistory((history) => [...history, nextCursor]);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
