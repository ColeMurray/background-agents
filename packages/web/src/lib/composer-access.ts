import { z } from "zod";
import {
  sessionVisibilitySchema,
  type SessionVisibility,
  type TeamDefaultVisibility,
} from "@open-inspect/shared/types/teams";

export interface ComposerAccessDraft {
  contextKey: string;
  teamId: string | null;
  visibility: SessionVisibility;
}

const storedComposerAccessSchema = z.object({
  contextKey: z.string(),
  teamId: z.string().nullable(),
  visibility: sessionVisibilitySchema,
});

export function parseStoredComposerAccess(value: string | null): ComposerAccessDraft | null {
  if (value === null) return null;
  try {
    const parsed = storedComposerAccessSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function resolveComposerAccess(
  context: {
    activeTeamId: string | null;
    scope: "workspace" | "all" | undefined;
    requireTeamOnCreate: boolean;
    teams: readonly { id: string; defaultVisibility: TeamDefaultVisibility }[];
  },
  draft: ComposerAccessDraft | null
): ComposerAccessDraft {
  const contextKey = context.activeTeamId ?? context.scope ?? "all-my-teams";
  const current = draft?.contextKey === contextKey ? draft : null;
  const selectedId = current ? current.teamId : context.activeTeamId;
  const team =
    context.teams.find((team) => team.id === selectedId) ??
    (context.requireTeamOnCreate ? context.teams[0] : undefined);
  const teamId = team?.id ?? null;
  const visibility =
    current && (current.visibility !== "team" || teamId !== null)
      ? current.visibility
      : (team?.defaultVisibility ?? "workspace");
  if (current?.teamId === teamId && current.visibility === visibility) return current;
  return { contextKey, teamId, visibility };
}
