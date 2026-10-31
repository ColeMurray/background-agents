"use client";

import {
  PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES,
  withGrantPrerequisitesMet,
  type PersonalAccessTokenGrantablePermission,
} from "@open-inspect/shared/types/personal-access-tokens";
import {
  PERSONAL_ACCESS_TOKEN_PERMISSION_COPY,
  PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS,
  PERSONAL_ACCESS_TOKEN_PERMISSION_ORDER,
} from "@/lib/personal-access-token-permissions";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Token permissions as checkboxes grouped by area: what a new token is granted, and the workspace
 * ceiling on what any token may hold. Checking a permission checks its prerequisites, and unchecking
 * a prerequisite unchecks what needs it, so a selection never holds a permission a token could not
 * use.
 */
export function PersonalAccessTokenPermissionPicker({
  idPrefix,
  available,
  selected,
  onChange,
}: {
  /** Prefixes each checkbox id, so two pickers can share a page. */
  idPrefix: string;
  /** The permissions on offer; each one's prerequisites must be on offer too. */
  available: readonly PersonalAccessTokenGrantablePermission[];
  selected: ReadonlySet<PersonalAccessTokenGrantablePermission>;
  onChange: (selected: Set<PersonalAccessTokenGrantablePermission>) => void;
}) {
  const offered = new Set(available);

  function toggle(permission: PersonalAccessTokenGrantablePermission, checked: boolean) {
    const next = new Set(selected);
    if (checked) {
      next.add(permission);
      for (const prerequisite of PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES[permission] ?? []) {
        next.add(prerequisite);
      }
    } else {
      next.delete(permission);
    }
    onChange(new Set(withGrantPrerequisitesMet([...next])));
  }

  return (
    <div className="space-y-4">
      {PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS.map((group) => {
        const permissions = PERSONAL_ACCESS_TOKEN_PERMISSION_ORDER.filter(
          (permission) =>
            offered.has(permission) &&
            PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].group === group.id
        );
        if (permissions.length === 0) return null;
        return (
          <div key={group.id}>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label}
            </h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {permissions.map((permission) => {
                const copy = PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission];
                const id = `${idPrefix}-${permission}`;
                return (
                  <div key={permission} className="flex items-start gap-2">
                    <Checkbox
                      id={id}
                      className="mt-0.5"
                      aria-describedby={`${id}-description`}
                      checked={selected.has(permission)}
                      onCheckedChange={(checked) => toggle(permission, checked === true)}
                    />
                    <div className="min-w-0 text-sm">
                      <label htmlFor={id} className="block text-foreground">
                        {copy.label}
                      </label>
                      <p id={`${id}-description`} className="text-xs text-muted-foreground">
                        {copy.description}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
