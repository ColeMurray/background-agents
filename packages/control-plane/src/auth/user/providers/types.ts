import type { SignInProvider } from "../sign-in-provider";

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

export type OAuthProviderFailure =
  | "invalid_configuration"
  | "invalid_request"
  | "provider_rejected"
  | "provider_unavailable"
  | "malformed_response";

export class OAuthProviderError extends Error {
  constructor(
    readonly failure: OAuthProviderFailure,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
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
