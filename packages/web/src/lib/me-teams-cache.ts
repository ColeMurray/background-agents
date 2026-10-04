export const ME_TEAMS_API_PATH = "/api/me/teams";

export function meTeamsKey(userId: string) {
  return [ME_TEAMS_API_PATH, userId] as const;
}

export function isMeTeamsCacheKey(key: unknown): boolean {
  return (
    Array.isArray(key) &&
    key.length === 2 &&
    key[0] === ME_TEAMS_API_PATH &&
    typeof key[1] === "string"
  );
}
