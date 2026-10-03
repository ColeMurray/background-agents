import type { z } from "zod";
import { workspaceTeamCapabilitiesSchema } from "@open-inspect/shared/types/teams";

type WorkspaceTeamCapabilities = z.infer<typeof workspaceTeamCapabilitiesSchema>;

const DENIED: WorkspaceTeamCapabilities = { canListAllTeams: false };

/** Reads server-computed workspace capabilities; missing responses cannot grant controls. */
export function useWorkspaceTeamCapabilities(
  workspace: { capabilities?: Partial<WorkspaceTeamCapabilities> | null } | null | undefined
): WorkspaceTeamCapabilities {
  const parsed = workspaceTeamCapabilitiesSchema.safeParse(workspace?.capabilities);
  return parsed.success ? parsed.data : DENIED;
}
