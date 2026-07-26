import { timingSafeEqual } from "@open-inspect/shared";
import * as oauth from "oauth4webapi";
import { hashToken } from "../crypto";
import { DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS } from "./constants";
import { OAuthProviderError } from "./types";

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface OidcAuthorizationCodeClientConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUri: string;
  readonly scopes: readonly string[];
}

export interface OidcAuthorizationCodeClientDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly tokenHasher?: { hash(value: string): Promise<string> };
}

export interface OidcAuthorizationRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly nonce: string;
}

export interface OidcCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly nonceHash: string;
}

/**
 * Maintained OIDC protocol boundary shared by executable OIDC provider
 * adapters. Provider-specific code owns issuer allowlisting and claim policy;
 * this client owns discovery, PKCE exchange, ID-token validation, JWKS
 * signature verification, and hash-only nonce binding.
 */
export class OidcAuthorizationCodeClient {
  private readonly issuer: URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly tokenHasher: { hash(value: string): Promise<string> };
  private readonly client: oauth.Client;
  private readonly jwksCache: oauth.JWKSCacheInput = {};
  private discovery: Promise<oauth.AuthorizationServer> | null = null;

  constructor(
    private readonly config: OidcAuthorizationCodeClientConfig,
    dependencies: OidcAuthorizationCodeClientDependencies = {}
  ) {
    this.issuer = new URL(config.issuer);
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    this.tokenHasher = dependencies.tokenHasher ?? { hash: hashToken };
    this.client = { client_id: config.clientId };
  }

  async createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<URL> {
    const authorizationServer = await this.getAuthorizationServer();
    if (!authorizationServer.authorization_endpoint) {
      throw new OAuthProviderError(
        "invalid_configuration",
        "OIDC discovery omitted the authorization endpoint"
      );
    }
    if (!authorizationServer.code_challenge_methods_supported?.includes("S256")) {
      throw new OAuthProviderError(
        "invalid_configuration",
        "OIDC discovery does not advertise PKCE S256"
      );
    }

    const url = new URL(authorizationServer.authorization_endpoint);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.callbackUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", request.nonce);
    return url;
  }

  async exchangeAuthorizationCode(request: OidcCodeExchangeRequest): Promise<oauth.IDToken> {
    if (!SHA_256_HEX_PATTERN.test(request.nonceHash)) {
      throw new OAuthProviderError(
        "invalid_request",
        "OIDC authorization-code exchange requires a nonce hash"
      );
    }

    try {
      const authorizationServer = await this.getAuthorizationServer();
      const callbackParameters = oauth.validateAuthResponse(
        authorizationServer,
        this.client,
        new URLSearchParams({ code: request.code }),
        oauth.expectNoState
      );
      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        authorizationServer,
        this.client,
        oauth.ClientSecretPost(this.config.clientSecret),
        callbackParameters,
        this.config.callbackUri,
        request.codeVerifier,
        { [oauth.customFetch]: this.fetchWithTimeout }
      );

      // The raw nonce is deliberately not persisted. oauth4webapi validates
      // issuer, audience, expiry, algorithm, and ID-token claim structure; the
      // application then verifies the signed nonce claim against the stored
      // SHA-256 value.
      const tokenResult = await oauth.processGenericTokenEndpointResponse(
        authorizationServer,
        this.client,
        tokenResponse
      );
      await oauth.validateApplicationLevelSignature(authorizationServer, tokenResponse, {
        [oauth.customFetch]: this.fetchWithTimeout,
        [oauth.jwksCache]: this.jwksCache,
      });
      const claims = oauth.getValidatedIdTokenClaims(tokenResult);
      if (!claims || typeof claims.nonce !== "string" || claims.nonce.length === 0) {
        throw new OAuthProviderError("malformed_response", "OIDC identity claims are invalid");
      }
      if (claims.azp !== undefined && claims.azp !== this.config.clientId) {
        throw new OAuthProviderError(
          "malformed_response",
          "OIDC returned an unexpected authorized party"
        );
      }
      const actualNonceHash = await this.tokenHasher.hash(claims.nonce);
      if (!timingSafeEqual(actualNonceHash, request.nonceHash)) {
        throw new OAuthProviderError("provider_rejected", "OIDC nonce validation failed");
      }
      return claims;
    } catch (error) {
      if (error instanceof OAuthProviderError) throw error;
      if (
        error instanceof oauth.ResponseBodyError ||
        error instanceof oauth.AuthorizationResponseError
      ) {
        throw new OAuthProviderError("provider_rejected", "OIDC provider rejected the code");
      }
      throw new OAuthProviderError("malformed_response", "OIDC validation failed");
    }
  }

  private getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
    if (!this.discovery) {
      this.discovery = this.discover().catch((error) => {
        this.discovery = null;
        if (error instanceof OAuthProviderError) throw error;
        throw new OAuthProviderError("provider_unavailable", "OIDC discovery failed");
      });
    }
    return this.discovery;
  }

  private async discover(): Promise<oauth.AuthorizationServer> {
    const response = await oauth.discoveryRequest(this.issuer, {
      algorithm: "oidc",
      [oauth.customFetch]: this.fetchWithTimeout,
    });
    return oauth.processDiscoveryResponse(this.issuer, response);
  }

  private readonly fetchWithTimeout = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof OAuthProviderError) throw error;
      throw new OAuthProviderError("provider_unavailable", "OIDC request failed");
    } finally {
      clearTimeout(timeout);
    }
  };
}
