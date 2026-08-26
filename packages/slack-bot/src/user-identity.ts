import { getUserInfo } from "@open-inspect/shared/slack";

const MAX_SENDER_LABEL_LENGTH = 80;

export interface SlackActorIdentity {
  userId: string;
  senderLabel: string;
  displayName?: string;
  email?: string;
}

function formatSenderLabel(displayName: string | undefined, userId: string): string {
  const normalizedName = (displayName ?? "")
    .replace(/[[\]\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SENDER_LABEL_LENGTH);
  return normalizedName && normalizedName !== userId ? `${normalizedName} (${userId})` : userId;
}

/** Resolve the Slack identity used by both prompt attribution and session creation. */
export async function resolveSlackActorIdentity(
  token: string,
  userId: string
): Promise<SlackActorIdentity> {
  const fallback: SlackActorIdentity = { userId, senderLabel: userId };
  try {
    const result = await getUserInfo(token, userId);
    if (!result.ok) return fallback;

    const profileDisplayName = result.user.profile?.display_name;
    return {
      userId,
      senderLabel: formatSenderLabel(profileDisplayName, userId),
      displayName: profileDisplayName || result.user.real_name || result.user.name || undefined,
      email: result.user.profile?.email || undefined,
    };
  } catch {
    return fallback;
  }
}
