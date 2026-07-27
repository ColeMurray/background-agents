import type { AdmissionPolicy } from "../admission-policy";
import type { ProviderProfile, ProviderTokens } from "../provider-profile";
import type { ProviderCredentialInput } from "../provider-credential";
import {
  OAuthProviderError,
  type ProviderSignInResult,
  type VerifiedProviderIdentity,
} from "./types";

export interface GitHubIdentityResolver {
  resolveIdentity(accessToken: string): Promise<VerifiedProviderIdentity<"github">>;
}

export interface GitHubSignInProfileResolverConfig {
  readonly identityResolver: GitHubIdentityResolver;
  readonly admissionPolicy: Pick<AdmissionPolicy, "requireAdmission">;
}

export class GitHubSignInProfileResolver {
  constructor(private readonly config: GitHubSignInProfileResolverConfig) {}

  readonly getUserInfo = async (tokens: ProviderTokens): Promise<ProviderProfile> => {
    if (!tokens.accessToken) {
      throw new OAuthProviderError("malformed_response", "GitHub did not return an access token");
    }

    const identity = await this.config.identityResolver.resolveIdentity(tokens.accessToken);
    const email = identity.primaryEmail ?? identity.verifiedEmails[0];
    if (!email) {
      throw new OAuthProviderError("malformed_response", "GitHub did not return a verified email");
    }

    const signIn: ProviderSignInResult<"github"> = {
      identity,
      credential: toProviderCredential(tokens),
    };
    await this.config.admissionPolicy.requireAdmission(signIn);

    return {
      user: {
        id: identity.subject,
        name: identity.displayName ?? identity.login ?? email,
        email,
        ...(identity.avatarUrl ? { image: identity.avatarUrl } : {}),
        emailVerified: true,
      },
      data: identity,
    };
  };
}

function toProviderCredential(tokens: ProviderTokens): ProviderCredentialInput {
  const accessToken = tokens.accessToken;
  if (!accessToken) {
    throw new OAuthProviderError("malformed_response", "GitHub did not return an access token");
  }
  if (tokens.refreshToken && !tokens.accessTokenExpiresAt) {
    throw new OAuthProviderError(
      "malformed_response",
      "GitHub returned a refresh token without access expiry"
    );
  }
  if (tokens.refreshTokenExpiresAt && !tokens.refreshToken) {
    throw new OAuthProviderError(
      "malformed_response",
      "GitHub returned refresh expiry without a refresh token"
    );
  }
  if (tokens.refreshToken && tokens.accessTokenExpiresAt) {
    return {
      kind: "refreshable",
      accessToken,
      accessExpiresAt: tokens.accessTokenExpiresAt.getTime(),
      refreshToken: tokens.refreshToken,
      refreshExpiresAt: tokens.refreshTokenExpiresAt?.getTime() ?? null,
    };
  }
  if (tokens.accessTokenExpiresAt) {
    return {
      kind: "access_only_expiring",
      accessToken,
      accessExpiresAt: tokens.accessTokenExpiresAt.getTime(),
    };
  }
  return {
    kind: "access_only_nonexpiring",
    accessToken,
  };
}
