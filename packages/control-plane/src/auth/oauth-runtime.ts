import type { OAuthAuthorizationRequest } from "./oauth-authorization-service";
import type { CompleteProviderAuthorizationInput } from "./oauth-provider-callback-service";
import type { SignInProvider } from "./sign-in-provider";
import type { RedeemOAuthAuthorizationCodeInput } from "../db/oauth-authorization-codes";

/**
 * OAuth use cases exposed to the HTTP adapter. Protocol parsing and response
 * formatting stay outside this interface.
 */
export interface OAuthProtocolRuntime {
  authorize(request: OAuthAuthorizationRequest): Promise<URL>;
  completeAuthorization(
    provider: SignInProvider,
    input: CompleteProviderAuthorizationInput
  ): Promise<URL>;
  completeDenial(provider: SignInProvider, state: string): Promise<URL>;
  redeemAuthorizationCode(input: RedeemOAuthAuthorizationCodeInput): Promise<{
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly idleExpiresIn: number;
  }>;
  revokeBrowserSession(token: string): Promise<boolean>;
}
