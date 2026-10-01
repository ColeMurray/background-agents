"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useMeTeams,
  useTeam,
  useTeamMembers,
  useTeams,
  type TeamResponse,
} from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { TeamMembersTable } from "@/components/settings/team-members-table";
import { TeamDetail } from "@/components/settings/team-detail";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TeamOverview } from "./team-overview";
import { TeamChannels } from "./team-channels";

type TeamTab = "Overview" | "Members" | "Channels" | "Settings";

export function TeamPage({ slug }: { slug: string }) {
  const { teams, loading, error } = useTeams();
  const mine = useMeTeams();
  const { authorization } = useCurrentUserAuthorization();
  const team = teams.find((candidate) => candidate.slug === slug && candidate.archivedAt === null);
  const role = authorization?.role.key;
  const admin =
    authorization?.suspendedAt === null && (role === "owner" || role === "administrator");
  const member =
    authorization?.suspendedAt === null &&
    !mine.loading &&
    !mine.error &&
    mine.teams.some((membership) => membership.id === team?.id);

  if (loading)
    return (
      <p role="status" className="py-12 text-center text-sm text-muted-foreground">
        Loading team...
      </p>
    );
  if (error) return <ErrorBanner role="alert">Unable to load team.</ErrorBanner>;
  if (!team) return <p className="text-sm text-muted-foreground">Team not found.</p>;
  return <TeamContent key={team.id} initialTeam={team} canViewWork={admin || member} />;
}

function TeamContent({
  initialTeam,
  canViewWork,
}: {
  initialTeam: TeamResponse;
  canViewWork: boolean;
}) {
  const { team: currentTeam, error } = useTeam(initialTeam.id);
  const team = currentTeam ?? initialTeam;
  const capabilities = useTeamCapabilities(team);
  const [tab, setTab] = useState<TeamTab>("Overview");
  const tabs: TeamTab[] = canViewWork ? ["Overview", "Members", "Channels"] : ["Members"];
  if (canViewWork && (capabilities.canEditMetadata || capabilities.canArchive))
    tabs.push("Settings");
  const activeTab = tabs.includes(tab) ? tab : "Members";

  if (error) return <ErrorBanner role="alert">Unable to load team.</ErrorBanner>;
  if (team.archivedAt !== null)
    return <p className="text-sm text-muted-foreground">Team not found.</p>;
  return (
    <section aria-labelledby="team-heading">
      <Link href="/teams" className="text-sm text-muted-foreground hover:text-foreground">
        Teams
      </Link>
      <div className="mt-4 mb-6">
        <h1
          id="team-heading"
          className="break-words text-2xl font-semibold text-foreground sm:text-3xl"
        >
          {team.name}
        </h1>
        {team.description && (
          <p className="mt-2 break-words text-sm text-muted-foreground">{team.description}</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {team.memberCount} {team.memberCount === 1 ? "member" : "members"} /{" "}
          {team.joinPolicy === "open" ? "Open to join" : "Invite only"}
        </p>
      </div>
      <nav
        aria-label="Team tabs"
        className="mb-6 flex flex-wrap gap-2 border-b border-border-muted pb-3"
      >
        {tabs.map((value) => (
          <Button
            key={value}
            variant={activeTab === value ? "subtle" : "ghost"}
            aria-current={activeTab === value ? "page" : undefined}
            onClick={() => setTab(value)}
          >
            {value}
          </Button>
        ))}
      </nav>
      {activeTab === "Overview" && <TeamOverview teamId={team.id} />}
      {activeTab === "Members" && <TeamMembers team={team} />}
      {activeTab === "Channels" && <TeamChannels team={team} />}
      {activeTab === "Settings" && <TeamDetail team={team} />}
    </section>
  );
}

function TeamMembers({ team }: { team: TeamResponse }) {
  const { members, loading, error } = useTeamMembers(team.id);
  return loading ? (
    <p role="status" className="text-sm text-muted-foreground">
      Loading members...
    </p>
  ) : error ? (
    <ErrorBanner role="alert">Unable to load members.</ErrorBanner>
  ) : (
    <TeamMembersTable team={team} members={members} />
  );
}
