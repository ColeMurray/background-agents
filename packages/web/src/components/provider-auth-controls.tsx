"use client";

import type {
  ModelProviderAccount,
  ModelProviderAccountDefault,
  ProviderAuthSelection,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { SUBSCRIPTION_PROVIDER_DISPLAY_METADATA } from "@open-inspect/shared/types/provider-accounts";
import { Label } from "@/components/ui/label";
import { MoreIcon } from "@/components/ui/icons";
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

export function ProviderAuthControls({
  provider,
  accounts,
  defaultValue,
  value,
  onChange,
  policyLabel = "Use default",
  unattended = false,
  variant = "select",
}: {
  provider: SubscriptionProviderId;
  accounts: ModelProviderAccount[];
  defaultValue?: ModelProviderAccountDefault;
  value?: ProviderAuthSelection;
  onChange: (value: ProviderAuthSelection | undefined) => void;
  policyLabel?: string;
  unattended?: boolean;
  variant?: "select" | "menu";
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
      : defaultAccount?.displayName;
  const policyDescription = effectiveDefaultLabel
    ? `${policyLabel}: ${effectiveDefaultLabel}`
    : policyLabel;
  const providerName = SUBSCRIPTION_PROVIDER_DISPLAY_METADATA[provider].displayName;
  const handleChange = (next: string) => {
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
            aria-label={`${providerName} authentication options`}
            title={`${providerName} authentication`}
          >
            <MoreIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-52 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>Session options</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{providerName} authentication</DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              collisionPadding={8}
              className="w-36 max-w-[calc(100vw-2rem)] sm:w-72"
            >
              <DropdownMenuRadioGroup value={selected} onValueChange={handleChange}>
                <DropdownMenuRadioItem value={POLICY}>
                  <span className="truncate">{policyDescription}</span>
                </DropdownMenuRadioItem>
                {available.map((account) => (
                  <DropdownMenuRadioItem key={account.id} value={`${ACCOUNT_PREFIX}${account.id}`}>
                    <span className="truncate">{account.displayName}</span>
                  </DropdownMenuRadioItem>
                ))}
                <DropdownMenuRadioItem value={API_KEY}>No account</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`provider-auth-${provider}`}>{providerName} authentication</Label>
      <Select value={selected} onValueChange={handleChange}>
        <SelectTrigger id={`provider-auth-${provider}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={POLICY}>{policyDescription}</SelectItem>
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
