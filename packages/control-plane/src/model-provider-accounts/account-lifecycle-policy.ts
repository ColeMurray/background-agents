import type { ModelProviderAccount } from "../db/model-provider-accounts";

export type ProviderAccountOperation = "active_use" | "reconnect";
export type ProviderAccountIneligibility = "archived" | "disabled" | "reconnect_required";

/**
 * Canonical lifecycle policy for provider-account operations.
 * Runtime access, selection, defaults, and verification require an active
 * account. Reconnect accepts any non-archived account because it installs a
 * fresh credential and returns the account to active state.
 */
export function providerAccountIneligibility(
  account: ModelProviderAccount,
  operation: ProviderAccountOperation
): ProviderAccountIneligibility | null {
  if (account.archivedAt !== null) return "archived";
  if (operation === "reconnect") return null;
  return account.status === "active" ? null : account.status;
}
