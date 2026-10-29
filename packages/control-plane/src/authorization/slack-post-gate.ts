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
