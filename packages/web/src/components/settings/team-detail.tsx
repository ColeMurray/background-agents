"use client";

import { useState, type FormEvent } from "react";
import type { TeamResponse } from "@/hooks/use-teams";
import { useTeam, useTeamMembers } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TeamMembersTable } from "./team-members-table";

export function TeamDetail({ team }: { team: TeamResponse }) {
  const capabilities = useTeamCapabilities(team);
  const { updateTeam, changeArchive, joinTeam } = useTeam(team.id);
  const { members, loading, error } = useTeamMembers(team.id);
  const [name, setName] = useState(team.name);
  const [slug, setSlug] = useState(team.slug);
  const [description, setDescription] = useState(team.description ?? "");
  const [joinPolicy, setJoinPolicy] = useState(team.joinPolicy);
  const [visibility, setVisibility] = useState(team.defaultVisibility);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
    void run(() =>
      updateTeam({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null,
        joinPolicy,
        defaultVisibility: visibility,
      })
    );
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
          {capabilities.canJoin && (
            <Button disabled={saving} onClick={() => void run(joinTeam)}>
              Join team
            </Button>
          )}
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
              value={name}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="detail-slug">Slug</Label>
            <Input
              id="detail-slug"
              value={slug}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) => setSlug(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-description">Description</Label>
          <textarea
            id="team-description"
            value={description}
            disabled={!capabilities.canEditMetadata || saving}
            onChange={(event) => setDescription(event.target.value)}
            className="min-h-20 w-full rounded border border-border bg-background p-2 text-sm disabled:opacity-50"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="join-policy">Join policy</Label>
            <select
              id="join-policy"
              value={joinPolicy}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) =>
                setJoinPolicy(event.target.value === "open" ? "open" : "invite_only")
              }
              className="w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
            >
              <option value="invite_only">Invite only</option>
              <option value="open">Open</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-visibility">Default visibility</Label>
            <select
              id="default-visibility"
              value={visibility}
              disabled={!capabilities.canEditMetadata || saving}
              onChange={(event) =>
                setVisibility(
                  event.target.value === "team"
                    ? "team"
                    : event.target.value === "private"
                      ? "private"
                      : "workspace"
                )
              }
              className="w-full rounded border border-border bg-background px-2 py-2 text-sm disabled:opacity-50"
            >
              <option value="workspace">Workspace</option>
              <option value="team">Team</option>
              <option value="private">Private</option>
            </select>
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
