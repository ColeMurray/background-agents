"use client";

import { useState, type ReactNode } from "react";
import type { ProviderDeviceAuthorizationStatusResponse } from "@open-inspect/shared/types/provider-accounts";
import { useProviderDeviceAuthorization } from "@/hooks/use-provider-device-authorization";
import { Button } from "@/components/ui/button";
import { CheckIcon, CopyIcon } from "@/components/ui/icons";
import { SubscriptionProviderIcon } from "@/components/subscription-provider-icon";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export const CHATGPT_DEVICE_AUTHORIZATION_SETTINGS_URL =
  "https://chatgpt.com/#settings/Security:~:text=Enable%20device%20code%20authorization%20for%20Codex";

export type ProviderDeviceAuthorizationTarget =
  | { provider: "openai" | "xai"; operation: "create" }
  | {
      provider: "openai" | "xai";
      operation: "reconnect";
      providerAccountId: string;
      displayName: string;
    };

const PROVIDER_CONTENT = {
  openai: {
    accountName: "ChatGPT",
    defaultDisplayName: "ChatGPT account",
    description:
      "Authorize Codex with OpenAI. Your credentials stay between OpenAI and the control plane.",
  },
  xai: {
    accountName: "SuperGrok",
    defaultDisplayName: "SuperGrok account",
    description:
      "Use your X Premium+ or SuperGrok subscription for Grok. Your credentials stay between xAI and the control plane.",
  },
} as const;

function countdownLabel(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ProviderDeviceAuthorizationDialog({
  target,
  onConnected,
  onClose,
}: {
  target: ProviderDeviceAuthorizationTarget;
  onConnected: (
    result: Extract<ProviderDeviceAuthorizationStatusResponse, { status: "connected" }>
  ) => void;
  onClose: () => void;
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const content = PROVIDER_CONTENT[target.provider];
  const { authorization, failure, status, remainingMs, retry, cancel } =
    useProviderDeviceAuthorization(
      target.provider,
      target.operation === "create"
        ? { operation: "create", displayName: content.defaultDisplayName }
        : { operation: "reconnect", providerAccountId: target.providerAccountId },
      onConnected
    );

  const close = () => {
    cancel();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
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
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-5 sm:px-7">
          {target.provider === "openai" && (
            <AuthorizationStep number={1} title="Enable device code authorization for Codex.">
              <Button asChild size="sm" variant="outline">
                <a
                  href={CHATGPT_DEVICE_AUTHORIZATION_SETTINGS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT Settings
                </a>
              </Button>
            </AuthorizationStep>
          )}

          <AuthorizationStep
            number={target.provider === "openai" ? 2 : 1}
            title={`Open the ${target.provider === "openai" ? "OpenAI" : "xAI"} device authorization page.`}
          >
            {authorization ? (
              <Button asChild size="sm" variant="outline">
                <a href={authorization.verificationUrl} target="_blank" rel="noopener noreferrer">
                  Open Device Authorization
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled>
                Open Device Authorization
              </Button>
            )}
          </AuthorizationStep>

          <AuthorizationStep
            number={target.provider === "openai" ? 3 : 2}
            title={`${target.provider === "openai" ? "Enter" : "Paste"} this code when ${target.provider === "openai" ? "OpenAI" : "xAI"} asks for it:`}
          >
            {authorization ? (
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md border border-border bg-background px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.18em] text-foreground sm:text-2xl">
                  {authorization.userCode}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label="Copy device code"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(authorization.userCode)
                      .then(() => setCopiedCode(authorization.userCode))
                      .catch(() => undefined);
                  }}
                >
                  {copiedCode === authorization.userCode ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                </Button>
              </div>
            ) : (
              <div className="h-14 animate-pulse rounded-md bg-muted" />
            )}
          </AuthorizationStep>

          {target.provider === "xai" && (
            <AuthorizationStep number={3} title="Continue in xAI to finish approval.">
              <p className="text-sm text-muted-foreground">
                Keep this dialog open while Open-Inspect waits for authorization.
              </p>
            </AuthorizationStep>
          )}

          <div className="flex flex-col gap-3 border-t border-border-muted pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              {failure ? (
                <p className="text-destructive">{failure.message}</p>
              ) : (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  <span>
                    {authorization ? (
                      <>
                        Waiting for authorization
                        {remainingMs !== null && (
                          <span> · expires in {countdownLabel(remainingMs)}</span>
                        )}
                      </>
                    ) : (
                      "Starting device authorization..."
                    )}
                  </span>
                </div>
              )}
            </div>
            <p aria-live="polite" aria-atomic="true" className="sr-only">
              {failure
                ? `Device authorization failed: ${failure.message}`
                : status === "pending"
                  ? "Device authorization started. Waiting for authorization."
                  : "Starting device authorization."}
            </p>
            <div className="flex shrink-0 gap-2">
              {failure?.retryable && (
                <Button size="sm" onClick={retry}>
                  Retry
                </Button>
              )}
              <Button size="sm" variant="subtle" onClick={close}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
