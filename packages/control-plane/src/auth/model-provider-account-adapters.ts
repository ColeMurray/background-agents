import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";

export const DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
export const DEFAULT_PROVIDER_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ProviderConnectionResult<TCredential> {
  credential: TCredential;
  externalAccountId?: string;
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

interface ProviderAuthorizationCodeStart<TProviderState> {
  providerState: TProviderState;
  /** The provider's consent page; it shows the code the user pastes back. */
  authorizationUrl: string;
  expiresInMs?: number;
}

/**
 * Authorization-code connections: the control plane holds the PKCE verifier
 * and state, the user grants access at the provider and pastes the displayed
 * code back, and `complete` exchanges it. Anthropic's setup-token flow.
 */
export interface ProviderAuthorizationCodeCapability<TCredential, TProviderState> {
  readonly stateSchemaVersion: number;
  start(): Promise<ProviderAuthorizationCodeStart<TProviderState>>;
  parseState(payload: unknown, schemaVersion: number): TProviderState;
  /**
   * Exchange the pasted code. A failure the orchestration can act on is a
   * `ProviderAuthorizationCodeExchangeError`; anything else fails closed.
   */
  complete(
    providerState: TProviderState,
    pastedCode: string
  ): Promise<ProviderConnectionResult<TCredential>>;
}

export interface ErasedProviderAuthorizationCodeCapability {
  readonly stateSchemaVersion: number;
  start(): Promise<ProviderAuthorizationCodeStart<unknown>>;
  completePersisted(
    payload: unknown,
    schemaVersion: number,
    pastedCode: string
  ): Promise<ProviderConnectionResult<unknown>>;
}

/**
 * What a sandbox receives at runtime: a short-lived brokered access token
 * minted per request (OpenAI, xAI), or the stored static secret itself,
 * delivered once at boot (Anthropic).
 */
export type ProviderRuntimeCredentialKind = "brokered_access_token" | "stored_provider_secret";

interface ErasedProviderDeviceAuthorizationCapability {
  readonly stateSchemaVersion: number;
  start(): Promise<ProviderDeviceAuthorizationStart<unknown>>;
  pollPersisted(
    payload: unknown,
    schemaVersion: number,
    intervalMs: number
  ): Promise<ProviderDeviceAuthorizationPollResult<unknown>>;
}

export interface ProviderRefreshResult<TCredential> {
  credential: TCredential;
  accessToken: string;
  accessTokenExpiresAt: number;
  externalAccountId?: string;
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
  readonly authorizationCode?: ProviderAuthorizationCodeCapability<TCredential, unknown>;
  /** Absent means true: the provider can be asked to verify a stored credential. */
  readonly supportsVerification?: boolean;
  /** Absent means brokered_access_token. */
  readonly runtimeCredentialKind?: ProviderRuntimeCredentialKind;
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

/**
 * How an authorization-code exchange failed, in terms every completion
 * strategy can act on. `rejected` is the provider's verdict on this code and
 * is terminal. `retry_safe` means the provider refused to look at the code
 * (throttling), so the same code can be submitted again. `ambiguous` means
 * the provider may have received and consumed the one-use code without the
 * control plane learning the result; only a fresh authorization is safe.
 */
export type ProviderAuthorizationCodeExchangeClassification =
  | "rejected"
  | "retry_safe"
  | "ambiguous";

export class ProviderAuthorizationCodeExchangeError extends Error {
  constructor(
    message: string,
    readonly classification: ProviderAuthorizationCodeExchangeClassification,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProviderAuthorizationCodeExchangeError";
  }
}

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

  requireAuthorizationCode(provider: ModelProviderId): ErasedProviderAuthorizationCodeCapability {
    const capability = this.require(provider).authorizationCode;
    if (!capability) throw new Error(`Authorization code flow unavailable: ${provider}`);
    return {
      stateSchemaVersion: capability.stateSchemaVersion,
      start: () => capability.start(),
      completePersisted: (payload, schemaVersion, pastedCode) =>
        capability.complete(capability.parseState(payload, schemaVersion), pastedCode),
    };
  }

  runtimeCredentialKind(provider: ModelProviderId): ProviderRuntimeCredentialKind {
    return this.require(provider).runtimeCredentialKind ?? "brokered_access_token";
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
