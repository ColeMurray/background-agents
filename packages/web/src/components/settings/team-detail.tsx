"use client";

import { useEffect, useState, type FormEvent } from "react";
import { updateTeamRequestSchema } from "@open-inspect/shared/types/teams";
import type { TeamResponse } from "@/hooks/use-teams";
import { useTeam, useTeamMembers } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
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
import { ErrorBanner } from "@/components/ui/error-banner";
import { TeamMembersTable } from "./team-members-table";

type TeamDraft = Pick<TeamResponse, "name" | "slug" | "joinPolicy" | "defaultVisibility"> & {
  description: string;
};

function toDraft(team: TeamResponse): TeamDraft {
  return {
    name: team.name,
    slug: team.slug,
    description: team.description ?? "",
    joinPolicy: team.joinPolicy,
    defaultVisibility: team.defaultVisibility,
  };
}

function sameDraft(a: TeamDraft, b: TeamDraft): boolean {
  return (
    a.name === b.name &&
    a.slug === b.slug &&
    a.description === b.description &&
    a.joinPolicy === b.joinPolicy &&
    a.defaultVisibility === b.defaultVisibility
  );
}

export function TeamDetail({ team }: { team: TeamResponse }) {
  const capabilities = useTeamCapabilities(team);
  const { updateTeam, changeArchive } = useTeam(team.id);
  const { members, loading, error } = useTeamMembers(team.id);
  const [editor, setEditor] = useState(() => ({ saved: toDraft(team), draft: toDraft(team) }));
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const incoming = toDraft(team);
    setEditor((current) =>
      sameDraft(current.saved, current.draft) && !sameDraft(current.saved, incoming)
        ? { saved: incoming, draft: incoming }
        : current
    );
  }, [team]);

  async function run(action: () => Promise<unknown>) {
    setMessage(null);
    setSaving(true);
    try {
      await action();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Team update failed");
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!capabilities.canEditMetadata || saving) return;
    const { saved, draft } = editor;
    const patch = {
      ...(draft.name !== saved.name ? { name: draft.name.trim() } : {}),
      ...(draft.slug !== saved.slug ? { slug: draft.slug.trim() } : {}),
      ...(draft.description !== saved.description
        ? { description: draft.description.trim() || null }
        : {}),
      ...(draft.joinPolicy !== saved.joinPolicy ? { joinPolicy: draft.joinPolicy } : {}),
      ...(draft.defaultVisibility !== saved.defaultVisibility
        ? { defaultVisibility: draft.defaultVisibility }
        : {}),
    };
    const parsed = updateTeamRequestSchema.safeParse(patch);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setMessage(`${issue.path.join(".")}: ${issue.message}`);
      return;
    }
    if (Object.keys(parsed.data).length === 0) return;
    void run(async () => {
      const updated = toDraft(await updateTeam(parsed.data));
      setEditor({ saved: updated, draft: updated });
    });
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{team.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {team.slug} - {team.archivedAt ? "Archived" : "Active"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!capabilities.canArchive || saving}
            onClick={() => void run(() => changeArchive(!team.archivedAt))}
          >
            {team.archivedAt ? "Restore team" : "Archive team"}
          </Button>
        </div>
      </div>
      {message && <ErrorBanner>{message}</ErrorBanner>}
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Team details
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="detail-name">Name</Label>
            <Input
              id="detail-name"
              value={editor.draft.name}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) =>
                setEditor((current) => ({
                  ...current,
                  draft: { ...current.draft, name: event.target.value },
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="detail-slug">Slug</Label>
            <Input
              id="detail-slug"
              value={editor.draft.slug}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) =>
                setEditor((current) => ({
                  ...current,
                  draft: { ...current.draft, slug: event.target.value },
                }))
              }
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-description">Description</Label>
          <textarea
            id="team-description"
            value={editor.draft.description}
            disabled={!capabilities.canEditMetadata || saving}
            onChange={(event) =>
              setEditor((current) => ({
                ...current,
                draft: { ...current.draft, description: event.target.value },
              }))
            }
            className="min-h-20 w-full rounded border border-border bg-background p-2 text-sm disabled:opacity-50"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="join-policy">Join policy</Label>
            <Select
              value={editor.draft.joinPolicy}
              disabled={!capabilities.canEditMetadata || saving}
              onValueChange={(value) =>
                setEditor((current) => ({
                  ...current,
                  draft: {
                    ...current.draft,
                    joinPolicy: value === "open" ? "open" : "invite_only",
                  },
                }))
              }
            >
              <SelectTrigger id="join-policy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="invite_only">Invite only</SelectItem>
                <SelectItem value="open">Open</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-visibility">Default visibility</Label>
            <Select
              value={editor.draft.defaultVisibility}
              disabled={!capabilities.canEditMetadata || saving}
              onValueChange={(value) =>
                setEditor((current) => ({
                  ...current,
                  draft: {
                    ...current.draft,
                    defaultVisibility: value === "team" ? "team" : "workspace",
                  },
                }))
              }
            >
              <SelectTrigger id="default-visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">Workspace</SelectItem>
                <SelectItem value="team">Team</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Applies to new sessions only. Private is available per session, including within a
              team.
            </p>
          </div>
        </div>
        <Button type="submit" disabled={!capabilities.canEditMetadata || saving}>
          Save changes
        </Button>
      </form>
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Members - {team.memberCount}
        </h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading members...</p>
        ) : error ? (
          <ErrorBanner>Failed to load members.</ErrorBanner>
        ) : (
          <TeamMembersTable team={team} members={members} />
        )}
      </section>
    </div>
  );
}
