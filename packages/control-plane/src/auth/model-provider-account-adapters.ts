import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";

export const DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_PROVIDER_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ProviderConnectionResult<TCredential> {
  credential: TCredential;
  externalAccountId?: string;
  accessTokenExpiresAt?: number;
}

export interface ProviderRefreshResult<TCredential> {
  credential: TCredential;
  accessToken: string;
  accessTokenExpiresAt: number;
  externalAccountId?: string;
}

export interface CachedProviderAccess {
  accessToken: string;
  accessTokenExpiresAt: number;
}

export interface ModelProviderAccountAdapter<TCredential, TConnectInput> {
  readonly provider: ModelProviderId;
  readonly credentialSchemaVersion: number;
  readonly refreshBufferMs: number;
  parseConnectInput(input: unknown): TConnectInput;
  connect(input: TConnectInput): Promise<ProviderConnectionResult<TCredential>>;
  parseCredential(payload: unknown, schemaVersion: number): TCredential;
  refresh(credential: TCredential, now?: number): Promise<ProviderRefreshResult<TCredential>>;
  cachedAccess(credential: TCredential): CachedProviderAccess | null;
  runtimeMetadata(
    credential: TCredential,
    externalAccountId: string | null
  ): Record<string, string>;
  validateExternalIdentity(actual: string | undefined, expected: string | null): void;
}

export type ProviderRefreshFailureClassification = "unauthorized" | "ambiguous" | "retry_safe";

export class ProviderRefreshError extends Error {
  constructor(
    message: string,
    readonly classification: ProviderRefreshFailureClassification,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export class ProviderCredentialError extends Error {}
export class ProviderIdentityError extends Error {}

type ErasedAdapter = ModelProviderAccountAdapter<unknown, unknown>;

export class ModelProviderAccountAdapterRegistry {
  private readonly adapters = new Map<ModelProviderId, ErasedAdapter>();

  constructor(adapters: readonly ErasedAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider)) {
        throw new Error(`Duplicate model provider account adapter: ${adapter.provider}`);
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  get(provider: ModelProviderId): ErasedAdapter | undefined {
    return this.adapters.get(provider);
  }

  require(provider: ModelProviderId): ErasedAdapter {
    const adapter = this.get(provider);
    if (!adapter) throw new Error(`Model provider account adapter unavailable: ${provider}`);
    return adapter;
  }
}
