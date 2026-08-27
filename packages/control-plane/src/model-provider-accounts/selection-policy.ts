import { MODEL_PROVIDER_ACCOUNT_ID_PATTERN } from "@open-inspect/shared/types/provider-accounts";
import type {
  ModelProviderAccount,
  ModelProviderAccountStore,
} from "../db/model-provider-accounts";
import type { ModelProviderId } from "./provider-auth-contracts";
import { providerAccountIneligibility } from "./account-lifecycle-policy";

type ProviderAccountPolicyStatus = 400 | 404 | 409;

export interface ProviderAccountAdapterLookup {
  get(provider: ModelProviderId): object | undefined;
}

export class ProviderAccountSelectionPolicyError extends Error {
  constructor(
    message: string,
    readonly status: ProviderAccountPolicyStatus
  ) {
    super(message);
  }
}

export class ProviderAccountSelectionPolicy {
  constructor(
    private readonly accounts: Pick<ModelProviderAccountStore, "getById">,
    private readonly adapters: ProviderAccountAdapterLookup
  ) {}

  validateSelection(
    provider: ModelProviderId,
    providerAccountId: string
  ): Promise<ModelProviderAccount> {
    return this.validateActiveAccount(provider, providerAccountId, "Selected");
  }

  validateDefault(
    provider: ModelProviderId,
    providerAccountId: string
  ): Promise<ModelProviderAccount> {
    return this.validateActiveAccount(provider, providerAccountId, "Default");
  }

  private async validateActiveAccount(
    provider: ModelProviderId,
    providerAccountId: string,
    source: "Selected" | "Default"
  ): Promise<ModelProviderAccount> {
    if (!MODEL_PROVIDER_ACCOUNT_ID_PATTERN.test(providerAccountId)) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} provider account ID is invalid`,
        400
      );
    }
    if (!this.adapters.get(provider)) {
      throw new ProviderAccountSelectionPolicyError(
        `${provider} provider account adapter is unavailable`,
        409
      );
    }

    const account = await this.accounts.getById(providerAccountId);
    if (!account) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} ${provider} provider account was not found`,
        404
      );
    }
    if (account.provider !== provider) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} provider account does not belong to ${provider}`,
        400
      );
    }
    if (providerAccountIneligibility(account, "active_use")) {
      throw new ProviderAccountSelectionPolicyError(
        `${source} ${provider} provider account is unavailable`,
        409
      );
    }
    return account;
  }
}
