import { generateId } from "../auth/crypto";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import { ModelProviderAccountBroker } from "../auth/model-provider-account-broker";
import { D1ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import { ProviderCredentialStore } from "../db/provider-account-credentials";
import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";

/** Broker the immutable connected OpenAI account bound to one session. */
export class PiCredentialService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async getOpenAIAccess(sessionId: string) {
    const binding = await new SessionIndexStore(this.db).getProviderAuthForProvider(
      sessionId,
      "openai"
    );
    if (!binding || binding.authMode !== "provider_account") {
      throw new Error("Pi Durable requires a connected OpenAI provider account");
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
    return broker.getAccess(binding.providerAccountId, "openai");
  }
}
