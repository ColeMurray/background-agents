import {
  AdmissionDeniedError,
  AdmissionUnavailableError,
  type VerifiedProviderSignIn,
} from "./admission-policy";
import type {
  ProviderIdentityEvidence,
  ResolvedImmutableProviderIdentity,
} from "./immutable-provider-identity";
import { AccountLinkRequiredError } from "./immutable-provider-identity";
import type { ConsumedOAuthFlowState, OAuthFlowStateReader } from "./oauth-flow-state";
import { OAuthProviderError, type OAuthSignInProviderRegistry } from "./providers/types";
import type { SignInProvider } from "./sign-in-provider";

const MAX_PROVIDER_AUTHORIZATION_CODE_LENGTH = 4_096;

export interface CompleteProviderAuthorizationInput {
  readonly state: string;
  readonly code: string;
}

export interface AdmissionPolicyPort {
  requireAdmission(signIn: VerifiedProviderSignIn): Promise<unknown>;
}

export interface ImmutableProviderIdentityPort {
  resolve(evidence: ProviderIdentityEvidence): Promise<ResolvedImmutableProviderIdentity>;
}

export interface OAuthAuthorizationCodeIssuer {
  issue(input: {
    readonly userId: string;
    readonly providerIdentityId: string;
    readonly clientId: "web";
    readonly redirectUri: string;
    readonly codeChallenge: string;
  }): Promise<{ readonly code: string; readonly expiresAt: number }>;
}

export interface OAuthClientRegistryPort {
  accepts(clientId: string, redirectUri: string): boolean;
}

export interface OAuthProviderCallbackServiceDependencies {
  readonly clients: OAuthClientRegistryPort;
  readonly providers: OAuthSignInProviderRegistry;
  readonly flowStateStore: OAuthFlowStateReader;
  readonly admissionPolicy: AdmissionPolicyPort;
  readonly identityService: ImmutableProviderIdentityPort;
  readonly authorizationCodeStore: OAuthAuthorizationCodeIssuer;
}

export class OAuthProviderCallbackBindingError extends Error {
  constructor() {
    super("Consumed OAuth flow has an invalid client binding");
    this.name = "OAuthProviderCallbackBindingError";
  }
}

export class OAuthProviderCallbackRequestError extends Error {
  constructor() {
    super("OAuth provider callback request is invalid");
    this.name = "OAuthProviderCallbackRequestError";
  }
}

export type OAuthProviderCallbackFailure =
  | "access_denied"
  | "account_link_required"
  | "temporarily_unavailable"
  | "server_error";

export class OAuthProviderCallbackError extends Error {
  constructor(
    readonly failure: OAuthProviderCallbackFailure,
    readonly redirectUri: string,
    readonly state: string,
    cause: unknown
  ) {
    super("OAuth provider callback could not be completed", { cause });
    this.name = "OAuthProviderCallbackError";
  }
}

function callbackFailure(error: unknown): OAuthProviderCallbackFailure {
  if (error instanceof AccountLinkRequiredError) {
    return "account_link_required";
  }
  if (error instanceof AdmissionDeniedError) {
    return "access_denied";
  }
  if (
    error instanceof AdmissionUnavailableError ||
    (error instanceof OAuthProviderError && error.failure === "provider_unavailable")
  ) {
    return "temporarily_unavailable";
  }
  return "server_error";
}

export class OAuthProviderCallbackService {
  constructor(private readonly dependencies: OAuthProviderCallbackServiceDependencies) {}

  async completeAuthorization(
    provider: SignInProvider,
    input: CompleteProviderAuthorizationInput
  ): Promise<URL> {
    if (input.code.length === 0 || input.code.length > MAX_PROVIDER_AUTHORIZATION_CODE_LENGTH) {
      throw new OAuthProviderCallbackRequestError();
    }

    if (provider === "google") {
      const flow = await this.dependencies.flowStateStore.consume(input.state, "google");
      this.requireTrustedFlowBinding(flow);
      try {
        const signIn = await this.dependencies.providers.google.exchangeAuthorizationCode({
          code: input.code,
          codeVerifier: flow.providerPkceVerifier,
          oidcNonceHash: flow.oidcNonceHash,
        });
        return await this.completeVerifiedSignIn(flow, signIn, input.state);
      } catch (error) {
        throw new OAuthProviderCallbackError(
          callbackFailure(error),
          flow.redirectUri,
          input.state,
          error
        );
      }
    }

    const flow = await this.dependencies.flowStateStore.consume(input.state, "github");
    this.requireTrustedFlowBinding(flow);
    try {
      const signIn = await this.dependencies.providers.github.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: flow.providerPkceVerifier,
      });
      return await this.completeVerifiedSignIn(flow, signIn, input.state);
    } catch (error) {
      throw new OAuthProviderCallbackError(
        callbackFailure(error),
        flow.redirectUri,
        input.state,
        error
      );
    }
  }

  async completeDenial(provider: SignInProvider, state: string): Promise<URL> {
    const flow =
      provider === "google"
        ? await this.dependencies.flowStateStore.consume(state, "google")
        : await this.dependencies.flowStateStore.consume(state, "github");
    this.requireTrustedFlowBinding(flow);
    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("state", state);
    return redirect;
  }

  private requireTrustedFlowBinding(flow: ConsumedOAuthFlowState): void {
    if (!this.dependencies.clients.accepts(flow.clientId, flow.redirectUri)) {
      throw new OAuthProviderCallbackBindingError();
    }
  }

  private async completeVerifiedSignIn(
    flow: ConsumedOAuthFlowState,
    signIn: VerifiedProviderSignIn,
    state: string
  ): Promise<URL> {
    await this.dependencies.admissionPolicy.requireAdmission(signIn);
    const evidence: ProviderIdentityEvidence =
      signIn.credential === null
        ? { identity: signIn.identity }
        : {
            identity: signIn.identity,
            providerCredential: signIn.credential,
          };
    const resolved = await this.dependencies.identityService.resolve(evidence);
    const authorizationCode = await this.dependencies.authorizationCodeStore.issue({
      userId: resolved.userId,
      providerIdentityId: resolved.providerIdentityId,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.clientCodeChallenge,
    });

    const redirect = new URL(flow.redirectUri);
    redirect.searchParams.set("code", authorizationCode.code);
    redirect.searchParams.set("state", state);
    return redirect;
  }
}
