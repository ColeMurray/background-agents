import type { ConsumedOAuthFlowStateFor, OAuthFlowStateReader } from "./oauth-flow-state";
import type { OAuthSignInProviderRegistry, ProviderCodeExchangeResult } from "./providers/types";
import type { SignInProvider } from "./sign-in-provider";

export interface ConsumedOAuthProviderCallback<P extends SignInProvider> {
  readonly flow: ConsumedOAuthFlowStateFor<P>;
  exchange(code: string): Promise<ProviderCodeExchangeResult<P>>;
}

export interface OAuthProviderCallbackHandler<P extends SignInProvider> {
  consume(state: string): Promise<ConsumedOAuthProviderCallback<P>>;
}

export type OAuthProviderCallbackHandlerRegistry = {
  readonly [P in SignInProvider]: OAuthProviderCallbackHandler<P>;
};

export interface OAuthProviderCallbackHandlerDependencies {
  readonly flowStateStore: OAuthFlowStateReader;
  readonly providers: OAuthSignInProviderRegistry;
}

export function createOAuthProviderCallbackHandlers(
  dependencies: OAuthProviderCallbackHandlerDependencies
): OAuthProviderCallbackHandlerRegistry {
  return {
    github: {
      async consume(state) {
        const flow = await dependencies.flowStateStore.consume(state, "github");
        return {
          flow,
          exchange: (code) =>
            dependencies.providers.github.exchangeAuthorizationCode({
              code,
              codeVerifier: flow.providerPkceVerifier,
            }),
        };
      },
    },
    google: {
      async consume(state) {
        const flow = await dependencies.flowStateStore.consume(state, "google");
        return {
          flow,
          exchange: (code) =>
            dependencies.providers.google.exchangeAuthorizationCode({
              code,
              codeVerifier: flow.providerPkceVerifier,
              oidcNonceHash: flow.oidcNonceHash,
            }),
        };
      },
    },
  };
}
