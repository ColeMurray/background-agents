import { z } from "zod";
import {
  connectAnthropicModelProviderAccountRequestSchema,
  reconnectAnthropicModelProviderAccountRequestSchema,
  type ConnectModelProviderAccountRequest,
  type ReconnectModelProviderAccountRequest,
} from "@open-inspect/shared/types/provider-accounts";
import {
  AnthropicTokenError,
  exchangeAnthropicAuthorizationCode,
  refreshAnthropicToken,
  type AnthropicInitialTokenResponse,
  type AnthropicRefreshTokenResponse,
} from "./anthropic";
import {
  DEFAULT_PROVIDER_REFRESH_BUFFER_MS,
  ProviderCredentialError,
  ProviderIdentityError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "./model-provider-account-adapters";

const DEFAULT_ANTHROPIC_ACCESS_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;
const MAX_ANTHROPIC_TOKEN_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const credentialSchema = z.strictObject({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.number().int().positive(),
  refreshTokenExpiresAt: z.number().int().positive().optional(),
  scopes: z.array(z.string().min(1).max(256)).max(64).optional(),
});
const connectInputSchema = z.union([
  connectAnthropicModelProviderAccountRequestSchema,
  reconnectAnthropicModelProviderAccountRequestSchema,
]);

export type AnthropicProviderCredential = z.infer<typeof credentialSchema>;
export type AnthropicProviderConnectInput =
  | Extract<ConnectModelProviderAccountRequest, { provider: "anthropic" }>
  | Extract<ReconnectModelProviderAccountRequest, { provider: "anthropic" }>;

type ExchangeAnthropic = typeof exchangeAnthropicAuthorizationCode;
type RefreshAnthropic = typeof refreshAnthropicToken;

function refreshTokenExpiresAt(
  tokens: AnthropicInitialTokenResponse | AnthropicRefreshTokenResponse,
  now: number,
  existing?: number
): number | undefined {
  if (tokens.refresh_token_expires_at !== undefined) {
    return validateAbsoluteExpiry(tokens.refresh_token_expires_at, now, "refresh token");
  }
  if (tokens.refresh_token_expires_in !== undefined) {
    return now + tokens.refresh_token_expires_in * 1000;
  }
  return existing;
}

function scopes(scope: string | undefined, existing?: string[]): string[] | undefined {
  return scope === undefined ? existing : scope.split(/\s+/);
}

function accessTokenExpiresAt(
  tokens: AnthropicInitialTokenResponse | AnthropicRefreshTokenResponse,
  now: number
): number {
  if (tokens.expires_at !== undefined) {
    return validateAbsoluteExpiry(tokens.expires_at, now, "access token");
  }
  return (
    now +
    (tokens.expires_in === undefined
      ? DEFAULT_ANTHROPIC_ACCESS_TOKEN_LIFETIME_MS
      : tokens.expires_in * 1000)
  );
}

function validateAbsoluteExpiry(value: number, now: number, label: string): number {
  if (value <= now || value - now > MAX_ANTHROPIC_TOKEN_LIFETIME_MS) {
    throw new ProviderRefreshError(`Anthropic ${label} expiry was invalid`, "ambiguous");
  }
  return value;
}

function mapTokenError(error: unknown, operation: string): ProviderRefreshError {
  const unauthorized = error instanceof AnthropicTokenError && error.reason === "unauthorized";
  const diagnostics =
    error instanceof AnthropicTokenError
      ? ` (status ${error.status}, reason ${error.reason})`
      : error instanceof Error
        ? ` (cause ${error.name})`
        : "";
  return new ProviderRefreshError(
    unauthorized
      ? `Anthropic ${operation} was unauthorized${diagnostics}`
      : `Anthropic ${operation} outcome was ambiguous${diagnostics}`,
    unauthorized ? "unauthorized" : "ambiguous",
    { cause: error }
  );
}

export class AnthropicModelProviderAccountAdapter implements ModelProviderAccountAdapter<
  AnthropicProviderCredential,
  AnthropicProviderConnectInput
> {
  readonly provider = "anthropic" as const;
  readonly credentialSchemaVersion = 1;
  readonly refreshBufferMs = DEFAULT_PROVIDER_REFRESH_BUFFER_MS;

  constructor(
    private readonly exchangeCode: ExchangeAnthropic = exchangeAnthropicAuthorizationCode,
    private readonly refreshToken: RefreshAnthropic = refreshAnthropicToken
  ) {}

  parseConnectInput(input: unknown): AnthropicProviderConnectInput {
    return connectInputSchema.parse(input);
  }

  async connect(
    input: AnthropicProviderConnectInput,
    now = Date.now()
  ): Promise<ProviderConnectionResult<AnthropicProviderCredential>> {
    try {
      const tokens = await this.exchangeCode(input);
      const expiry = accessTokenExpiresAt(tokens, now);
      const refreshExpiry = refreshTokenExpiresAt(tokens, now);
      const grantedScopes = scopes(tokens.scope);
      return {
        credential: {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: expiry,
          ...(refreshExpiry === undefined ? {} : { refreshTokenExpiresAt: refreshExpiry }),
          ...(grantedScopes === undefined ? {} : { scopes: grantedScopes }),
        },
        accessTokenExpiresAt: expiry,
      };
    } catch (error) {
      throw mapTokenError(error, "authorization code exchange");
    }
  }

  parseCredential(payload: unknown, schemaVersion: number): AnthropicProviderCredential {
    if (schemaVersion !== this.credentialSchemaVersion) {
      throw new ProviderCredentialError(
        `Unsupported Anthropic credential schema version: ${schemaVersion}`
      );
    }
    const result = credentialSchema.safeParse(payload);
    if (!result.success) throw new ProviderCredentialError("Invalid Anthropic provider credential");
    return result.data;
  }

  async refresh(
    credential: AnthropicProviderCredential,
    now = Date.now()
  ): Promise<ProviderRefreshResult<AnthropicProviderCredential>> {
    try {
      const tokens = await this.refreshToken(credential.refreshToken);
      const expiry = accessTokenExpiresAt(tokens, now);
      const refreshExpiry = refreshTokenExpiresAt(tokens, now, credential.refreshTokenExpiresAt);
      const grantedScopes = scopes(tokens.scope, credential.scopes);
      return {
        credential: {
          refreshToken: tokens.refresh_token ?? credential.refreshToken,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: expiry,
          ...(refreshExpiry === undefined ? {} : { refreshTokenExpiresAt: refreshExpiry }),
          ...(grantedScopes === undefined ? {} : { scopes: grantedScopes }),
        },
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiry,
      };
    } catch (error) {
      throw mapTokenError(error, "refresh");
    }
  }

  cachedAccess(credential: AnthropicProviderCredential) {
    return {
      accessToken: credential.accessToken,
      accessTokenExpiresAt: credential.accessTokenExpiresAt,
    };
  }

  validateReconnectInputIdentity(
    _input: AnthropicProviderConnectInput,
    expectedExternalAccountId: string | null
  ): void {
    if (expectedExternalAccountId !== null) {
      throw new ProviderIdentityError("Anthropic accounts cannot have a trusted external identity");
    }
  }

  runtimeMetadata(_credential: AnthropicProviderCredential, _externalAccountId: string | null) {
    return {};
  }

  validateExternalIdentity(actual: string | undefined, expected: string | null): void {
    if (actual !== undefined || expected !== null) {
      throw new ProviderIdentityError("Anthropic accounts cannot have a trusted external identity");
    }
  }
}
