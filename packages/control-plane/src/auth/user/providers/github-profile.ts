import type { AdmissionPolicy, GitHubAdmissionEvidence } from "../admission-policy";
import type { ProviderProfile, ProviderTokens } from "../provider-profile";
import { OAuthProviderError, type VerifiedProviderIdentity } from "./types";

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

    const signIn: GitHubAdmissionEvidence = {
      identity,
      accessToken: tokens.accessToken,
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
