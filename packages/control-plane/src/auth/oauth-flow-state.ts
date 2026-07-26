import type { SignInProvider } from "./sign-in-provider";

interface OAuthFlowStateBinding {
  readonly state: string;
  readonly clientId: "web";
  readonly redirectUri: string;
  readonly clientCodeChallenge: string;
  readonly providerPkceVerifier: string;
}

export type CreateOAuthFlowStateInput =
  | (OAuthFlowStateBinding & {
      readonly provider: "github";
      readonly oidcNonce?: never;
    })
  | (OAuthFlowStateBinding & {
      readonly provider: "google";
      readonly oidcNonce: string;
    });

export interface OAuthFlowStateWriter {
  create(input: CreateOAuthFlowStateInput): Promise<{ flowId: string }>;
}

export interface ConsumedOAuthFlowStateBinding {
  readonly flowId: string;
  readonly clientId: "web";
  readonly redirectUri: string;
  readonly clientCodeChallenge: string;
  readonly providerPkceVerifier: string;
}

export type ConsumedOAuthFlowState =
  | (ConsumedOAuthFlowStateBinding & {
      readonly provider: "github";
      readonly oidcNonceHash: null;
    })
  | (ConsumedOAuthFlowStateBinding & {
      readonly provider: "google";
      readonly oidcNonceHash: string;
    });

export interface OAuthFlowStateReader {
  consume(state: string, expectedProvider: SignInProvider): Promise<ConsumedOAuthFlowState>;
}
