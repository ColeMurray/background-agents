"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { SkillAssignmentInput } from "@open-inspect/shared/types/skills";
import { importSkill, previewSkillImport } from "@/hooks/use-managed-skills";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkillAssignments } from "./skill-assignments";
import { SkillImportReview } from "./skill-import-review";
import { useImportPreview } from "./use-import-preview";
import {
  assignmentKey,
  buildAssignments,
  errorMessage,
  previewedSourceConfirmation,
} from "./utils";

const INITIAL_ASSIGNMENTS: SkillAssignmentInput[] = [{ type: "global" }];

/**
 * Two-step import: read a repository into a preview, then store exactly what
 * the preview showed. The confirm carries the previewed commit and digest, so
 * an upstream change between the steps is rejected rather than saved unseen.
 */
export function SkillImport({
  onImported,
  onCancel,
}: {
  onImported: (id: string) => void;
  onCancel: () => void;
}) {
  const { repos, loading: reposLoading, error: reposError } = useRepos();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
  } = useEnvironments();
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [importing, setImporting] = useState(false);
  const [assignmentKeys, setAssignmentKeys] = useState(
    () => new Set(INITIAL_ASSIGNMENTS.map(assignmentKey))
  );

  const selectedRepo = repos.find((repo) => repo.fullName === repository);
  const assignmentsUnavailable = Boolean(
    reposLoading || environmentsLoading || reposError || environmentsError
  );

  function sourceInput() {
    if (!selectedRepo) throw new Error("Select a repository to import from");
    return {
      repository: { repoOwner: selectedRepo.owner, repoName: selectedRepo.name },
      ref: ref.trim() || null,
      subdirectory: subdirectory.trim() || null,
    };
  }

  const {
    preview,
    loading: loadingPreview,
    run: loadPreview,
    invalidate: invalidatePreview,
  } = useImportPreview(() =>
    previewSkillImport({
      source: sourceInput(),
      name: nameOverride.trim() || null,
    })
  );

  async function runPreview() {
    const result = await loadPreview();
    if (result && !result.nameAvailable) {
      toast.warning(`A skill named ${result.name} already exists. Choose a different name.`);
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const skill = await importSkill({
        source: sourceInput(),
        name: preview.name,
        assignments: buildAssignments(assignmentKeys, repos, environments, INITIAL_ASSIGNMENTS),
        ...previewedSourceConfirmation(preview),
      });
      toast.success(`Imported ${skill.name}`);
      onImported(skill.id);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setImporting(false);
    }
  }

  /** Any source edit invalidates the reviewed result. */
  function editSource(apply: () => void) {
    apply();
    invalidatePreview();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Import skill from repository</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Read a <code className="font-mono">SKILL.md</code> directory from a connected
            repository. Nothing is saved until you review the result.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Close
        </Button>
      </div>

      <div className="space-y-4 rounded border border-border-muted p-4">
        <div>
          <Label htmlFor="import-repository">Repository</Label>
          <select
            id="import-repository"
            value={repository}
            onChange={(event) => editSource(() => setRepository(event.target.value))}
            disabled={reposLoading}
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="">Select a repository</option>
            {repos.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
          </select>
          {reposError && (
            <p className="mt-1 text-xs text-destructive">Failed to load repositories.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="import-ref">Branch, tag, or commit (optional)</Label>
            <Input
              id="import-ref"
              value={ref}
              onChange={(event) => editSource(() => setRef(event.target.value))}
              placeholder={selectedRepo?.defaultBranch ?? "default branch"}
              className="mt-1 font-mono"
            />
          </div>
          <div>
            <Label htmlFor="import-subdirectory">Subdirectory (optional)</Label>
            <Input
              id="import-subdirectory"
              value={subdirectory}
              onChange={(event) => editSource(() => setSubdirectory(event.target.value))}
              placeholder="skills/deploy-service"
              className="mt-1 font-mono"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="import-name">Canonical name (optional)</Label>
          <Input
            id="import-name"
            value={nameOverride}
            onChange={(event) =>
              editSource(() => setNameOverride(event.target.value.toLowerCase()))
            }
            placeholder="Defaults to the name in SKILL.md"
            className="mt-1 font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The name cannot be changed after import, and a deleted skill&apos;s name stays taken.
          </p>
        </div>
      </div>

      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
        Imported skills are trusted instructions, not a permission boundary. Review the instructions
        and any scripts below before importing third-party content.
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="subtle"
          onClick={runPreview}
          disabled={!selectedRepo || loadingPreview || importing}
        >
          {loadingPreview ? "Reading..." : preview ? "Refresh preview" : "Preview import"}
        </Button>
      </div>

      {preview && (
        <>
          <SkillImportReview preview={preview} />
          {assignmentsUnavailable && (
            <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
              Assignment targets are still loading or failed to load. Importing is disabled until
              they are available.
            </p>
          )}
          <SkillAssignments
            assignmentKeys={assignmentKeys}
            repos={repos}
            environments={environments}
            onToggle={(key, checked) =>
              setAssignmentKeys((current) => {
                const next = new Set(current);
                if (checked) next.add(key);
                else next.delete(key);
                return next;
              })
            }
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              onClick={confirmImport}
              disabled={importing || assignmentsUnavailable || !preview.nameAvailable}
            >
              {importing ? "Importing..." : `Import ${preview.name}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
