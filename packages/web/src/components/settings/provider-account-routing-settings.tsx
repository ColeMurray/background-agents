"use client";

import { useState } from "react";
import type { ProviderAccountRouting } from "@open-inspect/shared/types/provider-account-routing";
import type { ModelProviderAccount } from "@open-inspect/shared/types/provider-accounts";
import { setProviderAccountRouting } from "@/hooks/use-provider-accounts";

export function ProviderAccountRoutingSettings({
  policy,
  accounts,
  canManage,
  refresh,
}: {
  policy: ProviderAccountRouting;
  accounts: ModelProviderAccount[];
  canManage: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState(policy.selection.mode);
  const [selected, setSelected] = useState(
    policy.selection.mode === "random"
      ? policy.selection.accountIds
      : policy.selection.mode === "fixed"
        ? [policy.selection.accountId]
        : []
  );
  const [unattendedMode, setUnattendedMode] = useState(policy.unattendedMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep every selected ID visible, even when the account list omits archived rows.
  const candidates = [
    ...new Set([
      ...accounts
        .filter((account) => account.provider === policy.provider && account.archivedAt === null)
        .map((account) => account.id),
      ...selected,
    ]),
  ];
  async function save() {
    setSaving(true);
    setError(null);
    try {
      await setProviderAccountRouting(policy.provider, {
        expectedPolicyRevision: policy.policyRevision,
        unattendedMode,
        selection:
          mode === "random"
            ? { mode, accountIds: selected }
            : mode === "fixed"
              ? { mode, accountId: selected[0] }
              : { mode },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save policy");
    } finally {
      setSaving(false);
    }
  }
  return (
    <fieldset
      disabled={!canManage || saving}
      className="space-y-3 rounded-md border border-border-muted p-4"
    >
      <legend className="px-1 font-medium">{policy.provider} new-session account selection</legend>
      <label className="block">
        Selection
        <select
          className="ml-2 rounded border bg-background p-2"
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "fixed" || next === "random" || next === "unconfigured") {
              setMode(next);
              if (next === "fixed") setSelected(selected.slice(0, 1));
            }
          }}
        >
          <option value="unconfigured">No installation policy</option>
          <option value="fixed">Fixed account</option>
          <option value="random">Random from selected accounts</option>
        </select>
      </label>
      {mode !== "unconfigured" && (
        <div className="space-y-2">
          {candidates.map((accountId) => {
            const account = accounts.find(
              (item) => item.id === accountId && item.provider === policy.provider
            );
            const available = account?.status === "active" && account.archivedAt === null;
            const checked = selected.includes(accountId);
            return (
              <label key={accountId} className="flex items-center gap-2">
                <input
                  type={mode === "fixed" ? "radio" : "checkbox"}
                  name={`pool-${policy.provider}`}
                  disabled={!available && !(mode === "random" && checked)}
                  checked={checked}
                  onChange={(event) =>
                    setSelected(
                      mode === "fixed"
                        ? [accountId]
                        : event.target.checked
                          ? [...selected, accountId]
                          : selected.filter((id) => id !== accountId)
                    )
                  }
                />
                {account?.displayName ?? `Unavailable account ${accountId}`}
                {account && !available
                  ? ` (${account.archivedAt !== null ? "archived" : account.status})`
                  : ""}
              </label>
            );
          })}
        </div>
      )}
      <label className="block">
        Automated authentication
        <select
          className="ml-2 rounded border bg-background p-2"
          value={unattendedMode}
          onChange={(event) =>
            setUnattendedMode(event.target.value === "api_key" ? "api_key" : "provider_account")
          }
        >
          <option value="provider_account">Use subscription-account selection policy</option>
          <option value="api_key">API key</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        Applies only to new sessions. Explicit account choices bypass this policy. Random spreads
        assignments, not usage; active credentials do not guarantee remaining quota.
      </p>
      {error && <p role="alert">{error} Reload policies before retrying a stale edit.</p>}
      <button
        type="button"
        className="rounded border px-3 py-2"
        disabled={saving || (mode !== "unconfigured" && selected.length === 0)}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save selection policy"}
      </button>
    </fieldset>
  );
}
