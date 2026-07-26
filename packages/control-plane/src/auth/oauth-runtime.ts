import type { SignInProvider } from "./sign-in-provider";

export type OAuthProtocolRequestErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "unsupported_response_type";

export class OAuthProtocolRequestError extends Error {
  constructor(readonly code: OAuthProtocolRequestErrorCode) {
    super("OAuth protocol request is invalid");
    this.name = "OAuthProtocolRequestError";
  }
}

export type OAuthProtocolGrantRejection =
  | "malformed"
  | "unknown"
  | "binding_mismatch"
  | "pkce_failed"
  | "expired"
  | "already_consumed"
  | "race_lost"
  | "corrupt";

export class OAuthProtocolGrantError extends Error {
  constructor(readonly rejection: OAuthProtocolGrantRejection) {
    super("OAuth authorization grant is invalid");
    this.name = "OAuthProtocolGrantError";
  }
}

export class OAuthProtocolUnavailableError extends Error {
  constructor(readonly setting?: string) {
    super("OAuth protocol runtime is unavailable");
    this.name = "OAuthProtocolUnavailableError";
  }
}

export type OAuthProtocolCallbackFailure =
  | "access_denied"
  | "account_link_required"
  | "temporarily_unavailable"
  | "server_error";

export class OAuthProtocolCallbackRedirectError extends Error {
  constructor(
    readonly failure: OAuthProtocolCallbackFailure,
    readonly redirectUri: string
  ) {
    super("OAuth provider callback could not be completed");
    this.name = "OAuthProtocolCallbackRedirectError";
  }
}

export interface OAuthProtocolAuthorizationInput {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly provider: string;
}

export interface OAuthProtocolCallbackInput {
  readonly state: string;
  readonly code: string;
}

export interface OAuthProtocolRedemptionInput {
  readonly code: string;
  readonly clientId: "web";
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

/**
 * OAuth use cases exposed to the HTTP adapter. Protocol parsing and response
 * formatting stay outside this interface, as do service and storage errors.
 */
export interface OAuthProtocolRuntime {
  authorize(request: OAuthProtocolAuthorizationInput): Promise<URL>;
  completeAuthorization(provider: SignInProvider, input: OAuthProtocolCallbackInput): Promise<URL>;
  completeDenial(provider: SignInProvider, state: string): Promise<URL>;
  redeemAuthorizationCode(input: OAuthProtocolRedemptionInput): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly idleExpiresIn: number;
  }>;
  revokeBrowserSession(token: string): Promise<boolean>;
}
