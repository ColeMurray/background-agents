"use client";

import { SecretsEditor } from "@/components/secrets-editor";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import type { TeamResponse } from "@/hooks/use-teams";

export function TeamSecrets({
  teamId,
  capabilities,
}: {
  teamId: string;
  capabilities?: TeamResponse["capabilities"];
}) {
  const { canManageSecrets } = useTeamCapabilities({ capabilities });
  if (!canManageSecrets) return null;
  return <SecretsEditor key={teamId} scope="team" teamId={teamId} />;
}
