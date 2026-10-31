"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  isPersonalAccessTokenGrantable,
  PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH,
  personalAccessTokenEffectiveExpiry,
  personalAccessTokenMaxLifetimeDays,
  personalAccessTokenPolicyAllows,
  withGrantPrerequisitesMet,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
  type PersonalAccessTokenGrantablePermission,
} from "@open-inspect/shared/types/personal-access-tokens";
import {
  issuePersonalAccessToken,
  revokePersonalAccessToken,
  usePersonalAccessTokenPolicy,
  usePersonalAccessTokens,
} from "@/hooks/use-personal-access-tokens";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import {
  PERSONAL_ACCESS_TOKEN_PERMISSION_COPY,
  personalAccessTokenPermissionLabel,
} from "@/lib/personal-access-token-permissions";
import { copyToClipboard } from "@/lib/format";
import { useAuthSession } from "@/lib/auth-session";
import {
  formatLastUsed,
  formatTokenDate,
  formatTokenExpiry,
} from "@/lib/personal-access-token-display";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioCard } from "@/components/ui/form-controls";
import { CheckIcon, CopyIcon, PlusIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { PersonalAccessTokenPermissionPicker } from "./personal-access-token-permission-picker";
import { useSettingsUnsavedChanges } from "./settings-navigation-guard";

const LIFETIME_DAYS = [7, 30, 90, 180, 365] as const;
const DEFAULT_LIFETIME_DAYS = 30;

interface Draft {
  name: string;
  expiresInDays: number;
  permissions: ReadonlySet<PersonalAccessTokenGrantablePermission>;
}

/** The lifetimes on offer under a cap: the standard choices within it, and the cap itself. */
function lifetimeChoices(maxLifetimeDays: number): number[] {
  const within = LIFETIME_DAYS.filter((days) => days <= maxLifetimeDays);
  return within.includes(maxLifetimeDays as (typeof LIFETIME_DAYS)[number])
    ? within
    : [...within, maxLifetimeDays];
}

/** `days` when it is on offer; otherwise the longest choice under it, or else the shortest. */
function fitLifetime(days: number, lifetimes: readonly number[]): number {
  if (lifetimes.includes(days)) return days;
  return lifetimes.filter((choice) => choice <= days).at(-1) ?? lifetimes[0] ?? days;
}

function lifetimeLabel(days: number): string {
  if (days === 365) return "1 year";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Where issuing a token stands. The phases exclude one another: a pending request cannot be
 * cancelled or replaced by another draft, so its response always belongs to the draft that sent it,
 * and the secret it returns stays on screen until the user acknowledges it or changes account.
 */
type Issuance =
  | { phase: "idle" }
  | { phase: "editing"; draft: Draft }
  | { phase: "issuing"; draft: Draft }
  | { phase: "issued"; token: CreatedPersonalAccessToken };

export function PersonalAccessTokensSettings() {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  // Local secrets and confirmation state must not survive an in-place account switch.
  return userId ? <PersonalAccessTokensPanel key={userId} /> : null;
}

function PersonalAccessTokensPanel() {
  const { tokens, loading, error, mutate } = usePersonalAccessTokens();
  const { policy, error: policyError } = usePersonalAccessTokenPolicy();
  const { authorization } = useCurrentUserAuthorization();
  const [issuance, setIssuance] = useState<Issuance>({ phase: "idle" });
  const [revokeTarget, setRevokeTarget] = useState<PersonalAccessToken | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  // Leaving while a token is being created, or before its secret is acknowledged, loses the only
  // copy of the secret, so settings navigation, history traversal, and unload all ask first.
  useSettingsUnsavedChanges(issuance.phase === "issuing" || issuance.phase === "issued");

  // Only permissions the user holds now, and the workspace policy allows, can be granted, so the
  // picker offers no others; nor one whose prerequisites are not on offer, which a token could
  // never exercise.
  const holdable = useMemo(
    () =>
      policy
        ? withGrantPrerequisitesMet(
            (authorization?.permissions ?? [])
              .filter(isPersonalAccessTokenGrantable)
              .filter((permission) => personalAccessTokenPolicyAllows(policy, permission))
          )
        : [],
    [authorization, policy]
  );
  const lifetimes = policy ? lifetimeChoices(personalAccessTokenMaxLifetimeDays(policy)) : [];
  // Issuing waits for the policy: choices offered before it loads could be ones it forbids.
  const canIssue = policy?.enabled === true;
  const disabled = policy?.enabled === false;

  // The policy can change while a draft is open, so the form shows, and submits, the draft held to
  // the current lifetimes and permissions.
  const formDraft =
    issuance.phase === "editing" || issuance.phase === "issuing"
      ? {
          ...issuance.draft,
          expiresInDays: fitLifetime(issuance.draft.expiresInDays, lifetimes),
          permissions: new Set(
            holdable.filter((permission) => issuance.draft.permissions.has(permission))
          ),
        }
      : null;

  async function issue(draft: Draft) {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Name the token after where it will be used");
      return;
    }
    if (draft.permissions.size === 0) {
      toast.error("Grant the token at least one permission");
      return;
    }
    setIssuance({ phase: "issuing", draft });
    let created: CreatedPersonalAccessToken;
    try {
      created = await issuePersonalAccessToken({
        name,
        expiresInDays: draft.expiresInDays,
        permissions: holdable.filter((permission) => draft.permissions.has(permission)),
      });
    } catch (cause) {
      if (!active.current) return;
      toast.error(cause instanceof Error ? cause.message : "Failed to create access token");
      setIssuance({ phase: "editing", draft });
      return;
    }
    if (!active.current) return;
    setIssuance({ phase: "issued", token: created });
    // The token exists now; a failed list refresh must not take its secret off screen.
    void mutate();
  }

  async function revoke(token: PersonalAccessToken) {
    try {
      await revokePersonalAccessToken(token.id);
      if (!active.current) return;
      toast.success(`Revoked ${token.name}`);
      await mutate();
    } catch (cause) {
      if (!active.current) return;
      toast.error(cause instanceof Error ? cause.message : "Failed to revoke access token");
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Access tokens</h2>
        {issuance.phase === "idle" && canIssue && (
          <Button
            onClick={() =>
              setIssuance({
                phase: "editing",
                draft: {
                  name: "",
                  expiresInDays: fitLifetime(DEFAULT_LIFETIME_DAYS, lifetimes),
                  permissions: new Set(),
                },
              })
            }
            variant="outline"
            size="sm"
          >
            <span className="inline-flex items-center gap-1">
              <PlusIcon className="h-3.5 w-3.5" />
              New token
            </span>
          </Button>
        )}
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Personal access tokens let tools such as the Open-Inspect MCP server call the API as you. A
        token can do only what you grant it, and never more than your role allows. Tokens cannot
        create or revoke tokens.
      </p>

      {disabled && (
        <div
          role="status"
          className="mb-6 rounded-md border border-warning/40 bg-warning-muted px-4 py-3 text-sm text-warning"
        >
          Your workspace has turned personal access tokens off. Existing tokens do not work, and new
          ones cannot be created, until an administrator turns them back on.
        </div>
      )}

      {!policy && policyError && (
        <div role="status" className="mb-6 text-sm text-destructive">
          Failed to load the workspace&apos;s token policy, so new tokens cannot be created right
          now.
        </div>
      )}

      {formDraft && canIssue && (
        <TokenForm
          draft={formDraft}
          holdable={holdable}
          lifetimes={lifetimes}
          issuing={issuance.phase === "issuing"}
          onChange={(draft) => setIssuance({ phase: "editing", draft })}
          onSubmit={() => void issue(formDraft)}
          onCancel={() => setIssuance({ phase: "idle" })}
        />
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : error ? (
        <div className="text-sm text-destructive">Failed to load access tokens.</div>
      ) : tokens.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No access tokens. Create one for each tool or machine that needs API access.
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Access tokens">
          {tokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              expiresAt={
                policy ? personalAccessTokenEffectiveExpiry(token, policy) : token.expiresAt
              }
              onRevoke={() => setRevokeTarget(token)}
            />
          ))}
        </ul>
      )}

      <IssuedTokenDialog
        token={issuance.phase === "issued" ? issuance.token : null}
        onDone={() => setIssuance({ phase: "idle" })}
      />

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access token</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.name} stops working immediately. Anything using it will need a new
              token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && void revoke(revokeTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TokenForm({
  draft,
  holdable,
  lifetimes,
  issuing,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  holdable: readonly PersonalAccessTokenGrantablePermission[];
  lifetimes: readonly number[];
  issuing: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const readOnly = holdable.filter(
    (permission) => PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].readOnly
  );

  return (
    <form
      className="mb-6 rounded-md border border-border p-4"
      aria-label="New access token"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {/* Inert while the request is pending, so the draft it sent cannot change or be cancelled. */}
      <fieldset disabled={issuing} className="min-w-0 space-y-5">
        <div>
          <Label htmlFor="access-token-name">Name</Label>
          <Input
            id="access-token-name"
            className="mt-1"
            value={draft.name}
            maxLength={PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH}
            placeholder="Work laptop MCP server"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-foreground">Expires in</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {lifetimes.map((days) => (
              <RadioCard
                key={days}
                name="access-token-lifetime"
                label={lifetimeLabel(days)}
                checked={draft.expiresInDays === days}
                onChange={() => onChange({ ...draft, expiresInDays: days })}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <legend className="text-sm font-medium text-foreground">Permissions</legend>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="subtle"
                size="xs"
                disabled={readOnly.length === 0}
                onClick={() => onChange({ ...draft, permissions: new Set(readOnly) })}
              >
                Read-only
              </Button>
              <Button
                type="button"
                variant="subtle"
                size="xs"
                onClick={() => onChange({ ...draft, permissions: new Set() })}
              >
                Clear
              </Button>
            </div>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Grant only what the tool needs. Permissions your role does not include are not listed,
            and a token loses any permission your role later loses.
          </p>
          <div className="mt-3">
            <PersonalAccessTokenPermissionPicker
              idPrefix="access-token-permission"
              available={holdable}
              selected={draft.permissions}
              onChange={(permissions) => onChange({ ...draft, permissions })}
            />
          </div>
        </fieldset>

        <div className="flex gap-2">
          <Button type="submit" size="sm">
            {issuing ? "Creating..." : "Create token"}
          </Button>
          <Button type="button" onClick={onCancel} variant="outline" size="sm">
            Cancel
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

function TokenRow({
  token,
  expiresAt,
  onRevoke,
}: {
  token: PersonalAccessToken;
  /** The token's effective expiry under the workspace policy. */
  expiresAt: number;
  onRevoke: () => void;
}) {
  const now = Date.now();
  const expired = expiresAt <= now;
  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{token.name}</span>
            <code className="font-mono text-xs text-muted-foreground">{token.displayPrefix}…</code>
            {expired && <Badge className="bg-destructive-muted text-destructive">Expired</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatTokenDate(token.createdAt)} · {formatLastUsed(token.lastUsedAt)} ·{" "}
            {formatTokenExpiry(expiresAt, now)}
          </p>
          <ul className="mt-2 flex flex-wrap gap-1" aria-label={`${token.name} permissions`}>
            {token.permissions.map((permission) => (
              <li key={permission}>
                <Badge className="bg-muted text-muted-foreground">
                  {personalAccessTokenPermissionLabel(permission)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRevoke}
          aria-label={`Revoke ${token.name}`}
        >
          Revoke
        </Button>
      </div>
    </li>
  );
}

/**
 * Shows a newly issued token once. It closes only through Done, never through Escape or an outside
 * click, so the secret is not lost to a stray keypress; the panel's navigation guard covers leaving
 * the page.
 */
function IssuedTokenDialog({
  token,
  onDone,
}: {
  token: CreatedPersonalAccessToken | null;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <AlertDialog open={!!token}>
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Copy your new token</AlertDialogTitle>
          <AlertDialogDescription>
            This is the only time {token?.name} is shown. Store it somewhere safe, such as your MCP
            client&apos;s configuration. If you lose it, revoke it and create another.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {token && (
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
              data-testid="issued-access-token"
            >
              {token.token}
            </code>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Copy token"
              onClick={async () => {
                if (await copyToClipboard(token.token)) setCopied(true);
                else toast.error("Copy failed; select the token and copy it manually");
              }}
            >
              {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
            </Button>
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              setCopied(false);
              onDone();
            }}
          >
            Done
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
