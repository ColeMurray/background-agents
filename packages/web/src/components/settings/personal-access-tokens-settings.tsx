"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  isPersonalAccessTokenGrantable,
  PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
  type PersonalAccessTokenGrantablePermission,
} from "@open-inspect/shared/types/personal-access-tokens";
import {
  issuePersonalAccessToken,
  revokePersonalAccessToken,
  usePersonalAccessTokens,
} from "@/hooks/use-personal-access-tokens";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import {
  PERSONAL_ACCESS_TOKEN_PERMISSION_COPY,
  PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS,
  personalAccessTokenPermissionLabel,
} from "@/lib/personal-access-token-permissions";
import { formatFutureRelativeTime, formatRelativeTime } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

const LIFETIME_DAYS = [7, 30, 90, 180, 365] as const;
const DEFAULT_LIFETIME_DAYS = 30;

interface Draft {
  name: string;
  expiresInDays: number;
  permissions: ReadonlySet<PersonalAccessTokenGrantablePermission>;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  expiresInDays: DEFAULT_LIFETIME_DAYS,
  permissions: new Set(),
};

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function PersonalAccessTokensSettings() {
  const { tokens, loading, error, mutate } = usePersonalAccessTokens();
  const { authorization } = useCurrentUserAuthorization();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<CreatedPersonalAccessToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PersonalAccessToken | null>(null);

  // Only permissions the user holds now can be granted, so the picker offers no others.
  const holdable = useMemo(
    () => (authorization?.permissions ?? []).filter(isPersonalAccessTokenGrantable),
    [authorization]
  );

  async function issue() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error("Name the token after where it will be used");
      return;
    }
    if (draft.permissions.size === 0) {
      toast.error("Grant the token at least one permission");
      return;
    }
    setIssuing(true);
    try {
      const created = await issuePersonalAccessToken({
        name,
        expiresInDays: draft.expiresInDays,
        permissions: holdable.filter((permission) => draft.permissions.has(permission)),
      });
      setDraft(null);
      setIssued(created);
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to create access token");
    } finally {
      setIssuing(false);
    }
  }

  async function revoke(token: PersonalAccessToken) {
    try {
      await revokePersonalAccessToken(token.id);
      toast.success(`Revoked ${token.name}`);
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Failed to revoke access token");
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-foreground">Access tokens</h2>
        {!draft && (
          <Button onClick={() => setDraft(EMPTY_DRAFT)} variant="outline" size="sm">
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

      {draft && (
        <TokenForm
          draft={draft}
          holdable={holdable}
          issuing={issuing}
          onChange={setDraft}
          onSubmit={() => void issue()}
          onCancel={() => setDraft(null)}
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
            <TokenRow key={token.id} token={token} onRevoke={() => setRevokeTarget(token)} />
          ))}
        </ul>
      )}

      <IssuedTokenDialog token={issued} onDone={() => setIssued(null)} />

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
  issuing,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  holdable: readonly PersonalAccessTokenGrantablePermission[];
  issuing: boolean;
  onChange: (draft: Draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const toggle = (permission: PersonalAccessTokenGrantablePermission, granted: boolean) => {
    const permissions = new Set(draft.permissions);
    if (granted) permissions.add(permission);
    else permissions.delete(permission);
    onChange({ ...draft, permissions });
  };
  const readOnly = holdable.filter(
    (permission) => PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].readOnly
  );

  return (
    <form
      className="mb-6 space-y-5 rounded-md border border-border p-4"
      aria-label="New access token"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
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
          {LIFETIME_DAYS.map((days) => (
            <RadioCard
              key={days}
              name="access-token-lifetime"
              label={days === 365 ? "1 year" : `${days} days`}
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
          Grant only what the tool needs. Permissions your role does not include are not listed, and
          a token loses any permission your role later loses.
        </p>
        <div className="mt-3 space-y-4">
          {PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS.map((group) => {
            const permissions = holdable.filter(
              (permission) => PERSONAL_ACCESS_TOKEN_PERMISSION_COPY[permission].group === group.id
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
                    const id = `access-token-permission-${permission}`;
                    return (
                      <div key={permission} className="flex items-start gap-2">
                        <Checkbox
                          id={id}
                          className="mt-0.5"
                          aria-describedby={`${id}-description`}
                          checked={draft.permissions.has(permission)}
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
      </fieldset>

      <div className="flex gap-2">
        <Button type="submit" disabled={issuing} size="sm">
          {issuing ? "Creating..." : "Create token"}
        </Button>
        <Button type="button" onClick={onCancel} variant="outline" size="sm">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TokenRow({ token, onRevoke }: { token: PersonalAccessToken; onRevoke: () => void }) {
  const expired = token.expiresAt <= Date.now();
  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">{token.name}</span>
            <code className="font-mono text-xs text-muted-foreground">{token.displayPrefix}…</code>
            {expired && <Badge className="bg-destructive-muted text-destructive">Expired</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatDate(token.createdAt)} ·{" "}
            {token.lastUsedAt === null
              ? "Never used"
              : `Last used ${formatRelativeTime(token.lastUsedAt)} ago`}{" "}
            ·{" "}
            {expired
              ? `Expired ${formatDate(token.expiresAt)}`
              : `Expires ${formatFutureRelativeTime(token.expiresAt)}`}
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
 * click, so the secret is not lost to a stray keypress.
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
              onClick={() => {
                void navigator.clipboard
                  .writeText(token.token)
                  .then(() => setCopied(true))
                  .catch(() => toast.error("Copy failed; select the token and copy it manually"));
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
