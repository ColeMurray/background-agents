import type { z } from "zod";
import { teamCapabilitiesSchema } from "@open-inspect/shared/types/teams";

type TeamCapabilities = z.infer<typeof teamCapabilitiesSchema>;

const DENIED: TeamCapabilities = {
  canJoin: false,
  canLeave: false,
  canEditMetadata: false,
  canManageMembers: false,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageSecrets: false,
  canArchive: false,
};

/** Reads server-computed capabilities; absent or incomplete responses cannot grant controls. */
export function useTeamCapabilities(
  team: { capabilities?: Partial<TeamCapabilities> | null } | null | undefined
): TeamCapabilities {
  const parsed = teamCapabilitiesSchema.safeParse(team?.capabilities);
  return parsed.success ? parsed.data : DENIED;
}
