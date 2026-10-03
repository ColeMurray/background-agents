import type { z } from "zod";
import { teamCapabilitiesSchema } from "@open-inspect/shared/types/teams";

type TeamCapabilities = z.infer<typeof teamCapabilitiesSchema>;

const DENIED: TeamCapabilities = {
  canReadTeamSessions: false,
  canReadTeamRepositories: false,
  canReadTeamEnvironments: false,
  canReadAutomations: false,
  canJoin: false,
  canLeave: false,
  canEditMetadata: false,
  canManageMembers: false,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageEnvironments: false,
  canManageSecrets: false,
  canArchive: false,
};

/** Reads server-computed capabilities; missing required fields cannot grant controls. */
export function useTeamCapabilities(
  team: { capabilities?: Partial<TeamCapabilities> | null } | null | undefined
): TeamCapabilities {
  const parsed = teamCapabilitiesSchema.safeParse(team?.capabilities);
  return parsed.success ? parsed.data : DENIED;
}
