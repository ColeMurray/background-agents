import { getUserInfo } from "./slack-client";

/**
 * Resolve Slack user IDs to display names.
 * Returns a map of userId → displayName. Falls back to userId on failure.
 */
export async function resolveUserNames(
  token: string,
  userIds: string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const results = await Promise.allSettled(
    userIds.map(async (id) => {
      const info = await getUserInfo(token, id);
      const displayName = info.user?.profile?.display_name || info.user?.name || id;
      return { id, displayName };
    })
  );
  for (const result of results) {
    if (result.status === "fulfilled") {
      names.set(result.value.id, result.value.displayName);
    }
  }
  return names;
}
