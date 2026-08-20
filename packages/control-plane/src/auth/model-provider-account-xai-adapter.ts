import { z } from "zod";
import { refreshXaiToken, XaiTokenRefreshError } from "./xai";
import {
  DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS,
  DEFAULT_PROVIDER_REFRESH_BUFFER_MS,
  ProviderCredentialError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "./model-provider-account-adapters";

const credentialSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.number().int().positive().optional(),
});
const connectInputSchema = z.object({ refreshToken: z.string().min(1) });

export type XaiProviderCredential = z.infer<typeof credentialSchema>;
export type XaiProviderConnectInput = z.infer<typeof connectInputSchema>;

type RefreshXai = typeof refreshXaiToken;

export class XaiModelProviderAccountAdapter implements ModelProviderAccountAdapter<
  XaiProviderCredential,
  XaiProviderConnectInput
> {
  readonly provider = "xai" as const;
  readonly credentialSchemaVersion = 1;
  readonly refreshBufferMs = DEFAULT_PROVIDER_REFRESH_BUFFER_MS;

  constructor(private readonly refreshToken: RefreshXai = refreshXaiToken) {}

  parseConnectInput(input: unknown): XaiProviderConnectInput {
    return connectInputSchema.parse(input);
  }

  async connect(
    input: XaiProviderConnectInput
  ): Promise<ProviderConnectionResult<XaiProviderCredential>> {
    const result = await this.refresh({ refreshToken: input.refreshToken });
    return {
      credential: result.credential,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
    };
  }

  parseCredential(payload: unknown, schemaVersion: number): XaiProviderCredential {
    if (schemaVersion !== this.credentialSchemaVersion) {
      throw new ProviderCredentialError(
        `Unsupported xAI credential schema version: ${schemaVersion}`
      );
    }
    const result = credentialSchema.safeParse(payload);
    if (!result.success) throw new ProviderCredentialError("Invalid xAI provider credential");
    return result.data;
  }

  async refresh(
    credential: XaiProviderCredential,
    now = Date.now()
  ): Promise<ProviderRefreshResult<XaiProviderCredential>> {
    try {
      const tokens = await this.refreshToken(credential.refreshToken);
      const accessTokenExpiresAt =
        now + (tokens.expires_in ?? DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS / 1000) * 1000;
      return {
        credential: {
          refreshToken: tokens.refresh_token ?? credential.refreshToken,
          accessToken: tokens.access_token,
          accessTokenExpiresAt,
        },
        accessToken: tokens.access_token,
        accessTokenExpiresAt,
      };
    } catch (error) {
      if (error instanceof XaiTokenRefreshError) {
        const unauthorized = error.reason === "invalid_grant" || error.reason === "unauthorized";
        throw new ProviderRefreshError(
          unauthorized ? "xAI refresh was unauthorized" : "xAI refresh outcome was ambiguous",
          unauthorized ? "unauthorized" : "ambiguous",
          { cause: error }
        );
      }
      throw new ProviderRefreshError("xAI refresh outcome was ambiguous", "ambiguous", {
        cause: error,
      });
    }
  }

  cachedAccess(credential: XaiProviderCredential) {
    return credential.accessToken && credential.accessTokenExpiresAt
      ? {
          accessToken: credential.accessToken,
          accessTokenExpiresAt: credential.accessTokenExpiresAt,
        }
      : null;
  }

  runtimeMetadata(_credential: XaiProviderCredential, _externalAccountId: string | null) {
    return {};
  }
}
