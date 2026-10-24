"use client";

import { useState } from "react";
import { useAutomationExternalActionGrants } from "@/hooks/use-automation-external-action-grants";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";

export interface AutomationExternalActionGrantsProps {
  automationId: string;
  /** The caller may manage the automation. The server still decides every grant. */
  canManage: boolean;
}

/**
 * Unattended publication permissions for one automation.
 *
 * A grant lets the automation publish one kind of external effect without a
 * human in the loop. It is narrow by construction: one provider, one action,
 * the automation's own executor. Revoking it takes effect immediately.
 */
export function AutomationExternalActionGrants({
  automationId,
  canManage,
}: AutomationExternalActionGrantsProps) {
  const { grants, error, isLoading, create, revoke } = useAutomationExternalActionGrants(
    automationId,
    canManage
  );
  const [provider, setProvider] = useState("");
  const [action, setAction] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!canManage) return null;

  const submit = async () => {
    if (pending || !provider.trim() || !action.trim()) return;
    setPending(true);
    setFailure(null);
    try {
      await create(provider.trim(), action.trim());
      setProvider("");
      setAction("");
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The grant could not be created");
    } finally {
      setPending(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      await revoke(grantId);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The grant could not be revoked");
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="border border-border-muted rounded-md bg-background p-4 mb-8">
      <h2 className="text-lg font-medium text-foreground mb-1">Unattended publishing</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Let this automation publish one kind of external effect without waiting for a person. The
        executor is always this automation&rsquo;s own executor.
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading grants…</p>}
      {error && (
        <ErrorBanner role="alert" className="mb-4">
          {error}
        </ErrorBanner>
      )}
      {grants.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground mb-4">No unattended grants.</p>
      )}
      {grants.length > 0 && (
        <ul className="space-y-2 mb-4">
          {grants.map((grant) => (
            <li key={grant.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-foreground">
                {grant.provider} · {grant.action}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                aria-label={`Revoke ${grant.provider} ${grant.action}`}
                onClick={() => void revokeGrant(grant.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="grant-provider" className="block text-xs font-medium text-foreground">
            Provider
          </label>
          <input
            id="grant-provider"
            value={provider}
            disabled={pending}
            onChange={(event) => setProvider(event.target.value)}
            className="mt-1 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </div>
        <div>
          <label htmlFor="grant-action" className="block text-xs font-medium text-foreground">
            Action
          </label>
          <input
            id="grant-action"
            value={action}
            disabled={pending}
            onChange={(event) => setAction(event.target.value)}
            className="mt-1 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </div>
        <Button
          size="sm"
          disabled={pending || !provider.trim() || !action.trim()}
          onClick={() => void submit()}
        >
          Allow
        </Button>
      </div>
      {failure && (
        <ErrorBanner role="alert" className="mt-3">
          {failure}
        </ErrorBanner>
      )}
    </section>
  );
}
