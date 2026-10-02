"use client";

import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  isRetryableTeamError,
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
import { TeamRepositories } from "./team-repositories";
import { TeamEnvironments } from "./team-environments";
import { TeamAutomations } from "./team-automations";
import { TeamSecrets } from "./team-secrets";

type TeamTab =
  | "Overview"
  | "Members"
  | "Repositories"
  | "Environments"
  | "Automations"
  | "Secrets"
  | "Settings";

export function TeamPage({ slug }: { slug: string }) {
  const { teams, loading, error } = useTeams();
  const mine = useMeTeams();
  const { authorization, hasPermission } = useCurrentUserAuthorization();
  const [shownTeam, setShownTeam] = useState<{ id: string | null; routeSlug: string }>({
    id: null,
    routeSlug: slug,
  });
  // Retain identity on the current route, even when another team reuses its slug.
  const team =
    (shownTeam.routeSlug === slug
      ? teams.find((candidate) => candidate.id === shownTeam.id && candidate.archivedAt === null)
      : undefined) ??
    teams.find((candidate) => candidate.slug === slug && candidate.archivedAt === null);
  if (shownTeam.routeSlug !== slug || (team && team.id !== shownTeam.id)) {
    setShownTeam({ id: team?.id ?? null, routeSlug: slug });
  }
  const role = authorization?.role.key;
  const admin = authorization?.suspendedAt === null && isWorkspaceAdmin(role);
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
  if (error && (!team || !isRetryableTeamError(error)))
    return <ErrorBanner role="alert">Unable to load team.</ErrorBanner>;
  if (!team) return <p className="text-sm text-muted-foreground">Team not found.</p>;
  return (
    <TeamContent
      key={team.id}
      initialTeam={team}
      slug={slug}
      canViewWork={admin || member}
      canReadAutomations={hasPermission("automations.read")}
    />
  );
}

function TeamContent({
  initialTeam,
  slug,
  canViewWork,
  canReadAutomations,
}: {
  initialTeam: TeamResponse;
  slug: string;
  canViewWork: boolean;
  canReadAutomations: boolean;
}) {
  const router = useRouter();
  const { team: currentTeam, error } = useTeam(initialTeam.id);
  // The ID-keyed detail cache holds the PATCH response even when directory reads lag.
  const canonicalSlug = !error && currentTeam?.archivedAt === null ? currentTeam.slug : undefined;
  useEffect(() => {
    if (canonicalSlug && canonicalSlug !== slug)
      router.replace(`/teams/${encodeURIComponent(canonicalSlug)}`);
  }, [router, slug, canonicalSlug]);
  const team = currentTeam ?? initialTeam;
  const capabilities = useTeamCapabilities(team);
  const [tab, setTab] = useState<TeamTab>("Overview");
  const tabs: TeamTab[] = canViewWork
    ? ["Overview", "Members", "Repositories", "Environments"]
    : ["Members"];
  if (canViewWork && canReadAutomations) tabs.push("Automations");
  if (canViewWork && capabilities.canManageSecrets) tabs.push("Secrets");
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
      {activeTab === "Repositories" && <TeamRepositories team={team} />}
      {activeTab === "Environments" && <TeamEnvironments teamId={team.id} />}
      {activeTab === "Automations" && <TeamAutomations teamId={team.id} />}
      {activeTab === "Secrets" && canViewWork && capabilities.canManageSecrets && (
        <TeamSecrets teamId={team.id} capabilities={team.capabilities} />
      )}
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
