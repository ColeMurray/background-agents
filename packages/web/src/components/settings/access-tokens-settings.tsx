"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  ACCESS_TOKEN_MAX_TTL_DAYS,
  ACCESS_TOKEN_NAME_MAX_LENGTH,
  type CreatedAccessToken,
} from "@open-inspect/shared/types/access-tokens";
import { useAccessTokens, createAccessToken, revokeAccessToken } from "@/hooks/use-access-tokens";
import { PlusIcon, KeyIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
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

/** Expiry choices, kept coarse: a free-form day count invites typos, not care. */
const EXPIRY_OPTIONS = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: ACCESS_TOKEN_MAX_TTL_DAYS },
  { label: "No expiry", days: undefined },
] as const;

function formatDate(epochMs: number | null): string {
  if (epochMs === null) return "Never";
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AccessTokensSettings() {
  const { tokens, loading, error: loadError, mutate } = useAccessTokens();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>(90);
  const [issued, setIssued] = useState<CreatedAccessToken | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);

  function resetForm() {
    setCreating(false);
    setName("");
    setExpiresInDays(90);
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the token a name so you can tell it apart later");
      return;
    }

    setSaving(true);
    try {
      const created = await createAccessToken({ name: trimmed, expiresInDays });
      // Held in state because the server will not return it again.
      setIssued(created);
      resetForm();
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create access token");
    } finally {
      setSaving(false);
    }
  }

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    try {
      await revokeAccessToken(pendingRevoke.id);
      toast.success(`Revoked "${pendingRevoke.name}"`);
      await mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke access token");
    } finally {
      setPendingRevoke(null);
    }
  }

  async function copyIssuedToken() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      toast.success("Token copied");
    } catch {
      toast.error("Could not copy — select the token and copy it manually");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-foreground">Access Tokens</h2>
        <Button onClick={() => setCreating(true)} variant="outline" size="sm">
          <span className="inline-flex items-center gap-1">
            <PlusIcon className="w-3.5 h-3.5" />
            New Token
          </span>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Personal access tokens let local tools — such as the Open-Inspect MCP server — read the
        control plane as you. They are read-only: a token can never create, modify, or delete
        anything, and it cannot issue another token.
      </p>

      {creating && (
        <div className="border border-border rounded-md p-4 mb-6 space-y-4">
          <h3 className="text-sm font-medium text-foreground">New Access Token</h3>
          <div className="space-y-2">
            <Label htmlFor="access-token-name">Name</Label>
            <Input
              id="access-token-name"
              value={name}
              maxLength={ACCESS_TOKEN_NAME_MAX_LENGTH}
              placeholder="e.g. laptop MCP"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label id="access-token-expiry-label">Expires</Label>
            {/* Selection is conveyed by colour alone unless it is also in the
                accessibility tree, so the group is a radiogroup. */}
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-labelledby="access-token-expiry-label"
            >
              {EXPIRY_OPTIONS.map((option) => (
                <Button
                  key={option.label}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={expiresInDays === option.days}
                  variant={expiresInDays === option.days ? "primary" : "outline"}
                  onClick={() => setExpiresInDays(option.days)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Creating..." : "Create Token"}
            </Button>
            <Button onClick={resetForm} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : loadError ? (
        <div className="border border-border rounded-md px-4 py-6 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            Could not load your access tokens. Any existing tokens are still active.
          </p>
          <Button variant="outline" size="sm" onClick={() => void mutate()}>
            Retry
          </Button>
        </div>
      ) : tokens.length === 0 && !creating ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No access tokens yet. Create one to connect the MCP server.
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((token) => (
            <div
              key={token.id}
              className="border border-border rounded-md bg-card flex items-center justify-between px-4 py-3 gap-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <KeyIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{token.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <code>{token.displayPrefix}…</code> · Last used{" "}
                    {token.lastUsedAt === null ? "never" : formatDate(token.lastUsedAt)} · Expires{" "}
                    {formatDate(token.expiresAt)}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPendingRevoke({ id: token.id, name: token.name })}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Shown once. Dismissing it is the last chance to copy the token. */}
      <AlertDialog open={issued !== null} onOpenChange={(open) => !open && setIssued(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Copy your access token</AlertDialogTitle>
            <AlertDialogDescription>
              This is the only time the token is shown. Store it somewhere safe — if you lose it,
              revoke it and create another.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <code className="block break-all rounded-md bg-muted p-3 text-xs text-foreground">
            {issued?.token}
          </code>
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={copyIssuedToken}>
              Copy
            </Button>
            <AlertDialogAction onClick={() => setIssued(null)}>Done</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke &ldquo;{pendingRevoke?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Any tool using this token stops working immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
