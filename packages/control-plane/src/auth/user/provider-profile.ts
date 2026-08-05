export interface ProviderTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly idToken?: string;
  readonly scopes?: readonly string[];
}

export interface ProviderProfile {
  readonly user: {
    readonly id: string;
    readonly name?: string;
    readonly email?: string | null;
    readonly image?: string;
    readonly emailVerified: boolean;
  };
  readonly data: unknown;
}

export type ProviderProfileResolver = (tokens: ProviderTokens) => Promise<ProviderProfile | null>;
