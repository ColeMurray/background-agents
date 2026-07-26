import type { SignInProvider } from "../sign-in-provider";
import type { ProviderCredentialInput } from "../provider-credential";

interface ProviderAuthorizationRequestBinding {
  readonly state: string;
  readonly codeChallenge: string;
}

interface ProviderAuthorizationRequestByProvider {
  readonly github: ProviderAuthorizationRequestBinding & {
    readonly oidcNonce?: never;
  };
  readonly google: ProviderAuthorizationRequestBinding & {
    readonly oidcNonce: string;
  };
}

export type ProviderAuthorizationRequest<P extends SignInProvider> =
  ProviderAuthorizationRequestByProvider[P];

interface ProviderCodeExchangeRequestBinding {
  readonly code: string;
  readonly codeVerifier: string;
}

interface ProviderCodeExchangeRequestByProvider {
  readonly github: ProviderCodeExchangeRequestBinding & {
    readonly oidcNonceHash?: never;
  };
  readonly google: ProviderCodeExchangeRequestBinding & {
    readonly oidcNonceHash: string;
  };
}

export type ProviderCodeExchangeRequest<P extends SignInProvider> =
  ProviderCodeExchangeRequestByProvider[P];

export interface VerifiedProviderIdentity<P extends SignInProvider = SignInProvider> {
  readonly provider: P;
  readonly issuer: string;
  readonly subject: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly verifiedEmails: readonly string[];
  readonly primaryEmail: string | null;
}

interface ProviderCodeExchangeResultByProvider {
  readonly github: {
    readonly identity: VerifiedProviderIdentity<"github">;
    readonly credential: ProviderCredentialInput;
  };
  readonly google: {
    readonly identity: VerifiedProviderIdentity<"google">;
    readonly credential: null;
  };
}

export type ProviderCodeExchangeResult<P extends SignInProvider> =
  ProviderCodeExchangeResultByProvider[P];

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

export interface OAuthSignInProvider<P extends SignInProvider> {
  readonly provider: P;
  createAuthorizationUrl(request: ProviderAuthorizationRequest<P>): Promise<URL>;
  exchangeAuthorizationCode(
    request: ProviderCodeExchangeRequest<P>
  ): Promise<ProviderCodeExchangeResult<P>>;
}

export type OAuthSignInProviderRegistry = {
  readonly [P in SignInProvider]: OAuthSignInProvider<P>;
};
