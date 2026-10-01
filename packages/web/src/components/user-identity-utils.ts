export interface UserIdentityProps {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export function userDisplayName({ userId, displayName }: UserIdentityProps): string {
  return displayName?.trim() || `Unnamed user \u00b7 ${userId.slice(-6)}`;
}
