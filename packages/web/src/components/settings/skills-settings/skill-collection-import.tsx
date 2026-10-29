"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MAX_BULK_SKILL_IMPORT_ASSIGNMENTS } from "@open-inspect/shared/types/skills";
import { bulkImportSkills, previewBulkSkillImport } from "@/hooks/use-managed-skills";
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
import { BulkSkillImportReview } from "./bulk-skill-import-review";
import { useImportPreview } from "./use-import-preview";
import {
  INITIAL_IMPORT_ASSIGNMENTS as INITIAL_ASSIGNMENTS,
  assignmentKey,
  buildAssignments,
  errorMessage,
} from "./utils";

const NO_REPOSITORY = "no-repository";

export function SkillCollectionImport({
  onImported,
  onBusyChange,
}: {
  onImported: (id: null) => void;
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
  const [prefix, setPrefix] = useState("");
  const [importing, setImporting] = useState(false);
  const importActive = useRef(false);
  const mounted = useRef(true);
  // null marks initial discovery; refresh failures retain the last selection.
  const [selectedRoots, setSelectedRoots] = useState<Set<string> | null>(null);
  const [assignmentKeys, setAssignmentKeys] = useState(
    () => new Set(INITIAL_ASSIGNMENTS.map(assignmentKey))
  );
  const selectedRepo = repos.find((repo) => repo.fullName === repository);
  const assignmentsUnavailable = Boolean(
    reposLoading || environmentsLoading || reposError || environmentsError
  );
  const assignments = buildAssignments(assignmentKeys, repos, environments, INITIAL_ASSIGNMENTS);

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
      subdirectory: prefix.trim() || null,
    };
  }

  const {
    preview,
    loading: loadingPreview,
    run: loadPreview,
    invalidate: invalidatePreview,
  } = useImportPreview(
    () => previewBulkSkillImport({ source: sourceInput() }),
    onBusyChange,
    (result) => {
      setSelectedRoots(
        (current) =>
          new Set(
            result.skills
              .filter(
                (skill) =>
                  skill.nameAvailable &&
                  (current === null || current.has(skill.source.subdirectory ?? ""))
              )
              .map((skill) => skill.source.subdirectory ?? "")
          )
      );
    }
  );

  function editSource(apply: () => void) {
    apply();
    invalidatePreview();
    setSelectedRoots(null);
  }

  async function confirmImport() {
    if (!preview || loadingPreview || importActive.current) return;
    const selected = preview.skills.filter(
      (skill) => skill.nameAvailable && selectedRoots?.has(skill.source.subdirectory ?? "")
    );
    if (selected.length === 0) return;
    importActive.current = true;
    setImporting(true);
    onBusyChange(true);
    try {
      const skills = await bulkImportSkills({
        source: sourceInput(),
        expectedCommitSha: preview.commitSha,
        skills: selected.map((skill) => ({
          subdirectory: skill.source.subdirectory,
          name: skill.name,
          expectedSourceSha256: skill.source.sourceSha256,
          expectedRevisionSha256: skill.revisionSha256,
        })),
        assignments,
      });
      if (!mounted.current) return;
      toast.success(`Imported ${skills.length} skill${skills.length === 1 ? "" : "s"}`);
      onImported(null);
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

  const selectedCount =
    preview?.skills.filter(
      (skill) => skill.nameAvailable && selectedRoots?.has(skill.source.subdirectory ?? "")
    ).length ?? 0;
  const tooManyAssignments = assignments.length > MAX_BULK_SKILL_IMPORT_ASSIGNMENTS;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Discover every skill below a repository prefix, then choose which ones to import together.
      </p>
      <div className="space-y-4 rounded border border-border-muted p-4">
        <div>
          <Label htmlFor="collection-import-repository">Repository</Label>
          <Select
            value={repository || NO_REPOSITORY}
            onValueChange={(value) =>
              editSource(() => setRepository(value === NO_REPOSITORY ? "" : value))
            }
            disabled={reposLoading || loadingPreview || importing}
          >
            <SelectTrigger id="collection-import-repository" className="mt-1">
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
            <Label htmlFor="collection-import-ref">Branch, tag, or commit (optional)</Label>
            <Input
              id="collection-import-ref"
              value={ref}
              onChange={(event) => editSource(() => setRef(event.target.value))}
              placeholder={selectedRepo?.defaultBranch ?? "default branch"}
              disabled={loadingPreview || importing}
              className="mt-1 font-mono"
            />
          </div>
          <div>
            <Label htmlFor="collection-import-prefix">Prefix (optional)</Label>
            <Input
              id="collection-import-prefix"
              value={prefix}
              onChange={(event) => editSource(() => setPrefix(event.target.value))}
              placeholder="skills"
              disabled={loadingPreview || importing}
              className="mt-1 font-mono"
            />
          </div>
        </div>
      </div>

      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
        Imported skills are trusted instructions, not a permission boundary. Review the instructions
        and any scripts below before importing third-party content.
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="subtle"
          onClick={loadPreview}
          disabled={!selectedRepo || loadingPreview || importing}
        >
          {loadingPreview ? "Reading..." : preview ? "Refresh preview" : "Preview collection"}
        </Button>
      </div>

      {preview && (
        <fieldset disabled={loadingPreview || importing} className="min-w-0 space-y-6">
          <BulkSkillImportReview
            preview={preview}
            selectedRoots={selectedRoots ?? new Set()}
            onToggle={(root, checked) =>
              setSelectedRoots((current) => {
                const next = new Set(current);
                if (checked) next.add(root);
                else next.delete(root);
                return next;
              })
            }
            onToggleAll={(checked) =>
              setSelectedRoots(
                checked
                  ? new Set(
                      preview.skills
                        .filter((skill) => skill.nameAvailable)
                        .map((skill) => skill.source.subdirectory ?? "")
                    )
                  : new Set()
              )
            }
          />
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
          {tooManyAssignments && (
            <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
              Collection imports support at most {MAX_BULK_SKILL_IMPORT_ASSIGNMENTS} assignments.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              onClick={confirmImport}
              disabled={
                loadingPreview ||
                importing ||
                assignmentsUnavailable ||
                tooManyAssignments ||
                selectedCount === 0
              }
            >
              {importing ? "Importing..." : `Import ${selectedCount} skills`}
            </Button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
