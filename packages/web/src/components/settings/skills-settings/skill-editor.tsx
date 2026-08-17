"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  skillMetadataSchema,
  type Skill,
  type SkillAssignmentInput,
  type SkillContentInput,
  type SkillFileInput,
} from "@open-inspect/shared/types/skills";
import {
  createSkill,
  previewSkill,
  replaceSkillContentAndAssignments,
} from "@/hooks/use-managed-skills";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos } from "@/hooks/use-repos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { assignmentKey, buildAssignments, SkillAssignments } from "./skill-assignments";
import { SkillFiles } from "./skill-files";
import { errorMessage } from "./shared";

export function SkillEditor({
  skill,
  creating,
  onSaved,
  onCancel,
}: {
  skill?: Skill;
  creating: boolean;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const { repos, loading: reposLoading, error: reposError } = useRepos();
  const {
    environments,
    loading: environmentsLoading,
    error: environmentsError,
  } = useEnvironments();
  const initialAssignments: SkillAssignmentInput[] = skill?.assignments.map((assignment) => {
    if (assignment.type === "global") return { type: "global" };
    if (assignment.type === "environment") {
      return { type: "environment", environmentId: assignment.environmentId };
    }
    return {
      type: "repository",
      repository: {
        repoOwner: assignment.repoOwner,
        repoName: assignment.repoName,
        baseBranch: null,
      },
    };
  }) ?? [{ type: "global" }];
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [license, setLicense] = useState(skill?.license ?? "");
  const [compatibility, setCompatibility] = useState(skill?.compatibility ?? "");
  const [metadataText, setMetadataText] = useState(() =>
    JSON.stringify(skill?.metadata ?? {}, null, 2)
  );
  const [files, setFiles] = useState<SkillFileInput[]>(
    skill?.files
      .filter(({ path }) => path !== "SKILL.md")
      .map(({ path, content, executable }) => ({ path, content, executable })) ?? []
  );
  const [assignmentKeys, setAssignmentKeys] = useState(
    () => new Set(initialAssignments.map(assignmentKey))
  );
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<{
    markdown: string;
    sha256: string;
    totalBytes: number;
  } | null>(null);

  const initialState = JSON.stringify({
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    body: skill?.body ?? "",
    license: skill?.license ?? "",
    compatibility: skill?.compatibility ?? "",
    metadataText: JSON.stringify(skill?.metadata ?? {}, null, 2),
    files:
      skill?.files
        .filter(({ path }) => path !== "SKILL.md")
        .map(({ path, content, executable }) => ({ path, content, executable })) ?? [],
    assignments: initialAssignments.map(assignmentKey).sort(),
  });
  const dirty =
    JSON.stringify({
      name,
      description,
      body,
      license,
      compatibility,
      metadataText,
      files,
      assignments: [...assignmentKeys].sort(),
    }) !== initialState;

  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (dirty) event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function parsedMetadata(): Record<string, string> {
    const value: unknown = JSON.parse(metadataText);
    const parsed = skillMetadataSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("Metadata must be a JSON object with string values");
    }
    return parsed.data;
  }

  const content: SkillContentInput = {
    description,
    body,
    license: license.trim() || null,
    compatibility: compatibility.trim() || null,
    metadata: {},
    files,
  };

  function toggleAssignment(key: string, checked: boolean) {
    setAssignmentKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function save() {
    if (reposLoading || environmentsLoading || reposError || environmentsError) return;
    setSaving(true);
    try {
      const saveContent = { ...content, metadata: parsedMetadata() };
      const assignments = buildAssignments(assignmentKeys, repos, environments, initialAssignments);
      if (creating) {
        const created = await createSkill({ name, content: saveContent, assignments });
        toast.success("Skill created");
        onSaved(created.id);
      } else if (skill) {
        const revised = await replaceSkillContentAndAssignments(skill.id, skill.currentRevisionId, {
          content: saveContent,
          assignments,
        });
        toast.success(`Saved revision ${revised.revisionNumber}`);
        onSaved(skill.id);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function preview() {
    try {
      const result = await previewSkill(name, { ...content, metadata: parsedMetadata() });
      setValidation({
        markdown: result.skillMarkdown,
        sha256: result.revisionSha256,
        totalBytes: result.totalBytes,
      });
      toast.success("Skill content is valid");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const assignmentsUnavailable = Boolean(
    reposLoading || environmentsLoading || reposError || environmentsError
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {creating ? "Create shared skill" : skill?.name}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Skills are installation-wide instructions and files available to agents.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved skill changes?")) onCancel();
          }}
        >
          Close
        </Button>
      </div>

      <div className="space-y-4 rounded border border-border-muted p-4">
        <div>
          <Label htmlFor="skill-name">Canonical name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(event) => setName(event.target.value.toLowerCase())}
            disabled={!creating}
            placeholder="deploy-service"
            className="mt-1 font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Lowercase letters, numbers, and single hyphens. The name cannot be changed later.
          </p>
        </div>
        <div>
          <Label htmlFor="skill-description">Description</Label>
          <Textarea
            id="skill-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            className="mt-1"
            placeholder="When and why the agent should use this skill"
          />
        </div>
        <div>
          <Label htmlFor="skill-body">Instructions</Label>
          <Textarea
            id="skill-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={12}
            className="mt-1 font-mono text-xs"
            placeholder="## Workflow"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="skill-license">License (optional)</Label>
            <Input
              id="skill-license"
              value={license}
              onChange={(event) => setLicense(event.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="skill-compatibility">Compatibility (optional)</Label>
            <Input
              id="skill-compatibility"
              value={compatibility}
              onChange={(event) => setCompatibility(event.target.value)}
              className="mt-1"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="skill-metadata">Metadata (JSON string map)</Label>
          <Textarea
            id="skill-metadata"
            value={metadataText}
            onChange={(event) => setMetadataText(event.target.value)}
            rows={4}
            className="mt-1 font-mono text-xs"
          />
        </div>
      </div>

      <div className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
        Managed skills are trusted instructions, not a permission boundary. Review scripts and
        content carefully because agents can use capabilities already available in the session.
      </div>

      {skill && (
        <div className="rounded border border-border-muted p-3 text-xs text-muted-foreground">
          Revision {skill.revisionNumber} by{" "}
          {skill.revisionAuthorDisplayName ?? skill.revisionCreatedBy}
          {" · "}created by {skill.creatorDisplayName ?? skill.createdBy}
          {" · "}last edited by {skill.lastEditorDisplayName ?? skill.updatedBy}
        </div>
      )}

      <SkillFiles files={files} onChange={setFiles} />
      {assignmentsUnavailable && (
        <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
          Assignment targets are still loading or failed to load. Saving is disabled to avoid
          removing them.
        </p>
      )}
      <SkillAssignments
        assignmentKeys={assignmentKeys}
        repos={repos}
        environments={environments}
        onToggle={toggleAssignment}
      />

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="subtle" onClick={preview} disabled={!name.trim() || !description.trim()}>
          Validate
        </Button>
        <Button
          onClick={save}
          disabled={saving || !name.trim() || !description.trim() || assignmentsUnavailable}
        >
          {saving ? "Saving..." : creating ? "Create skill" : "Save new revision"}
        </Button>
      </div>
      {validation && (
        <div className="rounded border border-border-muted p-4">
          <p className="text-xs text-muted-foreground">
            {validation.totalBytes.toLocaleString()} bytes · SHA-256 {validation.sha256}
          </p>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-3 text-xs">
            {validation.markdown}
          </pre>
        </div>
      )}
    </div>
  );
}
