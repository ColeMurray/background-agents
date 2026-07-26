import { base64UrlEncode } from "./encoding";
import type { OAuthFlowStateWriter } from "./oauth-flow-state";
import { createPkceS256Challenge, isPkceS256Challenge, isPkceVerifier } from "./pkce";
import type { OAuthSignInProviderRegistry } from "./providers/types";
import { isSignInProvider, type SignInProvider } from "./sign-in-provider";

const OPAQUE_STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export class StaticOAuthClientRegistry {
  private readonly redirectUris: ReadonlySet<string>;

  constructor(redirectUris: readonly string[]) {
    if (redirectUris.length === 0 || redirectUris.some((uri) => uri.length === 0)) {
      throw new Error("Web OAuth client requires at least one redirect URI");
    }
    this.redirectUris = new Set(redirectUris);
  }

  accepts(clientId: string, redirectUri: string): boolean {
    return clientId === "web" && this.redirectUris.has(redirectUri);
  }
}

export type OAuthAuthorizationRequestErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "unsupported_response_type";

export class OAuthAuthorizationRequestError extends Error {
  constructor(readonly code: OAuthAuthorizationRequestErrorCode) {
    super("OAuth authorization request is invalid");
    this.name = "OAuthAuthorizationRequestError";
  }
}

export interface OAuthAuthorizationRequest {
  readonly responseType: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly provider: string;
}

export interface OpaqueValueGenerator {
  generate(): string;
}

export class WebCryptoOpaqueValueGenerator implements OpaqueValueGenerator {
  generate(): string {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  }
}

export interface OAuthAuthorizationServiceDependencies {
  readonly clients: StaticOAuthClientRegistry;
  readonly providers: OAuthSignInProviderRegistry;
  readonly flowStateStore: OAuthFlowStateWriter;
  readonly opaqueValueGenerator: OpaqueValueGenerator;
}

export class OAuthAuthorizationService {
  constructor(private readonly dependencies: OAuthAuthorizationServiceDependencies) {}

  async authorize(request: OAuthAuthorizationRequest): Promise<URL> {
    const provider = this.validateRequest(request);
    const providerPkceVerifier = this.dependencies.opaqueValueGenerator.generate();
    if (!isPkceVerifier(providerPkceVerifier)) {
      throw new Error("OAuth opaque-value generator returned an invalid PKCE verifier");
    }
    const providerCodeChallenge = await createPkceS256Challenge(providerPkceVerifier);

    if (provider === "google") {
      const oidcNonce = this.dependencies.opaqueValueGenerator.generate();
      if (!OPAQUE_STATE_PATTERN.test(oidcNonce)) {
        throw new Error("OAuth opaque-value generator returned an invalid OIDC nonce");
      }
      const redirect = await this.dependencies.providers.google.createAuthorizationUrl({
        state: request.state,
        codeChallenge: providerCodeChallenge,
        oidcNonce,
      });
      await this.dependencies.flowStateStore.create({
        state: request.state,
        provider,
        clientId: "web",
        redirectUri: request.redirectUri,
        clientCodeChallenge: request.codeChallenge,
        providerPkceVerifier,
        oidcNonce,
      });
      return redirect;
    }

    const redirect = await this.dependencies.providers.github.createAuthorizationUrl({
      state: request.state,
      codeChallenge: providerCodeChallenge,
    });
    await this.dependencies.flowStateStore.create({
      state: request.state,
      provider,
      clientId: "web",
      redirectUri: request.redirectUri,
      clientCodeChallenge: request.codeChallenge,
      providerPkceVerifier,
    });
    return redirect;
  }

  private validateRequest(request: OAuthAuthorizationRequest): SignInProvider {
    if (request.responseType !== "code") {
      throw new OAuthAuthorizationRequestError("unsupported_response_type");
    }
    if (!this.dependencies.clients.accepts(request.clientId, request.redirectUri)) {
      throw new OAuthAuthorizationRequestError(
        request.clientId === "web" ? "invalid_request" : "invalid_client"
      );
    }
    if (
      !OPAQUE_STATE_PATTERN.test(request.state) ||
      !isPkceS256Challenge(request.codeChallenge) ||
      request.codeChallengeMethod !== "S256" ||
      !isSignInProvider(request.provider)
    ) {
      throw new OAuthAuthorizationRequestError("invalid_request");
    }
    return request.provider;
  }
}
