export interface BrowserAuthProviderTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly idToken?: string;
  readonly scopes?: readonly string[];
}

export interface BrowserAuthProviderProfile {
  readonly user: {
    readonly id: string;
    readonly name?: string;
    readonly email?: string | null;
    readonly image?: string;
    readonly emailVerified: boolean;
  };
  readonly data: unknown;
}

export type BrowserAuthProviderProfileResolver = (
  tokens: BrowserAuthProviderTokens
) => Promise<BrowserAuthProviderProfile | null>;
