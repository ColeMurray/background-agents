"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { userDisplayName, type UserIdentityProps } from "./user-identity-utils";

function userPickerTextValue(user: UserIdentityProps): string {
  return user.displayName?.trim() || user.email?.trim() || userDisplayName(user);
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

export function UserIdentityPicker({
  id,
  value,
  onValueChange,
  disabled,
  candidates,
}: {
  id: string;
  value: string;
  onValueChange: (userId: string) => void;
  disabled: boolean;
  candidates: readonly UserIdentityProps[];
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      <SelectTrigger id={id} className="min-w-0 flex-1">
        <SelectValue placeholder="Select a workspace member" />
      </SelectTrigger>
      <SelectContent>
        {candidates.map((candidate) => (
          <SelectItem
            className="group focus:bg-muted focus:text-foreground"
            key={candidate.userId}
            value={candidate.userId}
            textValue={userPickerTextValue(candidate)}
          >
            <UserIdentity {...candidate} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
