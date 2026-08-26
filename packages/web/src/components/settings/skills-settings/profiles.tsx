"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { SkillProfile, SkillSummary } from "@open-inspect/shared/types/skills";
import {
  createSkillProfile,
  deleteSkillProfile,
  updateSkillProfile,
  useSkillProfiles,
  useSkills,
} from "@/hooks/use-managed-skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlusIcon } from "@/components/ui/icons";
import { ScopeCheckbox } from "./shared";
import { errorMessage } from "./utils";

interface ProfileFormProps {
  profile?: SkillProfile;
  skills: SkillSummary[];
  skillsLoading: boolean;
  skillsError: unknown;
  onDone: () => void;
}

export function ProfileForm({
  profile,
  skills,
  skillsLoading,
  skillsError,
  onDone,
}: ProfileFormProps) {
  const { mutate } = useSkillProfiles();
  const [name, setName] = useState(profile?.name ?? "");
  const [skillIds, setSkillIds] = useState(() => new Set(profile?.skillIds ?? []));
  const [saving, setSaving] = useState(false);
  const dirty =
    name !== (profile?.name ?? "") ||
    JSON.stringify([...skillIds].sort()) !== JSON.stringify([...(profile?.skillIds ?? [])].sort());

  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (dirty) event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (skillsLoading || skillsError) return;
    setSaving(true);
    try {
      const availableSkillIds = new Set(skills.map((skill) => skill.id));
      const input = { name, skillIds: [...skillIds].filter((id) => availableSkillIds.has(id)) };
      if (profile) await updateSkillProfile(profile.id, input);
      else await createSkillProfile(input);
      await mutate();
      toast.success(profile ? "Profile updated" : "Profile created");
      onDone();
    } catch (requestError) {
      toast.error(errorMessage(requestError));
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
        onChange={(event) => setName(event.target.value)}
        className="mt-1"
        placeholder="Frontend work"
      />
      <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Included skills
      </p>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {skillsError ? (
          <p role="alert" className="text-sm text-destructive">
            Failed to load managed skills. Profile editing is unavailable.
          </p>
        ) : skillsLoading ? (
          <p className="text-sm text-muted-foreground">Loading skills...</p>
        ) : (
          <>
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
          </>
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
        <Button
          onClick={save}
          disabled={saving || skillsLoading || Boolean(skillsError) || !name.trim()}
        >
          {saving ? "Saving..." : "Save profile"}
        </Button>
      </div>
    </div>
  );
}

export function Profiles() {
  const { profiles, loading, error, mutate } = useSkillProfiles();
  const { skills, loading: skillsLoading, error: skillsError } = useSkills();
  const [editing, setEditing] = useState<SkillProfile | "new" | null>(null);
  if (editing) {
    return (
      <ProfileForm
        profile={editing === "new" ? undefined : editing}
        skills={skills}
        skillsLoading={skillsLoading}
        skillsError={skillsError}
        onDone={() => setEditing(null)}
      />
    );
  }

  async function remove(profile: SkillProfile) {
    if (!window.confirm(`Delete profile ${profile.name}?`)) return;
    try {
      await deleteSkillProfile(profile.id);
      await mutate();
      toast.success("Profile deleted");
    } catch (requestError) {
      toast.error(errorMessage(requestError));
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
                  {skillsLoading
                    ? "Loading skill names..."
                    : skillsError
                      ? "Skill names could not be loaded"
                      : profile.skillIds
                          .map(
                            (id) => skills.find((skill) => skill.id === id)?.name ?? "Unavailable"
                          )
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
