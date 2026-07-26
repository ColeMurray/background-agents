export type ProviderCredentialKind =
  | "refreshable"
  | "access_only_expiring"
  | "access_only_nonexpiring";

/** Plain provider credential produced by an authenticated provider adapter. */
export type ProviderCredentialInput =
  | {
      kind: "refreshable";
      accessToken: string;
      accessExpiresAt: number;
      refreshToken: string;
      refreshExpiresAt: number | null;
    }
  | {
      kind: "access_only_expiring";
      accessToken: string;
      accessExpiresAt: number;
    }
  | {
      kind: "access_only_nonexpiring";
      accessToken: string;
    };
