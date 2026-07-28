import { verifyGoogleIdToken } from "better-auth/social-providers";
import { z } from "zod";
import type { AdmissionPolicy, GoogleAdmissionEvidence } from "../admission-policy";
import type { ProviderProfile, ProviderTokens } from "../provider-profile";
import { OAuthProviderError } from "./types";

const GOOGLE_ISSUER = "https://accounts.google.com";

const googleClaimsSchema = z.object({
  iss: z.union([z.literal(GOOGLE_ISSUER), z.literal("accounts.google.com")]),
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  name: z.string().min(1).optional(),
  picture: z.url().optional(),
});

type VerifyGoogleIdToken = typeof verifyGoogleIdToken;

export interface GoogleSignInProfileResolverConfig {
  readonly clientId: string;
  readonly admissionPolicy: Pick<AdmissionPolicy, "requireAdmission">;
}

export interface GoogleSignInProfileResolverDependencies {
  readonly verifyIdToken?: VerifyGoogleIdToken;
}

export class GoogleSignInProfileResolver {
  private readonly verifyIdToken: VerifyGoogleIdToken;

  constructor(
    private readonly config: GoogleSignInProfileResolverConfig,
    dependencies: GoogleSignInProfileResolverDependencies = {}
  ) {
    this.verifyIdToken = dependencies.verifyIdToken ?? verifyGoogleIdToken;
  }

  readonly getUserInfo = async (tokens: ProviderTokens): Promise<ProviderProfile> => {
    if (!tokens.idToken) {
      throw new OAuthProviderError("malformed_response", "Google did not return an ID token");
    }

    const rawClaims = await this.verifyIdToken({
      token: tokens.idToken,
      audience: this.config.clientId,
    });
    const parsedClaims = googleClaimsSchema.safeParse(rawClaims);
    if (!parsedClaims.success) {
      throw new OAuthProviderError("malformed_response", "Google returned an invalid ID token");
    }

    const email = parsedClaims.data.email.toLowerCase();
    const signIn: GoogleAdmissionEvidence = {
      identity: {
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: parsedClaims.data.sub,
        ...(parsedClaims.data.name ? { displayName: parsedClaims.data.name } : {}),
        ...(parsedClaims.data.picture ? { avatarUrl: parsedClaims.data.picture } : {}),
        verifiedEmails: [email],
        primaryEmail: email,
      },
    };
    await this.config.admissionPolicy.requireAdmission(signIn);

    return {
      user: {
        id: signIn.identity.subject,
        name: signIn.identity.displayName ?? email,
        email,
        ...(signIn.identity.avatarUrl ? { image: signIn.identity.avatarUrl } : {}),
        emailVerified: true,
      },
      data: parsedClaims.data,
    };
  };
}
