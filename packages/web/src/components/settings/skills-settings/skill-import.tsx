"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { importSkill, previewSkillImport } from "@/hooks/use-managed-skills";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SkillAssignments } from "./skill-assignments";
import { SkillCollectionImport } from "./skill-collection-import";
import { SkillImportReview } from "./skill-import-review";
import { useImportPreview } from "./use-import-preview";
import {
  INITIAL_IMPORT_ASSIGNMENTS as INITIAL_ASSIGNMENTS,
  assignmentKey,
  buildAssignments,
  errorMessage,
  previewedSourceConfirmation,
} from "./utils";

const NO_REPOSITORY = "no-repository";

/**
 * Two-step import: read a repository into a preview, then store exactly what
 * the preview showed. The confirm carries the previewed commit and digest, so
 * an upstream change between the steps is rejected rather than saved unseen.
 */
export function SkillImport({
  onImported,
  onCancel,
}: {
  onImported: (id: string | null) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"single" | "collection">("single");
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Import from repository</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Review repository skills before adding them to the shared catalog.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Close
        </Button>
      </div>

      <div
        className="grid grid-cols-2 gap-2 rounded bg-muted p-1"
        role="group"
        aria-label="Import mode"
      >
        <Button
          type="button"
          variant={mode === "single" ? "outline" : "ghost"}
          aria-pressed={mode === "single"}
          disabled={busy}
          onClick={() => setMode("single")}
        >
          One skill
        </Button>
        <Button
          type="button"
          variant={mode === "collection" ? "outline" : "ghost"}
          aria-pressed={mode === "collection"}
          disabled={busy}
          onClick={() => setMode("collection")}
        >
          Skill collection
        </Button>
      </div>

      {mode === "single" ? (
        <SingleSkillImport onImported={onImported} onBusyChange={setBusy} />
      ) : (
        <SkillCollectionImport onImported={onImported} onBusyChange={setBusy} />
      )}
    </div>
  );
}

function SingleSkillImport({
  onImported,
  onBusyChange,
}: {
  onImported: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
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
  const importActive = useRef(false);
  const mounted = useRef(true);
  const [assignmentKeys, setAssignmentKeys] = useState(
    () => new Set(INITIAL_ASSIGNMENTS.map(assignmentKey))
  );

  const selectedRepo = repos.find((repo) => repo.fullName === repository);
  const assignmentsUnavailable = Boolean(
    reposLoading || environmentsLoading || reposError || environmentsError
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      importActive.current = false;
    };
  }, []);

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
  } = useImportPreview(
    () =>
      previewSkillImport({
        source: sourceInput(),
        name: nameOverride.trim() || null,
      }),
    onBusyChange
  );

  async function runPreview() {
    const result = await loadPreview();
    if (result && !result.nameAvailable) {
      toast.warning(`A skill named ${result.name} already exists. Choose a different name.`);
    }
  }

  async function confirmImport() {
    if (!preview || loadingPreview || importActive.current) return;
    importActive.current = true;
    setImporting(true);
    onBusyChange(true);
    try {
      const skill = await importSkill({
        source: sourceInput(),
        name: preview.name,
        assignments: buildAssignments(assignmentKeys, repos, environments, INITIAL_ASSIGNMENTS),
        ...previewedSourceConfirmation(preview),
      });
      if (!mounted.current) return;
      toast.success(`Imported ${skill.name}`);
      onImported(skill.id);
    } catch (error) {
      if (!mounted.current) return;
      toast.error(errorMessage(error));
    } finally {
      if (mounted.current) {
        importActive.current = false;
        setImporting(false);
        onBusyChange(false);
      }
    }
  }

  /** Any source edit invalidates the reviewed result. */
  function editSource(apply: () => void) {
    apply();
    invalidatePreview();
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Read a <code className="font-mono">SKILL.md</code> directory from a connected repository.
        Nothing is saved until you review the result.
      </p>
      <div className="space-y-4 rounded border border-border-muted p-4">
        <div>
          <Label htmlFor="import-repository">Repository</Label>
          <Select
            value={repository || NO_REPOSITORY}
            onValueChange={(value) =>
              editSource(() => setRepository(value === NO_REPOSITORY ? "" : value))
            }
            disabled={reposLoading || loadingPreview || importing}
          >
            <SelectTrigger id="import-repository" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_REPOSITORY}>Select a repository</SelectItem>
              {repos.map((repo) => (
                <SelectItem key={repo.fullName} value={repo.fullName}>
                  {repo.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              disabled={loadingPreview || importing}
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
              disabled={loadingPreview || importing}
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
            disabled={loadingPreview || importing}
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
              disabled={
                loadingPreview || importing || assignmentsUnavailable || !preview.nameAvailable
              }
            >
              {importing ? "Importing..." : `Import ${preview.name}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
