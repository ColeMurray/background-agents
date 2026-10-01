interface UserIdentityProps {
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export function userDisplayName({ userId, displayName }: UserIdentityProps): string {
  return displayName?.trim() || `Unnamed user \u00b7 ${userId.slice(-6)}`;
}

export function UserIdentity(user: UserIdentityProps) {
  const name = userDisplayName(user);
  return (
    <span className="flex min-w-0 items-center gap-2" title={user.email ?? undefined}>
      <span
        aria-hidden="true"
        className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-card text-xs font-medium text-foreground"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          user.displayName?.trim().charAt(0).toUpperCase() || "?"
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        {user.email && (
          <span className="block truncate text-xs text-muted-foreground group-data-[highlighted]:text-foreground">
            {user.email}
          </span>
        )}
      </span>
    </span>
  );
}
