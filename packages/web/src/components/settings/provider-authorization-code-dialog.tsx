"use client";

import { useState, type ReactNode } from "react";
import type { ProviderAuthorizationCodeStatusResponse } from "@open-inspect/shared/types/provider-accounts";
import { useProviderAuthorizationCode } from "@/hooks/use-provider-authorization-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubscriptionProviderIcon } from "@/components/subscription-provider-icon";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type ProviderAuthorizationCodeTarget =
  | { provider: "anthropic"; operation: "create" }
  | {
      provider: "anthropic";
      operation: "reconnect";
      providerAccountId: string;
      displayName: string;
      /** The Claude account the browser flow named; a pasted token cannot reconnect such a slot. */
      externalAccountId: string | null;
    };

/** A setup token minted elsewhere, submitted through the ordinary connect/reconnect request. */
export type ProviderSetupTokenSubmission =
  | { operation: "create"; displayName: string; setupToken: string }
  | { operation: "reconnect"; providerAccountId: string; setupToken: string };

type ConnectedAuthorization = Extract<
  ProviderAuthorizationCodeStatusResponse,
  { status: "connected" }
>;

export const ANTHROPIC_CREDENTIAL_ROTATION_WARNING =
  "Sessions that already received this credential keep it until their sandbox exits. Reconnecting rotates what Open Inspect stores; it does not revoke the token at Anthropic.";

const PROVIDER_CONTENT = {
  anthropic: {
    accountName: "Claude",
    defaultDisplayName: "Claude account",
    description:
      "Use your Claude subscription for Claude Agent. Anthropic shows a code after you grant access; paste it here to finish.",
  },
} as const;

function countdownLabel(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One connection method is mounted at a time. The browser flow lives in
 * `AuthorizationCodeForm`, which owns its transaction: switching to the
 * setup-token form unmounts it and cancels the transaction, and switching
 * back starts a fresh one. While a setup token is being saved the dialog
 * cannot be dismissed or switched, so two credential writes never overlap.
 */
export function ProviderAuthorizationCodeDialog({
  target,
  saving,
  onConnected,
  onSubmitSetupToken,
  onClose,
}: {
  target: ProviderAuthorizationCodeTarget;
  saving: boolean;
  onConnected: (result: ConnectedAuthorization) => void;
  onSubmitSetupToken: (submission: ProviderSetupTokenSubmission) => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"browser" | "setup_token">("browser");
  const content = PROVIDER_CONTENT[target.provider];
  // A slot the browser flow bound to a Claude account is reconnected the same
  // way, so the granting account can be verified; the control plane refuses a
  // pasted token there.
  const setupTokenAllowed = target.operation === "create" || target.externalAccountId === null;

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto p-0 sm:w-full">
        <div className="border-b border-border-muted bg-muted/30 px-5 py-5 sm:px-7">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">
              <SubscriptionProviderIcon
                provider={target.provider}
                className="size-5 text-foreground"
              />
            </div>
            <div>
              <DialogTitle>
                {target.operation === "create"
                  ? `Connect your ${content.accountName} account`
                  : `Reconnect ${target.displayName}`}
              </DialogTitle>
              <DialogDescription className="mt-1">{content.description}</DialogDescription>
              {target.operation === "reconnect" && (
                <p className="mt-2 rounded-md bg-warning-muted px-3 py-2 text-xs text-warning">
                  {ANTHROPIC_CREDENTIAL_ROTATION_WARNING}
                </p>
              )}
            </div>
          </div>
        </div>

        {method === "setup_token" ? (
          <SetupTokenForm
            target={target}
            defaultDisplayName={content.defaultDisplayName}
            saving={saving}
            onSubmit={onSubmitSetupToken}
            onBack={() => setMethod("browser")}
            onCancel={onClose}
          />
        ) : (
          <AuthorizationCodeForm
            target={target}
            defaultDisplayName={content.defaultDisplayName}
            onConnected={onConnected}
            onClose={onClose}
            onUseSetupToken={setupTokenAllowed ? () => setMethod("setup_token") : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AuthorizationCodeForm({
  target,
  defaultDisplayName,
  onConnected,
  onClose,
  onUseSetupToken,
}: {
  target: ProviderAuthorizationCodeTarget;
  defaultDisplayName: string;
  onConnected: (result: ConnectedAuthorization) => void;
  onClose: () => void;
  onUseSetupToken?: () => void;
}) {
  const [code, setCode] = useState("");
  const { authorization, failure, status, remainingMs, complete, retry, cancel } =
    useProviderAuthorizationCode(
      target.provider,
      target.operation === "create"
        ? { operation: "create", displayName: defaultDisplayName }
        : { operation: "reconnect", providerAccountId: target.providerAccountId },
      onConnected
    );

  const close = () => {
    cancel();
    onClose();
  };
  const canComplete = status === "awaiting_code" && code.trim().length > 0;
  const settled = status !== "starting" && status !== "awaiting_code" && status !== "completing";
  // A settled transaction is over; a fresh one is the way forward whenever the
  // failure is transient or the provider rejected the code (`denied`). Only a
  // start refused outright (a permission or archived-account error) offers
  // nothing to start over with.
  const canStartOver = settled && failure !== null && (failure.retryable || status === "denied");

  return (
    <form
      className="space-y-3 px-5 py-5 sm:px-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (canComplete) void complete(code);
      }}
    >
      <AuthorizationStep number={1} title="Open Anthropic and grant access to Claude Agent.">
        {authorization ? (
          <Button asChild size="sm" variant="outline">
            <a href={authorization.authorizationUrl} target="_blank" rel="noopener noreferrer">
              Open Anthropic
            </a>
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled>
            Open Anthropic
          </Button>
        )}
      </AuthorizationStep>

      <AuthorizationStep number={2} title="Paste the code Anthropic shows you.">
        <Label htmlFor="provider-authorization-code" className="sr-only">
          Authorization code
        </Label>
        <Textarea
          id="provider-authorization-code"
          rows={2}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
          placeholder="Paste the code here"
          value={code}
          disabled={status !== "awaiting_code"}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!canComplete}>
          {status === "completing" ? "Completing..." : "Complete"}
        </Button>
      </AuthorizationStep>

      <div className="flex flex-col gap-3 border-t border-border-muted pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          {failure ? (
            <p className="text-destructive">{failure.message}</p>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              {(status === "starting" || status === "completing") && (
                <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              <span>
                {status === "starting"
                  ? "Starting authorization..."
                  : status === "completing"
                    ? "Completing authorization..."
                    : status === "connected"
                      ? "Connected."
                      : remainingMs !== null && (
                          <>Waiting for the code · expires in {countdownLabel(remainingMs)}</>
                        )}
              </span>
            </div>
          )}
        </div>
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {failure
            ? `Authorization failed: ${failure.message}`
            : status === "awaiting_code"
              ? "Authorization started. Waiting for the code from Anthropic."
              : status === "completing"
                ? "Completing authorization."
                : status === "connected"
                  ? "Claude account connected."
                  : "Starting authorization."}
        </p>
        <div className="flex shrink-0 gap-2">
          {canStartOver && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setCode("");
                retry();
              }}
            >
              Start over
            </Button>
          )}
          <Button type="button" size="sm" variant="subtle" onClick={close}>
            Cancel
          </Button>
        </div>
      </div>

      {onUseSetupToken && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={onUseSetupToken}
        >
          Paste a setup token instead
        </button>
      )}
    </form>
  );
}

function SetupTokenForm({
  target,
  defaultDisplayName,
  saving,
  onSubmit,
  onBack,
  onCancel,
}: {
  target: ProviderAuthorizationCodeTarget;
  defaultDisplayName: string;
  saving: boolean;
  onSubmit: (submission: ProviderSetupTokenSubmission) => void;
  onBack: () => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [setupToken, setSetupToken] = useState("");
  const trimmedDisplayName = displayName.trim();
  const canSubmit =
    !saving &&
    setupToken.trim().length > 0 &&
    (target.operation === "reconnect" || !!trimmedDisplayName);

  return (
    <form
      className="space-y-3 px-5 py-5 sm:px-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSubmit(
          target.operation === "create"
            ? {
                operation: "create",
                displayName: trimmedDisplayName,
                setupToken: setupToken.trim(),
              }
            : {
                operation: "reconnect",
                providerAccountId: target.providerAccountId,
                setupToken: setupToken.trim(),
              }
        );
      }}
    >
      <p className="text-sm text-muted-foreground">
        Run <code className="font-mono text-xs">claude setup-token</code> on a workstation signed in
        to your Claude account, then paste the token it prints. Generate it right before pasting: a
        setup token lasts a year from when it was minted, and that is what the stored expiry
        assumes. The token is stored write-only.
      </p>
      {target.operation === "create" && (
        <div>
          <Label htmlFor="provider-setup-token-display-name">Account name</Label>
          <Input
            id="provider-setup-token-display-name"
            autoComplete="off"
            maxLength={100}
            value={displayName}
            disabled={saving}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
      )}
      <div>
        <Label htmlFor="provider-setup-token">Setup token</Label>
        <Input
          id="provider-setup-token"
          type="password"
          autoComplete="off"
          value={setupToken}
          disabled={saving}
          onChange={(event) => setSetupToken(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {saving ? "Saving..." : "Save"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onBack}>
          Back
        </Button>
        <Button type="button" size="sm" variant="subtle" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AuthorizationStep({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-md border border-border-muted p-4">
      <div className="flex size-8 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background">
        {number}
      </div>
      <div className="min-w-0 space-y-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {children}
      </div>
    </section>
  );
}
