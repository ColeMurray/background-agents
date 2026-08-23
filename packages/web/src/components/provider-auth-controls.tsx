"use client";

import type {
  ModelProviderAccount,
  ModelProviderAccountDefault,
  ProviderAuthSelection,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { SUBSCRIPTION_PROVIDER_DISPLAY_METADATA } from "@open-inspect/shared/types/provider-accounts";
import { Label } from "@/components/ui/label";
import { SubscriptionProviderIcon } from "@/components/subscription-provider-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const POLICY = "policy";
const API_KEY = "api_key";
const ACCOUNT_PREFIX = "account:";
const DEFAULT_POLICY_LABEL = "Use default";
const DEFAULT_UNATTENDED = false;
const DEFAULT_VARIANT = "select";
const DEFAULT_DISABLED = false;

export function ProviderAuthControls({
  provider,
  accounts,
  defaultValue,
  value,
  onChange,
  policyLabel = DEFAULT_POLICY_LABEL,
  unattended = DEFAULT_UNATTENDED,
  variant = DEFAULT_VARIANT,
  disabled = DEFAULT_DISABLED,
}: {
  provider: SubscriptionProviderId;
  accounts: ModelProviderAccount[];
  defaultValue?: ModelProviderAccountDefault;
  value?: ProviderAuthSelection;
  onChange: (value: ProviderAuthSelection | undefined) => void;
  policyLabel?: string;
  unattended?: boolean;
  variant?: "select" | "menu";
  disabled?: boolean;
}) {
  const available = accounts.filter(
    (account) => account.provider === provider && account.status === "active" && !account.archivedAt
  );
  const selected = value
    ? value.mode === "api_key"
      ? API_KEY
      : `${ACCOUNT_PREFIX}${value.accountId}`
    : POLICY;
  const defaultAccount = available.find(
    (account) => account.id === defaultValue?.providerAccountId
  );
  const effectiveDefaultLabel =
    unattended && defaultValue?.unattendedMode === "api_key"
      ? "No account"
      : defaultValue
        ? (defaultAccount?.displayName ?? "Unavailable account")
        : undefined;
  const explicitAccount =
    value?.mode === "provider_account"
      ? available.find((account) => account.id === value.accountId)
      : undefined;
  const triggerSelectionLabel = value
    ? value.mode === "api_key"
      ? "No account"
      : (explicitAccount?.displayName ?? "Unavailable account")
    : (effectiveDefaultLabel ?? "Use default");
  const policyDescription = effectiveDefaultLabel
    ? `${policyLabel}: ${effectiveDefaultLabel}`
    : policyLabel;
  const providerName = SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[provider].displayName;
  const handleChange = (next: string) => {
    if (disabled) return;
    if (next === POLICY) onChange(undefined);
    else if (next === API_KEY) onChange({ mode: "api_key" });
    else onChange({ mode: "provider_account", accountId: next.slice(ACCOUNT_PREFIX.length) });
  };

  if (variant === "menu") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`rounded p-1 transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${value ? "text-accent" : "text-muted-foreground"}`}
            aria-label={`${providerName} authentication options, ${triggerSelectionLabel}`}
            title={`${providerName} authentication`}
            disabled={disabled}
          >
            <SubscriptionProviderIcon provider={provider} className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-52 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>Session options</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={disabled}
              aria-label={`${providerName} authentication`}
            >
              <SubscriptionProviderIcon provider={provider} className="size-3.5" />
              authentication
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              collisionPadding={8}
              className="w-36 max-w-[calc(100vw-2rem)] sm:w-72"
            >
              <DropdownMenuRadioGroup value={selected} onValueChange={handleChange}>
                <DropdownMenuRadioItem value={POLICY} disabled={disabled}>
                  <span className="truncate">{policyDescription}</span>
                </DropdownMenuRadioItem>
                {available.map((account) => (
                  <DropdownMenuRadioItem
                    key={account.id}
                    value={`${ACCOUNT_PREFIX}${account.id}`}
                    disabled={disabled}
                  >
                    <span className="truncate">{account.displayName}</span>
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value={API_KEY} disabled={disabled}>
                  No account
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`provider-auth-${provider}`} className="flex items-center gap-1.5">
        <SubscriptionProviderIcon provider={provider} className="size-4" />
        authentication
      </Label>
      <Select value={selected} onValueChange={handleChange} disabled={disabled}>
        <SelectTrigger
          id={`provider-auth-${provider}`}
          aria-label={`${providerName} authentication`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={POLICY}>{policyDescription}</SelectItem>
          {value?.mode === "provider_account" && !explicitAccount && (
            <SelectItem value={`${ACCOUNT_PREFIX}${value.accountId}`}>
              Unavailable account
            </SelectItem>
          )}
          {available.map((account) => (
            <SelectItem key={account.id} value={`${ACCOUNT_PREFIX}${account.id}`}>
              {account.displayName}
              {account.externalAccountId ? ` (${account.externalAccountId})` : ""}
            </SelectItem>
          ))}
          <SelectItem value={API_KEY}>No account</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Provider-account mode overrides this provider&apos;s API key for the session.
      </p>
    </div>
  );
}
