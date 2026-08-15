"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  Skill,
  SkillAssignmentInput,
  SkillContentInput,
  SkillFileInput,
  SkillProfile,
} from "@open-inspect/shared/types/skills";
import {
  createSkill,
  createSkillProfile,
  deleteSkill,
  deleteSkillProfile,
  editSkill,
  previewSkill,
  updateSkill,
  updateSkillProfile,
  useSkill,
  useSkillProfiles,
  useSkills,
} from "@/hooks/use-managed-skills";
import { useRepos } from "@/hooks/use-repos";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { PlusIcon, SparkleIcon, XIcon } from "@/components/ui/icons";

type View = "skills" | "profiles";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function ScopeCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <span className="truncate">{children}</span>
    </label>
  );
}

function assignmentKey(assignment: SkillAssignmentInput): string {
  if (assignment.type === "global") return "global";
  if (assignment.type === "environment") return `environment:${assignment.environmentId}`;
  return `repository:${assignment.repository.repoOwner}/${assignment.repository.repoName}`;
}

function SkillEditor({
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
  const { repos, error: reposError } = useRepos();
  const { environments, error: environmentsError } = useEnvironments();
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
  const currentState = JSON.stringify({
    name,
    description,
    body,
    license,
    compatibility,
    metadataText,
    files,
    assignments: [...assignmentKeys].sort(),
  });
  const dirty = currentState !== initialState;

  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function parsedMetadata(): Record<string, string> {
    const value: unknown = JSON.parse(metadataText);
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      Object.values(value).some((item) => typeof item !== "string")
    ) {
      throw new Error("Metadata must be a JSON object with string values");
    }
    return value as Record<string, string>;
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

  function assignments(): SkillAssignmentInput[] {
    const result: SkillAssignmentInput[] = [];
    if (assignmentKeys.has("global")) result.push({ type: "global" });
    for (const repo of repos) {
      if (assignmentKeys.has(`repository:${repo.owner}/${repo.name}`)) {
        result.push({
          type: "repository",
          repository: { repoOwner: repo.owner, repoName: repo.name, baseBranch: null },
        });
      }
    }
    for (const environment of environments) {
      if (assignmentKeys.has(`environment:${environment.id}`)) {
        result.push({ type: "environment", environmentId: environment.id });
      }
    }
    for (const assignment of initialAssignments) {
      if (
        assignmentKeys.has(assignmentKey(assignment)) &&
        !result.some((item) => assignmentKey(item) === assignmentKey(assignment))
      ) {
        result.push(assignment);
      }
    }
    return result;
  }

  async function save() {
    setSaving(true);
    try {
      const saveContent = { ...content, metadata: parsedMetadata() };
      if (creating) {
        const created = await createSkill({
          name,
          content: saveContent,
          assignments: assignments(),
        });
        toast.success("Skill created");
        onSaved(created.id);
      } else if (skill) {
        const revised = await editSkill(skill.id, skill.currentRevisionId, {
          content: saveContent,
          assignments: assignments(),
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
        sha256: result.contentSha256,
        totalBytes: result.totalBytes,
      });
      toast.success("Skill content is valid");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

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
              onChange={(e) => setLicense(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="skill-compatibility">Compatibility (optional)</Label>
            <Input
              id="skill-compatibility"
              value={compatibility}
              onChange={(e) => setCompatibility(e.target.value)}
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

      <div className="rounded border border-border-muted p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-foreground">Supporting files</h4>
            <p className="text-xs text-muted-foreground">
              Add references, assets, or scripts used by the skill.
            </p>
          </div>
          <Button
            type="button"
            size="xs"
            variant="subtle"
            onClick={() => setFiles([...files, { path: "", content: "", executable: false }])}
          >
            <PlusIcon className="h-3.5 w-3.5" /> Add file
          </Button>
        </div>
        <div className="space-y-3">
          {(reposError || environmentsError) && (
            <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">
              Some assignment targets failed to load. Saving is disabled to avoid removing them.
            </p>
          )}
          {files.length === 0 && (
            <p className="text-sm text-muted-foreground">No supporting files.</p>
          )}
          {files.map((file, index) => (
            <div key={index} className="rounded bg-muted/40 p-3">
              <div className="flex gap-2">
                <Input
                  aria-label={`File ${index + 1} path`}
                  value={file.path}
                  onChange={(e) => {
                    const path = e.target.value;
                    setFiles(
                      files.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              path,
                              executable: path.startsWith("scripts/") && item.executable,
                            }
                          : item
                      )
                    );
                  }}
                  placeholder="references/example.md"
                  className="h-8 flex-1 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setFiles(files.filter((_, i) => i !== index))}
                  aria-label={`Remove file ${index + 1}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
              <Textarea
                aria-label={`File ${index + 1} content`}
                value={file.content}
                onChange={(e) =>
                  setFiles(
                    files.map((item, i) =>
                      i === index ? { ...item, content: e.target.value } : item
                    )
                  )
                }
                rows={5}
                className="mt-2 font-mono text-xs"
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={file.executable}
                  disabled={!file.path.startsWith("scripts/")}
                  onCheckedChange={(value) =>
                    setFiles(
                      files.map((item, i) =>
                        i === index ? { ...item, executable: value === true } : item
                      )
                    )
                  }
                />
                Executable (scripts/ only)
              </label>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-border-muted p-4">
        <h4 className="text-sm font-medium text-foreground">Assignments</h4>
        <p className="mb-3 text-xs text-muted-foreground">
          A skill applies when any assignment matches the session target.
        </p>
        <div className="space-y-3">
          <ScopeCheckbox
            checked={assignmentKeys.has("global")}
            onChange={(value) => toggleAssignment("global", value)}
          >
            All sessions (global)
          </ScopeCheckbox>
          {repos.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Repositories
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {repos.map((repo) => (
                  <ScopeCheckbox
                    key={repo.fullName}
                    checked={assignmentKeys.has(`repository:${repo.owner}/${repo.name}`)}
                    onChange={(value) =>
                      toggleAssignment(`repository:${repo.owner}/${repo.name}`, value)
                    }
                  >
                    {repo.fullName}
                  </ScopeCheckbox>
                ))}
              </div>
            </div>
          )}
          {environments.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Environments
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {environments.map((environment) => (
                  <ScopeCheckbox
                    key={environment.id}
                    checked={assignmentKeys.has(`environment:${environment.id}`)}
                    onChange={(value) => toggleAssignment(`environment:${environment.id}`, value)}
                  >
                    {environment.name}
                  </ScopeCheckbox>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="subtle" onClick={preview} disabled={!name.trim() || !description.trim()}>
          Validate
        </Button>
        <Button
          onClick={save}
          disabled={
            saving ||
            !name.trim() ||
            !description.trim() ||
            Boolean(reposError || environmentsError)
          }
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

function SkillsCatalog() {
  const { skills, loading, error, mutate } = useSkills();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const {
    skill,
    loading: loadingSkill,
    error: skillError,
    mutate: mutateSkill,
  } = useSkill(selectedId);

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      await updateSkill(id, { enabled });
      await mutate();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete ${name}? Existing sessions keep their pinned copy.`)) return;
    try {
      await deleteSkill(id);
      if (selectedId === id) setSelectedId(null);
      await mutate();
      toast.success("Skill deleted");
    } catch (error) {
      toast.error(errorMessage(error));
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
          await mutate();
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
          await Promise.all([mutate(), mutateSkill()]);
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
        <Button size="sm" onClick={() => setCreating(true)}>
          <PlusIcon className="h-4 w-4" /> New skill
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">Failed to load managed skills.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading skills...</p>
      ) : skills.length === 0 ? (
        <div className="rounded border border-dashed border-border p-8 text-center">
          <SparkleIcon className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm text-foreground">No shared skills yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to give agents consistent workflows and context.
          </p>
        </div>
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
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {item.description}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {item.assignments.length} assignment{item.assignments.length === 1 ? "" : "s"}
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
    </div>
  );
}

function ProfileForm({ profile, onDone }: { profile?: SkillProfile; onDone: () => void }) {
  const { skills } = useSkills();
  const { mutate } = useSkillProfiles();
  const [name, setName] = useState(profile?.name ?? "");
  const [skillIds, setSkillIds] = useState(() => new Set(profile?.skillIds ?? []));
  const [saving, setSaving] = useState(false);
  const dirty =
    name !== (profile?.name ?? "") ||
    JSON.stringify([...skillIds].sort()) !== JSON.stringify([...(profile?.skillIds ?? [])].sort());

  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    try {
      const availableSkillIds = new Set(skills.map((skill) => skill.id));
      const input = { name, skillIds: [...skillIds].filter((id) => availableSkillIds.has(id)) };
      if (profile) await updateSkillProfile(profile.id, input);
      else await createSkillProfile(input);
      await mutate();
      toast.success(profile ? "Profile updated" : "Profile created");
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-border-muted p-4">
      <h4 className="text-sm font-medium text-foreground">
        {profile ? "Edit profile" : "New profile"}
      </h4>
      <Label htmlFor="profile-name" className="mt-4 block">
        Name
      </Label>
      <Input
        id="profile-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mt-1"
        placeholder="Frontend work"
      />
      <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Included skills
      </p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {skills.map((item) => (
          <ScopeCheckbox
            key={item.id}
            checked={skillIds.has(item.id)}
            onChange={(checked) =>
              setSkillIds((current) => {
                const next = new Set(current);
                if (checked) next.add(item.id);
                else next.delete(item.id);
                return next;
              })
            }
          >
            {item.name}
            {item.enabled ? "" : " (disabled)"}
          </ScopeCheckbox>
        ))}
        {skills.length === 0 && (
          <p className="text-sm text-muted-foreground">Create a shared skill first.</p>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="subtle"
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved profile changes?")) onDone();
          }}
        >
          Cancel
        </Button>
        <Button onClick={save} disabled={saving || !name.trim()}>
          {saving ? "Saving..." : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

function Profiles() {
  const { profiles, loading, error, mutate } = useSkillProfiles();
  const { skills } = useSkills();
  const [editing, setEditing] = useState<SkillProfile | "new" | null>(null);
  if (editing)
    return (
      <ProfileForm
        profile={editing === "new" ? undefined : editing}
        onDone={() => setEditing(null)}
      />
    );

  async function remove(profile: SkillProfile) {
    if (!window.confirm(`Delete profile ${profile.name}?`)) return;
    try {
      await deleteSkillProfile(profile.id);
      await mutate();
      toast.success("Profile deleted");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-foreground">My profiles</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Save personal skill sets for session creation.
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>
          <PlusIcon className="h-4 w-4" /> New profile
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">Failed to load skill profiles.</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading profiles...</p>
      ) : profiles.length === 0 ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No personal profiles yet.
        </div>
      ) : (
        <div className="divide-y divide-border-muted rounded border border-border-muted">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex items-center gap-3 p-4">
              <button
                type="button"
                onClick={() => setEditing(profile)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm font-medium text-foreground">{profile.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {profile.skillIds.length} skill{profile.skillIds.length === 1 ? "" : "s"}:{" "}
                  {profile.skillIds
                    .map((id) => skills.find((skill) => skill.id === id)?.name ?? "Unavailable")
                    .join(", ") || "None"}
                </p>
              </button>
              <Button variant="ghost" size="xs" onClick={() => remove(profile)}>
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SkillsSettings() {
  const [view, setView] = useState<View>("skills");
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground">Skills</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control the managed capabilities installed into new sessions.
        </p>
      </div>
      <div className="mb-6 flex border-b border-border-muted">
        {(["skills", "profiles"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setView(item)}
            className={`border-b-2 px-4 py-2 text-sm transition ${view === item ? "border-accent text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {item === "skills" ? "Shared skills" : "My profiles"}
          </button>
        ))}
      </div>
      {view === "skills" ? <SkillsCatalog /> : <Profiles />}
    </div>
  );
}
