import type { SignInProvider } from "../sign-in-provider";
import type { ProviderCredentialInput } from "../provider-credential-cipher";

export interface ProviderAuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly oidcNonce?: string;
}

export interface ProviderCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly oidcNonceHash?: string;
}

export interface VerifiedProviderIdentity {
  readonly provider: SignInProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly verifiedEmails: readonly string[];
  readonly primaryEmail: string | null;
}

export interface ProviderCodeExchangeResult {
  readonly identity: VerifiedProviderIdentity;
  readonly credential: ProviderCredentialInput | null;
}

export type OAuthProviderFailure =
  | "invalid_configuration"
  | "invalid_request"
  | "provider_rejected"
  | "provider_unavailable"
  | "malformed_response";

export class OAuthProviderError extends Error {
  constructor(
    readonly failure: OAuthProviderFailure,
    message: string
  ) {
    super(message);
    this.name = "OAuthProviderError";
  }
}

export function assertCanonicalIssuer(configuredIssuer: string, expectedIssuer: string): void {
  let configured: URL;
  try {
    configured = new URL(configuredIssuer);
  } catch {
    throw new OAuthProviderError("invalid_configuration", "Provider issuer is invalid");
  }
  const expected = new URL(expectedIssuer);
  if (configured.href !== expected.href) {
    throw new OAuthProviderError("invalid_configuration", "Provider issuer is not canonical");
  }
}

export interface OAuthSignInProvider {
  readonly provider: SignInProvider;
  createAuthorizationUrl(request: ProviderAuthorizationRequest): Promise<URL>;
  exchangeAuthorizationCode(
    request: ProviderCodeExchangeRequest
  ): Promise<ProviderCodeExchangeResult>;
}
