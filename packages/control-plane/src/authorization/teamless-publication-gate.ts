import type { PublicationSession } from "./callback-publication-scope";

export type TeamlessPublicationDenial =
  "missing_session" | "private_session" | "non_workspace_session" | "team_owned_session";

/** Destinations without team bindings may publish only teamless workspace sessions. */
export function teamlessPublicationGate(
  session: PublicationSession | null
): TeamlessPublicationDenial | null {
  if (!session) return "missing_session";
  if (session.visibility === "private") return "private_session";
  if (session.visibility !== "workspace") return "non_workspace_session";
  if (session.ownerTeamId !== null) return "team_owned_session";
  return null;
}
