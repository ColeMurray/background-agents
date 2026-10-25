import type { PublicationSession } from "./callback-publication-scope";

export type SlackPostSession = PublicationSession;
export interface SlackPostChannelBinding {
  teamId: string;
}

export type SlackPostDenial = "missing_session" | "private_session" | "channel_team_mismatch";

/** Team publication requires a current matching binding, regardless of visibility. */
export function slackPostGate(
  session: SlackPostSession | null,
  binding: SlackPostChannelBinding | null
): SlackPostDenial | null {
  if (!session) return "missing_session";
  if (session.visibility === "private") return "private_session";
  if ((binding?.teamId ?? null) !== session.ownerTeamId) return "channel_team_mismatch";
  return null;
}
