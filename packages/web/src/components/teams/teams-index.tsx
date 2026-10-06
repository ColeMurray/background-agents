"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useMeTeams, useTeams } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { useAuthSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { TeamResponse } from "@/hooks/use-teams";

export function TeamsIndex() {
  const all = useTeams();
  const mine = useMeTeams();
  const { data: session } = useAuthSession();
  const storageKey = `open-inspect-team-favorites:${session?.user?.id ?? ""}`;
  const [favorites, setFavorites] = useState<string[]>([]);
  const [view, setView] = useState<"mine" | "all">("mine");
  const [search, setSearch] = useState("");
  const [joining, setJoining] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
      setFavorites(
        Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []
      );
    } catch {
      setFavorites([]);
    }
  }, [storageKey]);

  function toggleFavorite(id: string) {
    const next = favorites.includes(id)
      ? favorites.filter((value) => value !== id)
      : [...favorites, id];
    setFavorites(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Favorites still work for this visit when browser storage is unavailable.
    }
  }

  async function join(id: string) {
    setJoining(id);
    setMessage(null);
    try {
      await all.joinTeam(id);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Unable to join team");
    } finally {
      setJoining(null);
    }
  }

  const source = view === "mine" ? mine : all;
  const query = search.trim().toLowerCase();
  const teams = source.teams
    .filter(
      (team) =>
        team.archivedAt === null &&
        [team.name, team.slug, team.description ?? ""].some((value) =>
          value.toLowerCase().includes(query)
        )
    )
    .sort(
      (a, b) =>
        Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) ||
        a.name.localeCompare(b.name)
    );

  return (
    <section aria-labelledby="teams-heading">
      <h1 id="teams-heading" className="text-2xl font-semibold text-foreground sm:text-3xl">
        Teams
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Find your teams and discover shared work across the workspace.
      </p>
      <div className="my-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2" aria-label="Team membership filter">
          <Button
            variant={view === "mine" ? "subtle" : "ghost"}
            aria-pressed={view === "mine"}
            onClick={() => setView("mine")}
          >
            My teams
          </Button>
          <Button
            variant={view === "all" ? "subtle" : "ghost"}
            aria-pressed={view === "all"}
            onClick={() => setView("all")}
          >
            All teams
          </Button>
        </div>
        <Input
          type="search"
          aria-label="Search teams"
          placeholder="Search teams"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="sm:max-w-xs"
        />
      </div>
      {message && (
        <ErrorBanner className="mb-4" role="alert">
          {message}
        </ErrorBanner>
      )}
      {source.error && (
        <ErrorBanner className="mb-4" role="alert">
          Unable to load teams.
        </ErrorBanner>
      )}
      {source.loading ? (
        <p className="py-12 text-center text-sm text-muted-foreground" role="status">
          Loading teams...
        </p>
      ) : !source.error && teams.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            {query
              ? "No matching teams"
              : view === "mine"
                ? "You have not joined any teams"
                : "No active teams"}
          </p>
          {view === "mine" && !query && (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setView("all")}>
              Browse all teams
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border-muted rounded-md border border-border-muted">
          {teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              favorite={favorites.includes(team.id)}
              onFavorite={() => toggleFavorite(team.id)}
              onJoin={() => void join(team.id)}
              joining={joining !== null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamRow({
  team,
  favorite,
  onFavorite,
  onJoin,
  joining,
}: {
  team: TeamResponse;
  favorite: boolean;
  onFavorite: () => void;
  onJoin: () => void;
  joining: boolean;
}) {
  const capabilities = useTeamCapabilities(team);
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
      <div className="min-w-0 flex-1">
        <Link
          href={`/teams/${encodeURIComponent(team.slug)}`}
          className="break-words font-medium text-foreground hover:underline"
        >
          {team.name}
        </Link>
        {team.description && (
          <p className="mt-1 text-sm text-muted-foreground break-words">{team.description}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
          </span>
          <span>{team.joinPolicy === "open" ? "Open to join" : "Invite only"}</span>
          <span>{team.slug}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${team.name}`}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <svg
            className="size-4"
            viewBox="0 0 24 24"
            fill={favorite ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z" />
          </svg>
        </Button>
        {capabilities.canJoin && (
          <Button variant="outline" size="sm" disabled={joining} onClick={onJoin}>
            Join team
          </Button>
        )}
      </div>
    </li>
  );
}
