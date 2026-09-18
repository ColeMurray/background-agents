import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";

export const DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_PROVIDER_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * The identity a provider account is bound to.
 *
 * `externalAccountId` is the subscription the credential bills through; `externalPrincipalId` is
 * the individual seat within it. They differ on providers where one subscription has many seats
 * (a ChatGPT Business workspace), where the account id alone cannot tell two members apart. A
 * null principal means the seat was never recorded — accounts connected before seats were
 * tracked, and providers that expose no seat at all.
 */
export interface ProviderExternalIdentity {
  externalAccountId: string | null;
  externalPrincipalId: string | null;
}

/** The identity observed on a freshly issued set of provider tokens. */
export interface ProviderObservedIdentity {
  externalAccountId?: string;
  externalPrincipalId?: string;
}

export interface ProviderConnectionResult<TCredential> extends ProviderObservedIdentity {
  credential: TCredential;
  /** Human-readable name for the seat, used to title a newly connected account. */
  externalPrincipalLabel?: string;
  accessTokenExpiresAt?: number;
}

interface ProviderDeviceAuthorizationStart<TProviderState> {
  providerState: TProviderState;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs?: number;
}

export type ProviderDeviceAuthorizationPollResult<TCredential> =
  | { status: "pending"; intervalMs?: number }
  | { status: "connected"; connection: ProviderConnectionResult<TCredential> }
  | { status: "denied" | "expired" | "failed" };

export interface ProviderDeviceAuthorizationCapability<TCredential, TProviderState> {
  readonly stateSchemaVersion: number;
  start(): Promise<ProviderDeviceAuthorizationStart<TProviderState>>;
  parseState(payload: unknown, schemaVersion: number): TProviderState;
  poll(
    providerState: TProviderState,
    intervalMs: number
  ): Promise<ProviderDeviceAuthorizationPollResult<TCredential>>;
}

interface ErasedProviderDeviceAuthorizationCapability {
  readonly stateSchemaVersion: number;
  start(): Promise<ProviderDeviceAuthorizationStart<unknown>>;
  pollPersisted(
    payload: unknown,
    schemaVersion: number,
    intervalMs: number
  ): Promise<ProviderDeviceAuthorizationPollResult<unknown>>;
}

export interface ProviderRefreshResult<TCredential> extends ProviderObservedIdentity {
  credential: TCredential;
  accessToken: string;
  accessTokenExpiresAt: number;
}

interface CachedProviderAccess {
  accessToken: string;
  accessTokenExpiresAt: number;
}

export interface ModelProviderAccountAdapter<TCredential, TConnectInput> {
  readonly provider: ModelProviderId;
  readonly credentialSchemaVersion: number;
  readonly refreshBufferMs: number;
  readonly deviceAuthorization?: ProviderDeviceAuthorizationCapability<TCredential, unknown>;
  parseConnectInput(input: unknown): TConnectInput;
  connect(input: TConnectInput): Promise<ProviderConnectionResult<TCredential>>;
  parseCredential(payload: unknown, schemaVersion: number): TCredential;
  refresh(credential: TCredential, now?: number): Promise<ProviderRefreshResult<TCredential>>;
  cachedAccess(credential: TCredential): CachedProviderAccess | null;
  validateReconnectInputIdentity(
    input: TConnectInput,
    expectedExternalAccountId: string | null
  ): void;
  runtimeMetadata(
    credential: TCredential,
    externalAccountId: string | null
  ): Record<string, string>;
  validateExternalIdentity(
    actual: ProviderObservedIdentity,
    expected: ProviderExternalIdentity
  ): void;
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

  requireDeviceAuthorization(
    provider: ModelProviderId
  ): ErasedProviderDeviceAuthorizationCapability {
    const capability = this.require(provider).deviceAuthorization;
    if (!capability) throw new Error(`Device authorization unavailable: ${provider}`);
    return eraseDeviceAuthorizationCapability(capability);
  }
}

function eraseDeviceAuthorizationCapability<TCredential, TProviderState>(
  capability: ProviderDeviceAuthorizationCapability<TCredential, TProviderState>
): ErasedProviderDeviceAuthorizationCapability {
  return {
    stateSchemaVersion: capability.stateSchemaVersion,
    start: () => capability.start(),
    pollPersisted: (payload, schemaVersion, intervalMs) =>
      capability.poll(capability.parseState(payload, schemaVersion), intervalMs),
  };
}
