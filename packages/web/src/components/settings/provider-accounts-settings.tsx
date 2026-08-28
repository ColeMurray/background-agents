"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  modelProviderAccountReconnectMethod,
  SUBSCRIPTION_PROVIDER_DISPLAY_METADATA,
  type ModelProviderAccount,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import {
  archiveProviderAccount,
  reconnectProviderAccount,
  renameProviderAccount,
  runProviderAccountAction,
  setProviderAccountDefault,
  useLegacyProviderCredentials,
  useProviderAccounts,
  type LegacyProviderKeyLocation,
} from "@/hooks/use-provider-accounts";
import {
  ProviderDeviceAuthorizationDialog,
  type ProviderDeviceAuthorizationTarget,
} from "@/components/settings/provider-device-authorization-dialog";
import { formatRelativeTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBanner } from "@/components/ui/error-banner";
import { MoreIcon, PlusIcon } from "@/components/ui/icons";
import { SubscriptionProviderIcon } from "@/components/subscription-provider-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type Confirm = { account: ModelProviderAccount; action: "disable" | "archive" } | null;
type Connection =
  | { kind: "device"; target: ProviderDeviceAuthorizationTarget }
  | { kind: "legacy-xai"; account: ModelProviderAccount };

type ConnectionStrategy = {
  add: () => Connection;
  reconnect: (account: ModelProviderAccount) => Connection;
};

const CONNECTION_STRATEGIES: Record<SubscriptionProviderId, ConnectionStrategy> = {
  openai: {
    add: () => ({ kind: "device", target: { provider: "openai", operation: "create" } }),
    reconnect: (account) => ({
      kind: "device",
      target: {
        provider: "openai",
        operation: "reconnect",
        providerAccountId: account.id,
        displayName: account.displayName,
      },
    }),
  },
  xai: {
    add: () => ({ kind: "device", target: { provider: "xai", operation: "create" } }),
    reconnect: (account) =>
      modelProviderAccountReconnectMethod(account) === "device_authorization"
        ? {
            kind: "device",
            target: {
              provider: "xai",
              operation: "reconnect",
              providerAccountId: account.id,
              displayName: account.displayName,
            },
          }
        : { kind: "legacy-xai", account },
  },
};

function dateLabel(timestamp: number | null) {
  return timestamp ? new Date(timestamp).toLocaleString() : "Never";
}

function relativeDateLabel(timestamp: number | null) {
  if (!timestamp) return "Never";
  const relative = formatRelativeTime(timestamp);
  return relative === "now" ? relative : `${relative} ago`;
}

function accountStatusLabel(status: ModelProviderAccount["status"]) {
  if (status === "reconnect_required") return "Reconnect required";
  if (status === "disabled") return "Disabled";
  return "Ready";
}

function legacyKeyLocationLabel(location: LegacyProviderKeyLocation): string {
  if (location.scope === "global") return `Global: ${location.key}`;
  if (location.scope === "repository") {
    return `Repository ${location.repository} (${location.scopeId}): ${location.key}`;
  }
  return `Environment ${location.scopeId}: ${location.key}`;
}

function connectionToastMessage(
  provider: SubscriptionProviderId,
  reconnectedExisting: boolean,
  operation: ProviderDeviceAuthorizationTarget["operation"]
): string {
  if (!reconnectedExisting) {
    return `${SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[provider].subscriptionName} account connected`;
  }
  return operation === "reconnect"
    ? "Account reconnected"
    : `Existing ${SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[provider].subscriptionName} account reconnected`;
}

function LegacyReconnectForm({
  account,
  saving,
  onSave,
  onCancel,
}: {
  account: ModelProviderAccount;
  saving: boolean;
  onSave: (refreshToken: string) => void;
  onCancel: () => void;
}) {
  const [refreshToken, setRefreshToken] = useState("");

  return (
    <div className="space-y-3 rounded-md border border-border-muted p-4">
      <h3 className="font-medium">Reconnect {account.displayName}</h3>
      <p className="text-xs text-muted-foreground">
        This legacy account predates device authorization. Enter a fresh xAI refresh token once; new
        SuperGrok accounts connect through xAI directly.
      </p>
      <div>
        <Label htmlFor="provider-refresh-token">Refresh token</Label>
        <Input
          id="provider-refresh-token"
          type="password"
          autoComplete="off"
          value={refreshToken}
          onChange={(event) => setRefreshToken(event.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={saving || !refreshToken} onClick={() => onSave(refreshToken)}>
          Save
        </Button>
        <Button size="sm" variant="subtle" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ProviderAccountsSettings() {
  const { providers, accounts, defaults, loading, error, refresh } = useProviderAccounts();
  const legacyCredentials = useLegacyProviderCredentials();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [saving, setSaving] = useState(false);
  const operationInFlightRef = useRef(false);

  async function run(operation: () => Promise<unknown>, success: string) {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setSaving(true);
    try {
      await operation();
      await refresh();
      setConnection(null);
      setConfirm(null);
      toast.success(success);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Provider account request failed");
    } finally {
      operationInFlightRef.current = false;
      setSaving(false);
    }
  }

  function beginConnection(next: Connection) {
    if (!operationInFlightRef.current) setConnection(next);
  }

  function beginConfirmation(next: Exclude<Confirm, null>) {
    if (!operationInFlightRef.current) setConfirm(next);
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading provider accounts...</p>;
  if (error) return <ErrorBanner role="alert">Failed to load provider accounts.</ErrorBanner>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Provider Accounts</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connected subscriptions are installation-wide. Credential values are write-only.
        </p>
      </div>

      {legacyCredentials.error && (
        <ErrorBanner role="alert">Failed to inspect legacy OAuth credentials.</ErrorBanner>
      )}

      {!legacyCredentials.loading &&
        !legacyCredentials.error &&
        legacyCredentials.legacyKeys.length > 0 && (
          <div className="rounded-md border border-border-muted p-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">Legacy OAuth credentials</h3>
              <p className="text-xs text-muted-foreground">
                Existing legacy-bound sessions may depend on these credentials. Provider-account
                defaults affect only sessions created afterward.
              </p>
            </div>
            <ul className="mt-3 space-y-1 text-xs text-destructive">
              {legacyCredentials.legacyKeys.map((location) => (
                <li
                  key={`${location.scope}:${"scopeId" in location ? location.scopeId : ""}:${location.key}`}
                >
                  {legacyKeyLocationLabel(location)}
                </li>
              ))}
            </ul>
          </div>
        )}

      {providers.length === 0 ? (
        <div className="rounded-md border border-border-muted p-4 text-sm text-muted-foreground">
          No subscription providers are available.
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-md border border-border-muted">
            <div className="flex items-center justify-between gap-3 border-b border-border-muted p-4">
              <h3 className="font-medium text-foreground">Connected accounts</h3>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="subtle" disabled={saving}>
                    <PlusIcon className="size-4" />
                    Add account
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Subscriptions</DropdownMenuLabel>
                  {providers.map((provider) => (
                    <DropdownMenuItem
                      key={provider.provider}
                      disabled={saving}
                      onSelect={() =>
                        beginConnection(CONNECTION_STRATEGIES[provider.provider].add())
                      }
                    >
                      <SubscriptionProviderIcon
                        provider={provider.provider}
                        className="size-5 text-primary"
                      />
                      <span>{provider.subscriptionName}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {accounts.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No accounts connected.</p>
            ) : (
              <div className="divide-y divide-border-muted">
                {accounts.map((account) => {
                  const provider = providers.find((item) => item.provider === account.provider);
                  const providerDefault = defaults.find(
                    (item) => item.provider === account.provider
                  );
                  const isDefault = providerDefault?.providerAccountId === account.id;
                  const isDefaultForAutomation =
                    isDefault && providerDefault.unattendedMode === "provider_account";
                  const externalAccountId = account.externalAccountId;
                  return (
                    <div key={account.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="flex size-10 shrink-0 items-center justify-center text-foreground">
                            <SubscriptionProviderIcon
                              provider={account.provider}
                              className="size-6 text-primary"
                            />
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-medium text-foreground">
                                {account.displayName}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {provider?.subscriptionName ?? account.provider}
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded px-1.5 py-0.5 text-xs ${
                                  account.status === "active"
                                    ? "bg-success-muted text-success"
                                    : account.status === "reconnect_required"
                                      ? "bg-warning-muted text-warning"
                                      : "bg-muted text-muted-foreground"
                                }`}
                              >
                                {accountStatusLabel(account.status)}
                              </span>
                              {isDefaultForAutomation && (
                                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                                  Default for automation
                                </span>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span
                                className="whitespace-nowrap"
                                title={
                                  account.lastVerifiedAt
                                    ? dateLabel(account.lastVerifiedAt)
                                    : undefined
                                }
                              >
                                Verified {relativeDateLabel(account.lastVerifiedAt)}
                              </span>
                              <span
                                className="whitespace-nowrap"
                                title={
                                  account.lastUsedAt ? dateLabel(account.lastUsedAt) : undefined
                                }
                              >
                                Used {relativeDateLabel(account.lastUsedAt)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {account.status === "reconnect_required" && (
                            <Button
                              size="xs"
                              disabled={saving}
                              onClick={() =>
                                beginConnection(
                                  CONNECTION_STRATEGIES[account.provider].reconnect(account)
                                )
                              }
                            >
                              Reconnect
                            </Button>
                          )}
                          {account.status === "disabled" && (
                            <Button
                              size="xs"
                              disabled={saving}
                              onClick={() =>
                                void run(
                                  () => runProviderAccountAction(account.id, "enable"),
                                  "Account enabled"
                                )
                              }
                            >
                              Enable
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="icon"
                                variant="subtle"
                                className="size-7"
                                aria-label={`More actions for ${account.displayName}`}
                                disabled={saving}
                              >
                                <MoreIcon className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {account.status !== "reconnect_required" && (
                                <DropdownMenuItem
                                  disabled={saving}
                                  onSelect={() =>
                                    beginConnection(
                                      CONNECTION_STRATEGIES[account.provider].reconnect(account)
                                    )
                                  }
                                >
                                  Reconnect
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                disabled={saving || account.status !== "active"}
                                onSelect={() =>
                                  void run(
                                    () => runProviderAccountAction(account.id, "verify"),
                                    "Account verified"
                                  )
                                }
                              >
                                Verify
                              </DropdownMenuItem>
                              {account.status === "active" && !isDefault && (
                                <DropdownMenuItem
                                  disabled={saving}
                                  onSelect={() =>
                                    void run(
                                      () =>
                                        setProviderAccountDefault(
                                          account.provider,
                                          account.id,
                                          providerDefault?.unattendedMode ?? "provider_account"
                                        ),
                                      "Default updated"
                                    )
                                  }
                                >
                                  Make default
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                disabled={saving}
                                onSelect={() => {
                                  if (operationInFlightRef.current) return;
                                  const displayName = window
                                    .prompt("Account name", account.displayName)
                                    ?.trim();
                                  if (displayName)
                                    void run(
                                      () => renameProviderAccount(account.id, displayName),
                                      "Account renamed"
                                    );
                                }}
                              >
                                Rename
                              </DropdownMenuItem>
                              {externalAccountId && (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    void navigator.clipboard
                                      .writeText(externalAccountId)
                                      .then(() => toast.success("Account ID copied"))
                                      .catch(() => toast.error("Failed to copy account ID"))
                                  }
                                >
                                  Copy account ID
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              {account.status === "active" && (
                                <DropdownMenuItem
                                  disabled={saving}
                                  onSelect={() => beginConfirmation({ account, action: "disable" })}
                                >
                                  Disable
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                disabled={saving}
                                onSelect={() => beginConfirmation({ account, action: "archive" })}
                              >
                                Archive
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                      {account.status !== "active" && (
                        <p
                          className={`mt-3 rounded-md px-3 py-2 text-xs ${
                            account.status === "reconnect_required"
                              ? "bg-warning-muted text-warning"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {account.status === "reconnect_required"
                            ? "This account cannot start new sessions until it is reconnected."
                            : "This account is disabled and is not available for new sessions."}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-md border border-border-muted">
            <div className="border-b border-border-muted p-4">
              <h3 className="font-medium text-foreground">Automated sessions</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose credentials for sessions started by automations, bots, or other agents.
              </p>
            </div>
            <div className="divide-y divide-border-muted">
              {providers.map((provider) => {
                const providerDefault = defaults.find(
                  (item) => item.provider === provider.provider
                );
                const defaultAccount = accounts.find(
                  (account) => account.id === providerDefault?.providerAccountId
                );
                return (
                  <div
                    key={provider.provider}
                    className="grid gap-3 p-4 sm:grid-cols-[minmax(8rem,0.6fr)_1fr] sm:items-end"
                  >
                    <div className="flex items-center gap-2 self-center font-medium text-foreground">
                      <SubscriptionProviderIcon
                        provider={provider.provider}
                        className="size-5 text-primary"
                      />
                      {provider.subscriptionName}
                    </div>
                    <div>
                      {providerDefault ? (
                        <>
                          <Label htmlFor={`unattended-${provider.provider}`}>
                            Automated authentication
                          </Label>
                          <Select
                            disabled={saving}
                            value={providerDefault.unattendedMode}
                            onValueChange={(value: "provider_account" | "api_key") => {
                              if (!operationInFlightRef.current)
                                void run(
                                  () =>
                                    setProviderAccountDefault(
                                      provider.provider,
                                      providerDefault.providerAccountId,
                                      value
                                    ),
                                  "Authentication updated"
                                );
                            }}
                          >
                            <SelectTrigger id={`unattended-${provider.provider}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="provider_account">
                                Use default: {defaultAccount?.displayName ?? "Unavailable account"}
                              </SelectItem>
                              <SelectItem value="api_key">No account (API key)</SelectItem>
                            </SelectContent>
                          </Select>
                        </>
                      ) : (
                        <div className="rounded-md border border-dashed border-border-muted px-3 py-2">
                          <p className="text-xs font-medium text-muted-foreground">
                            Automated authentication
                          </p>
                          <p className="text-sm text-foreground">No default account selected</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            Choose Make default from an account above.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {connection?.kind === "device" && (
        <ProviderDeviceAuthorizationDialog
          key={
            connection.target.operation === "create"
              ? `${connection.target.provider}:create`
              : `${connection.target.provider}:reconnect:${connection.target.providerAccountId}`
          }
          target={connection.target}
          onClose={() => setConnection(null)}
          onConnected={(result) => {
            const target = connection.target;
            setConnection(null);
            void refresh();
            toast.success(
              connectionToastMessage(target.provider, result.reconnectedExisting, target.operation)
            );
          }}
        />
      )}

      {connection?.kind === "legacy-xai" && (
        <LegacyReconnectForm
          key={connection.account.id}
          account={connection.account}
          saving={saving}
          onSave={(refreshToken) =>
            void run(
              () =>
                reconnectProviderAccount(connection.account.id, {
                  provider: "xai",
                  refreshToken,
                }),
              "Account reconnected"
            )
          }
          onCancel={() => setConnection(null)}
        />
      )}

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.action === "archive" ? "Archive" : "Disable"} this account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Running sessions may retain issued access until it expires. Defaults and pinned
              automations can cause a conflict and must be updated first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                if (confirm)
                  void run(
                    () =>
                      confirm.action === "archive"
                        ? archiveProviderAccount(confirm.account.id)
                        : runProviderAccountAction(confirm.account.id, "disable"),
                    confirm.action === "archive" ? "Account archived" : "Account disabled"
                  );
              }}
            >
              {confirm?.action === "archive" ? "Archive" : "Disable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
