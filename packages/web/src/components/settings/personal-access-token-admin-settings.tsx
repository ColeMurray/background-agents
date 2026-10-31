"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES,
  PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS,
  personalAccessTokenEffectiveExpiry,
  withGrantPrerequisitesMet,
  type PersonalAccessTokenGrantablePermission,
  type PersonalAccessTokenPolicy,
  type WorkspacePersonalAccessToken,
} from "@open-inspect/shared/types/personal-access-tokens";
import {
  revokeMemberPersonalAccessTokens,
  revokeWorkspacePersonalAccessToken,
  saveWorkspacePersonalAccessTokenPolicy,
  useWorkspacePersonalAccessTokenPolicy,
  useWorkspacePersonalAccessTokens,
} from "@/hooks/use-workspace-personal-access-tokens";
import {
  PERSONAL_ACCESS_TOKEN_PERMISSION_COPY,
  PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS,
  PERSONAL_ACCESS_TOKEN_PERMISSION_ORDER,
  personalAccessTokenPermissionLabel,
} from "@/lib/personal-access-token-permissions";
import { formatLastUsed, formatTokenExpiry } from "@/lib/personal-access-token-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioCard } from "@/components/ui/form-controls";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSettingsUnsavedChanges } from "./settings-navigation-guard";

/** Lifetime caps an administrator can choose; null leaves the system maximum of one year. */
const LIFETIME_CAPS = [null, 180, 90, 30, 7] as const;

type Revocation =
  | { kind: "token"; token: WorkspacePersonalAccessToken }
  | { kind: "member"; owner: WorkspacePersonalAccessToken["owner"] };

function ownerLabel(owner: WorkspacePersonalAccessToken["owner"]): string {
  return owner.displayName ?? owner.email ?? owner.userId;
}

/** The rules of a policy snapshot, without its revision and authorship. */
function rulesOf(policy: PersonalAccessTokenPolicy): PersonalAccessTokenPolicy {
  return {
    enabled: policy.enabled,
    maxLifetimeDays: policy.maxLifetimeDays,
    allowedPermissions: policy.allowedPermissions,
  };
}

function samePolicy(a: PersonalAccessTokenPolicy, b: PersonalAccessTokenPolicy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Workspace governance of personal access tokens: the policy, and every member's tokens. */
export function PersonalAccessTokenAdminSettings() {
  return (
    <div className="space-y-10">
      <PolicySection />
      <TokensSection />
    </div>
  );
}

function PolicySection() {
  const { policy, loading, error, mutate } = useWorkspacePersonalAccessTokenPolicy();
  // Unsaved edits, held apart from the loaded policy so a revalidation never replaces them. Null
  // while the form shows the saved policy.
  const [edits, setEdits] = useState<PersonalAccessTokenPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = policy ? rulesOf(policy) : null;
  const dirty = edits !== null && saved !== null && !samePolicy(edits, saved);

  // A policy edit is easy to lose and decides what every member's tokens can do, so leaving with
  // unsaved changes asks first, as the other workspace policies do.
  useSettingsUnsavedChanges(dirty);

  if (loading) return <div className="text-sm text-muted-foreground">Loading...</div>;
  if (error || !policy || !saved) {
    return <div className="text-sm text-destructive">Failed to load the access token policy.</div>;
  }

  const draft = edits ?? saved;
  const revision = policy.revision;
  const ceiling = new Set(draft.allowedPermissions ?? []);

  async function save() {
    if (draft.allowedPermissions?.length === 0) {
      toast.error("Allow at least one permission, or turn tokens off instead");
      return;
    }
    setSaving(true);
    try {
      const result = await saveWorkspacePersonalAccessTokenPolicy(draft, revision);
      if (result.status === "conflict") {
        // Show the policy someone else saved, rather than let a second save overwrite it unseen.
        setEdits(null);
        await mutate();
        toast.error("Someone else changed the policy. Review it, then make your changes again.");
        return;
      }
      await mutate(result.policy, { revalidate: false });
      setEdits(null);
      toast.success("Access token policy saved");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to save the policy");
    } finally {
      setSaving(false);
    }
  }

  // Allowing a permission allows its prerequisites, and withdrawing a prerequisite withdraws what
  // needs it: a ceiling that allowed one without the other would never let a token use it.
  function toggleCeiling(permission: PersonalAccessTokenGrantablePermission, allowed: boolean) {
    const next = new Set(draft.allowedPermissions ?? []);
    if (allowed) {
      next.add(permission);
      for (const prerequisite of PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES[permission] ?? []) {
        next.add(prerequisite);
      }
    } else {
      next.delete(permission);
    }
    setEdits({
      ...draft,
      allowedPermissions: withGrantPrerequisitesMet(
        PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS.filter((p) => next.has(p))
      ),
    });
  }

  return (
    <section aria-labelledby="access-token-policy-heading">
      <h2 id="access-token-policy-heading" className="mb-1 text-xl font-semibold text-foreground">
        Access token policy
      </h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Rules for every member&apos;s personal access tokens. Changes apply to existing tokens at
        once: turning tokens off stops all of them, a shorter lifetime expires older tokens early,
        and a narrower set of permissions narrows every token&apos;s grant.
      </p>

      <div className="space-y-6 rounded-md border border-border p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <label htmlFor="access-tokens-enabled" className="text-sm font-medium text-foreground">
              Allow personal access tokens
            </label>
            <p className="text-xs text-muted-foreground">
              Off refuses every token immediately, without revoking any.
            </p>
          </div>
          <Switch
            id="access-tokens-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setEdits({ ...draft, enabled })}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-foreground">Longest lifetime</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {LIFETIME_CAPS.map((days) => (
              <RadioCard
                key={days ?? "system"}
                name="access-token-lifetime-cap"
                label={days === null ? "1 year" : `${days} days`}
                checked={draft.maxLifetimeDays === days}
                onChange={() => setEdits({ ...draft, maxLifetimeDays: days })}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-foreground">
            Permissions tokens may hold
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <RadioCard
              name="access-token-ceiling"
              label="Any a token can hold"
              checked={draft.allowedPermissions === null}
              onChange={() => setEdits({ ...draft, allowedPermissions: null })}
            />
            <RadioCard
              name="access-token-ceiling"
              label="Only those selected"
              checked={draft.allowedPermissions !== null}
              onChange={() =>
                setEdits({
                  ...draft,
                  allowedPermissions: draft.allowedPermissions ?? [
                    ...PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS,
                  ],
                })
              }
            />
          </div>
          {draft.allowedPermissions !== null && (
            <div className="mt-4 space-y-4">
              {PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS.map((group) => (
                <div key={group.id}>
                  <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PERSONAL_ACCESS_TOKEN_PERMISSION_ORDER.filter(
                      (permission) =>
                        PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].group === group.id
                    ).map((permission) => {
                      const id = `access-token-ceiling-${permission}`;
                      return (
                        <div key={permission} className="flex items-center gap-2">
                          <Checkbox
                            id={id}
                            checked={ceiling.has(permission)}
                            onCheckedChange={(checked) =>
                              toggleCeiling(permission, checked === true)
                            }
                          />
                          <label htmlFor={id} className="text-sm text-foreground">
                            {PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].label}
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </fieldset>

        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save policy"}
          </Button>
          {dirty && (
            <Button size="sm" variant="outline" onClick={() => setEdits(null)}>
              Discard changes
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function TokensSection() {
  const { tokens, hasMore, loadMore, loading, error, mutate } = useWorkspacePersonalAccessTokens();
  // The saved policy, so each token shows when it actually stops working under the lifetime cap.
  const { policy } = useWorkspacePersonalAccessTokenPolicy();
  const [revocation, setRevocation] = useState<Revocation | null>(null);
  const now = Date.now();

  async function revoke(target: Revocation) {
    try {
      if (target.kind === "token") {
        await revokeWorkspacePersonalAccessToken(target.token.id);
        toast.success(`Revoked ${target.token.name}`);
      } else {
        const count = await revokeMemberPersonalAccessTokens(target.owner.userId);
        toast.success(
          `Revoked ${count} token${count === 1 ? "" : "s"} of ${ownerLabel(target.owner)}`
        );
      }
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to revoke");
    }
  }

  return (
    <section aria-labelledby="workspace-access-tokens-heading">
      <h2
        id="workspace-access-tokens-heading"
        className="mb-1 text-xl font-semibold text-foreground"
      >
        Members&apos; access tokens
      </h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Every member&apos;s personal access tokens, newest first. Revoking one stops it immediately
        and is recorded in the audit log.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : error ? (
        <div className="text-sm text-destructive">Failed to load access tokens.</div>
      ) : tokens.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No member holds a personal access token.
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Members' access tokens">
          {tokens.map((token) => {
            const expiresAt = policy
              ? personalAccessTokenEffectiveExpiry(token, policy)
              : token.expiresAt;
            return (
              <li key={token.id} className="rounded-md border border-border bg-card px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{token.name}</span>
                      <code className="font-mono text-xs text-muted-foreground">
                        {token.displayPrefix}…
                      </code>
                      {expiresAt <= now && (
                        <Badge className="bg-destructive-muted text-destructive">Expired</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ownerLabel(token.owner)} · {formatLastUsed(token.lastUsedAt)} ·{" "}
                      {formatTokenExpiry(expiresAt, now)}
                    </p>
                    <ul
                      className="mt-2 flex flex-wrap gap-1"
                      aria-label={`${token.name} permissions`}
                    >
                      {token.permissions.map((permission) => (
                        <li key={permission}>
                          <Badge className="bg-muted text-muted-foreground">
                            {personalAccessTokenPermissionLabel(permission)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Revoke ${token.name} of ${ownerLabel(token.owner)}`}
                      onClick={() => setRevocation({ kind: "token", token })}
                    >
                      Revoke
                    </Button>
                    <Button
                      type="button"
                      variant="subtle"
                      size="xs"
                      onClick={() => setRevocation({ kind: "member", owner: token.owner })}
                    >
                      Revoke all of {ownerLabel(token.owner)}&apos;s tokens
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <Button className="mt-4" variant="outline" size="sm" onClick={() => void loadMore()}>
          Load more
        </Button>
      )}

      <AlertDialog open={!!revocation} onOpenChange={(open) => !open && setRevocation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revocation?.kind === "member" ? "Revoke all of a member's tokens" : "Revoke token"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revocation?.kind === "member"
                ? `Every token ${ownerLabel(revocation.owner)} holds stops working immediately.`
                : revocation?.kind === "token"
                  ? `${revocation.token.name}, held by ${ownerLabel(revocation.token.owner)}, stops working immediately.`
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revocation && void revoke(revocation)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
