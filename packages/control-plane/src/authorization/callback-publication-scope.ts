import type { SessionEntry } from "../db/session-index";
import type { SlackPostChannelBinding } from "./slack-post-gate";

export type PublicationSession = Pick<SessionEntry, "ownerTeamId" | "visibility">;

/** Reads current outbound authority, never the session DO's local mirror. */
export interface CallbackPublicationScope {
  getSession(sessionId: string): Promise<PublicationSession | null>;
  /** Slack channel binding lookup; destinations without bindings do not call it. */
  getChannelBinding(channelId: string): Promise<SlackPostChannelBinding | null>;
}
