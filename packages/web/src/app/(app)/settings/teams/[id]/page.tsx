"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { TeamDetail } from "@/components/settings/team-detail";
import { SettingsMobileHeader } from "@/components/settings/settings-mobile-header";
import { useSettingsIsMobile } from "@/components/settings/settings-viewport-context";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useTeam } from "@/hooks/use-teams";

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { team, loading, error } = useTeam(id);
  const isMobile = useSettingsIsMobile();
  const content = loading ? (
    <p>Loading team...</p>
  ) : error || !team ? (
    <ErrorBanner>Team not found.</ErrorBanner>
  ) : (
    <TeamDetail key={`${team.id}:${team.updatedAt}`} team={team} />
  );

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-background">
        <SettingsMobileHeader
          title={team?.name ?? "Team"}
          backHref="/settings?tab=teams"
          backLabel="Back to Teams"
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl">{content}</div>
        </div>
      </div>
    );
  }
  return (
    <>
      <Link
        href="/settings?tab=teams"
        className="mb-6 block text-sm text-muted-foreground hover:text-foreground"
      >
        Back to Teams
      </Link>
      {content}
    </>
  );
}
