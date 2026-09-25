import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import { z } from "zod";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import type { SqlDatabase } from "../db/sql-database";
import { ProviderAccountSelectionPolicy } from "./selection-policy";

export async function prepareSwitchTarget(
  db: SqlDatabase,
  encryptionKey: string,
  provider: SubscriptionProviderId,
  accountId: string
): Promise<void> {
  const accounts = new ModelProviderAccountStore(db);
  const credentials = new ProviderCredentialStore(db, encryptionKey);
  const policy = new ProviderAccountSelectionPolicy(accounts, modelProviderAccountAdapterRegistry);
  await policy.validateSelection(provider, accountId);
  if (provider === "anthropic") {
    const state = await credentials.readCredentialState(accountId, provider);
    if (!state) throw new Error("credential_unavailable");
    const payload = modelProviderAccountAdapterRegistry
      .require(provider)
      .parseCredential(state.payload, state.credentialSchemaVersion);
    const parsed = z.object({ token: z.string().min(1), expiresAt: z.number() }).safeParse(payload);
    if (!parsed.success || parsed.data.expiresAt <= Date.now() + 3_600_000)
      throw new Error("credential_unavailable");
  } else {
    await new ModelProviderAccountBroker(
      {
        accounts,
        credentials,
        atomicWriter: new D1ModelProviderAccountAtomicWriter(db, encryptionKey),
      },
      modelProviderAccountAdapterRegistry,
      { now: Date.now, createOwner: () => crypto.randomUUID() }
    ).getAccess(accountId, provider);
  }
  await policy.validateSelection(provider, accountId);
}
