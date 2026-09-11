import { z } from "zod";
import {
  connectAnthropicModelProviderAccountRequestSchema,
  reconnectAnthropicModelProviderAccountRequestSchema,
  type ConnectModelProviderAccountRequest,
  type ReconnectModelProviderAccountRequest,
} from "@open-inspect/shared/types/provider-accounts";
import {
  ANTHROPIC_SETUP_TOKEN_LIFETIME_MS,
  ANTHROPIC_SETUP_TOKEN_SCOPE,
  exchangeAnthropicAuthorizationCode,
  parsePastedAuthorizationCode,
  startAnthropicAuthorization,
} from "./anthropic";
import {
  ProviderCredentialError,
  ProviderIdentityError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderAuthorizationCodeCapability,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "./model-provider-account-adapters";

/**
 * Credential schema v1: the setup token itself. It is inference-only, does
 * not rotate, and carries no refresh token. `expiresAt` is what the exchange
 * reported (or the documented one-year default for a pasted token).
 */
const credentialSchema = z.object({
  kind: z.literal("setup_token"),
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
  scopes: z.array(z.string()).min(1),
});
const connectInputSchema = z.union([
  connectAnthropicModelProviderAccountRequestSchema,
  reconnectAnthropicModelProviderAccountRequestSchema,
]);
const authorizationStateSchema = z.object({
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
});

export type AnthropicProviderCredential = z.infer<typeof credentialSchema>;
export type AnthropicProviderConnectInput =
  | Extract<ConnectModelProviderAccountRequest, { provider: "anthropic" }>
  | Extract<ReconnectModelProviderAccountRequest, { provider: "anthropic" }>;
export type AnthropicAuthorizationState = z.infer<typeof authorizationStateSchema>;

/** The runtime treats a token as unusable this long before its recorded expiry. */
const EXPIRY_GUARD_MS = 60 * 60 * 1000;

export class AnthropicProviderAuthorizationCode implements ProviderAuthorizationCodeCapability<
  AnthropicProviderCredential,
  AnthropicAuthorizationState
> {
  readonly stateSchemaVersion = 1;

  constructor(
    private readonly startAuthorization = startAnthropicAuthorization,
    private readonly exchange = exchangeAnthropicAuthorizationCode
  ) {}

  async start() {
    const request = await this.startAuthorization();
    return {
      providerState: { codeVerifier: request.codeVerifier, state: request.state },
      authorizationUrl: request.authorizationUrl,
    };
  }

  parseState(payload: unknown, schemaVersion: number): AnthropicAuthorizationState {
    if (schemaVersion !== this.stateSchemaVersion) {
      throw new ProviderCredentialError(
        `Unsupported Anthropic authorization state version: ${schemaVersion}`
      );
    }
    const result = authorizationStateSchema.safeParse(payload);
    if (!result.success) throw new ProviderCredentialError("Invalid Anthropic authorization state");
    return result.data;
  }

  async complete(
    providerState: AnthropicAuthorizationState,
    pastedCode: string
  ): Promise<ProviderConnectionResult<AnthropicProviderCredential>> {
    const { code, state } = parsePastedAuthorizationCode(pastedCode);
    const exchanged = await this.exchange({
      code,
      pastedState: state,
      expectedState: providerState.state,
      codeVerifier: providerState.codeVerifier,
    });
    return {
      credential: {
        kind: "setup_token",
        token: exchanged.accessToken,
        expiresAt: exchanged.expiresAt,
        scopes: exchanged.scope.split(/\s+/).filter(Boolean),
      },
      accessTokenExpiresAt: exchanged.expiresAt,
    };
  }
}

export class AnthropicModelProviderAccountAdapter implements ModelProviderAccountAdapter<
  AnthropicProviderCredential,
  AnthropicProviderConnectInput
> {
  readonly provider = "anthropic" as const;
  readonly credentialSchemaVersion = 1;
  /** The credential is static; the broker never needs to refresh ahead of expiry. */
  readonly refreshBufferMs = EXPIRY_GUARD_MS;
  /** Manual "Verify" would only prove the token is a token; nothing to call. */
  readonly supportsVerification = false;
  /** Runtime credentials are the token itself, delivered at sandbox boot. */
  readonly runtimeCredentialKind = "stored_provider_secret" as const;

  constructor(
    readonly authorizationCode: ProviderAuthorizationCodeCapability<
      AnthropicProviderCredential,
      unknown
    > = new AnthropicProviderAuthorizationCode(),
    private readonly now: () => number = Date.now
  ) {}

  parseConnectInput(input: unknown): AnthropicProviderConnectInput {
    return connectInputSchema.parse(input);
  }

  /** A pasted `claude setup-token` output; trusted as-is with the documented lifetime. */
  async connect(
    input: AnthropicProviderConnectInput
  ): Promise<ProviderConnectionResult<AnthropicProviderCredential>> {
    const token = input.setupToken.trim();
    if (!token.startsWith("sk-ant-oat")) {
      throw new ProviderCredentialError(
        "That does not look like a Claude setup token (expected an sk-ant-oat… value from `claude setup-token`)"
      );
    }
    const expiresAt = this.now() + ANTHROPIC_SETUP_TOKEN_LIFETIME_MS;
    return {
      credential: {
        kind: "setup_token",
        token,
        expiresAt,
        scopes: [ANTHROPIC_SETUP_TOKEN_SCOPE],
      },
      accessTokenExpiresAt: expiresAt,
    };
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

  /**
   * There is no refresh. Reaching this means the cached access expired, and
   * the only outcome is "reconnect required": the broker fences the account.
   */
  async refresh(
    credential: AnthropicProviderCredential,
    now = this.now()
  ): Promise<ProviderRefreshResult<AnthropicProviderCredential>> {
    if (credential.expiresAt - now > EXPIRY_GUARD_MS) {
      return {
        credential,
        accessToken: credential.token,
        accessTokenExpiresAt: credential.expiresAt,
      };
    }
    throw new ProviderRefreshError(
      "Claude setup token has expired; reconnect the account",
      "unauthorized"
    );
  }

  cachedAccess(credential: AnthropicProviderCredential) {
    return { accessToken: credential.token, accessTokenExpiresAt: credential.expiresAt };
  }

  validateReconnectInputIdentity(
    _input: AnthropicProviderConnectInput,
    _expectedExternalAccountId: string | null
  ): void {
    // Identity-less slots: the inference scope carries no account id, so a
    // reconnect can never be checked against a previous identity.
  }

  runtimeMetadata(_credential: AnthropicProviderCredential, _externalAccountId: string | null) {
    return {};
  }

  validateExternalIdentity(actual: string | undefined, expected: string | null): void {
    if (actual && expected && actual !== expected) {
      throw new ProviderIdentityError("Anthropic account identity did not match");
    }
  }
}
