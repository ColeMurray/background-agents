import type { SessionEntry } from "../db/session-index";

export type SlackPostSession = Pick<SessionEntry, "ownerTeamId" | "visibility">;
export interface SlackPostChannelBinding {
  teamId: string;
}

/** Reads current outbound scope, never the session DO's local mirror. */
export interface SlackPostScope {
  getSession(sessionId: string): Promise<SlackPostSession | null>;
  getChannelBinding(channelId: string): Promise<SlackPostChannelBinding | null>;
}

export type SlackPostDenial = "missing_session" | "private_session" | "channel_team_mismatch";

/** Workspace readability does not authorize publication into another team's channel. */
export function slackPostGate(
  session: SlackPostSession | null,
  binding: SlackPostChannelBinding | null
): SlackPostDenial | null {
  if (!session) return "missing_session";
  if (session.visibility === "private") return "private_session";
  if (binding && binding.teamId !== session.ownerTeamId) return "channel_team_mismatch";
  return null;
}
