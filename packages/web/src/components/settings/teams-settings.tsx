"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { createTeamRequestSchema } from "@open-inspect/shared/types/teams";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useTeams } from "@/hooks/use-teams";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function TeamsSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const { teams, loading, error, createTeam } = useTeams();
  const canCreate = hasPermission("workspace.members.manage");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate || saving) return;
    const parsed = createTeamRequestSchema.safeParse({ name: name.trim(), slug: slug.trim() });
    if (!parsed.success) {
      setMessage(
        "Enter a name and a lowercase slug (2-63 letters, numbers or hyphens, starting with a letter or number)."
      );
      return;
    }
    setMessage(null);
    setSaving(true);
    try {
      await createTeam(parsed.data);
      setOpen(false);
      setName("");
      setSlug("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Failed to create team");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Teams</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Organize members and choose team defaults.
          </p>
        </div>
        <Button
          disabled={!canCreate}
          onClick={() => {
            setMessage(null);
            setOpen(true);
          }}
        >
          Create team
        </Button>
      </div>
      {loading && <p className="text-sm text-muted-foreground">Loading teams...</p>}
      {error && <ErrorBanner>Failed to load teams.</ErrorBanner>}
      {!loading && !error && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {teams.length === 0 && <p className="p-4 text-sm text-muted-foreground">No teams yet.</p>}
          {teams.map((team) => (
            <Link
              key={team.id}
              href={`/settings/teams/${encodeURIComponent(team.id)}`}
              className="flex flex-wrap items-center justify-between gap-2 p-4 transition hover:bg-muted/40"
            >
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{team.name}</span>
                <span className="block text-sm text-muted-foreground">{team.slug}</span>
              </span>
              <span className="text-sm text-muted-foreground">
                {team.memberCount} {team.memberCount === 1 ? "member" : "members"} -{" "}
                {team.archivedAt ? "Archived" : "Active"}
              </span>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>Creating a team makes you its first lead.</DialogDescription>
          <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="team-name">Name</Label>
              <Input
                id="team-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!canCreate || saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="team-slug">Slug</Label>
              <Input
                id="team-slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                disabled={!canCreate || saving}
              />
            </div>
            {message && <ErrorBanner>{message}</ErrorBanner>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canCreate || saving}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
