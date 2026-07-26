import { z } from "zod";
import {
  OidcAuthorizationCodeClient,
  type OidcAuthorizationCodeClientDependencies,
} from "./oidc-authorization-code-client";
import {
  assertCanonicalIssuer,
  OAuthProviderError,
  type OAuthSignInProvider,
  type ProviderAuthorizationRequest,
  type ProviderCodeExchangeRequest,
  type ProviderCodeExchangeResult,
} from "./types";

const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_SCOPES = ["openid", "email", "profile"] as const;

const googleIdentityClaimsSchema = z
  .object({
    iss: z.literal(GOOGLE_ISSUER),
    sub: z.string().min(1),
    email: z.email().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().min(1).optional(),
    picture: z.url().optional(),
  })
  .superRefine((claims, ctx) => {
    if (claims.email_verified === true && claims.email === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["email"],
        message: "verified email claim requires an email",
      });
    }
  });

export interface GoogleOidcProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly callbackUri: string;
  readonly issuer: string;
}

export type GoogleOidcProviderDependencies = OidcAuthorizationCodeClientDependencies;

export class GoogleOidcProvider implements OAuthSignInProvider<"google"> {
  readonly provider = "google" as const;
  private readonly oidc: OidcAuthorizationCodeClient;

  constructor(config: GoogleOidcProviderConfig, dependencies: GoogleOidcProviderDependencies = {}) {
    assertCanonicalIssuer(config.issuer, GOOGLE_ISSUER);
    this.oidc = new OidcAuthorizationCodeClient(
      {
        issuer: GOOGLE_ISSUER,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        callbackUri: config.callbackUri,
        scopes: GOOGLE_SCOPES,
      },
      dependencies
    );
  }

  async createAuthorizationUrl(request: ProviderAuthorizationRequest<"google">): Promise<URL> {
    return this.oidc.createAuthorizationUrl({
      state: request.state,
      codeChallenge: request.codeChallenge,
      nonce: request.oidcNonce,
    });
  }

  async exchangeAuthorizationCode(
    request: ProviderCodeExchangeRequest<"google">
  ): Promise<ProviderCodeExchangeResult<"google">> {
    const rawClaims = await this.oidc.exchangeAuthorizationCode({
      code: request.code,
      codeVerifier: request.codeVerifier,
      nonceHash: request.oidcNonceHash,
    });
    const claims = googleIdentityClaimsSchema.safeParse(rawClaims);
    if (!claims.success) {
      throw new OAuthProviderError("malformed_response", "Google returned invalid identity claims");
    }

    const verifiedEmail = claims.data.email_verified === true ? (claims.data.email ?? null) : null;
    return {
      identity: {
        provider: this.provider,
        issuer: claims.data.iss,
        subject: claims.data.sub,
        ...(claims.data.name ? { displayName: claims.data.name } : {}),
        ...(claims.data.picture ? { avatarUrl: claims.data.picture } : {}),
        verifiedEmails: verifiedEmail ? [verifiedEmail] : [],
        primaryEmail: verifiedEmail,
      },
      credential: null,
    };
  }
}
