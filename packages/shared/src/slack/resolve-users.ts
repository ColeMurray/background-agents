import { getUserInfo as defaultGetUserInfo } from "./client";

type GetUserInfo = (token: string, userId: string) => ReturnType<typeof defaultGetUserInfo>;

/**
 * Resolve Slack user IDs to display names.
 *
 * Returns a map of `userId → displayName`. When `getUserInfo` fails (Slack
 * error envelope or thrown exception via `Promise.allSettled`), the entry is
 * either populated with the raw user ID (envelope failure) or omitted entirely
 * (thrown exception). Callers should treat a missing entry as "unknown user".
 *
 * The optional `deps` parameter allows injecting a custom `getUserInfo`
 * implementation for testing without module-level mocking.
 */
export async function resolveUserNames(
  token: string,
  userIds: string[],
  deps: { getUserInfo?: GetUserInfo } = {}
): Promise<Map<string, string>> {
  const getUserInfo = deps.getUserInfo ?? defaultGetUserInfo;
  const names = new Map<string, string>();
  const results = await Promise.allSettled(
    userIds.map(async (id) => {
      const info = await getUserInfo(token, id);
      if (!info.ok) return { id, displayName: id };
      const displayName = info.user.profile?.display_name || info.user.name || id;
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
