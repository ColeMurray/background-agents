export interface ProviderTokens {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly accessTokenExpiresAt?: Date;
  readonly refreshTokenExpiresAt?: Date;
  readonly idToken?: string;
  readonly scopes?: readonly string[];
}

export interface ProviderProfile<Data = unknown> {
  readonly user: {
    readonly id?: never;
    readonly name?: string;
    readonly email?: string | null;
    readonly image?: string;
    readonly emailVerified: boolean;
  };
  readonly data: Data;
}

export type ProviderProfileResolver<Data = unknown> = (
  tokens: ProviderTokens
) => Promise<ProviderProfile<Data> | null>;
