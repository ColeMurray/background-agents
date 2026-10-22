import { generateId } from "../auth/crypto";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";

/** Broker the immutable connected provider account bound to one session. */
export class ProviderCredentialService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async getProviderAccess(
    sessionId: string,
    provider: ModelProviderId,
    rejectedCredentialVersion?: number
  ) {
    const binding = await new SessionIndexStore(this.db).getProviderAuthForProvider(
      sessionId,
      provider
    );
    if (!binding || binding.authMode !== "provider_account") {
      throw new Error("The session requires a connected provider account");
    }
    const broker = new ModelProviderAccountBroker(
      {
        accounts: new ModelProviderAccountStore(this.db),
        credentials: new ProviderCredentialStore(this.db, this.encryptionKey),
        atomicWriter: new D1ModelProviderAccountAtomicWriter(this.db, this.encryptionKey),
      },
      modelProviderAccountAdapterRegistry,
      { now: Date.now, createOwner: () => generateId() }
    );
    return broker.getAccess(binding.providerAccountId, provider, { rejectedCredentialVersion });
  }
}
