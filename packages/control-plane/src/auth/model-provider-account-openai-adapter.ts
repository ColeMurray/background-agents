import { z } from "zod";
import {
  connectOpenAIModelProviderAccountRequestSchema,
  reconnectOpenAIModelProviderAccountRequestSchema,
  type ConnectModelProviderAccountRequest,
  type ReconnectModelProviderAccountRequest,
} from "@open-inspect/shared/types/provider-accounts";
import { extractOpenAIAccountId, refreshOpenAIToken, OpenAITokenRefreshError } from "./openai";
import {
  DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS,
  DEFAULT_PROVIDER_REFRESH_BUFFER_MS,
  ProviderCredentialError,
  ProviderIdentityError,
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderConnectionResult,
  type ProviderRefreshResult,
} from "./model-provider-account-adapters";

const credentialSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).optional(),
  accessTokenExpiresAt: z.number().int().positive().optional(),
  accountId: z.string().min(1).optional(),
});
const connectInputSchema = z.union([
  connectOpenAIModelProviderAccountRequestSchema,
  reconnectOpenAIModelProviderAccountRequestSchema,
]);

export type OpenAIProviderCredential = z.infer<typeof credentialSchema>;
export type OpenAIProviderConnectInput =
  | Extract<ConnectModelProviderAccountRequest, { provider: "openai" }>
  | Extract<ReconnectModelProviderAccountRequest, { provider: "openai" }>;

type RefreshOpenAI = typeof refreshOpenAIToken;

function isUnauthorized(error: OpenAITokenRefreshError): boolean {
  if (error.status === 401) return true;
  try {
    const body: unknown = JSON.parse(error.body);
    return !!body && typeof body === "object" && "error" in body && body.error === "invalid_grant";
  } catch {
    return false;
  }
}

export class OpenAIModelProviderAccountAdapter implements ModelProviderAccountAdapter<
  OpenAIProviderCredential,
  OpenAIProviderConnectInput
> {
  readonly provider = "openai" as const;
  readonly credentialSchemaVersion = 1;
  readonly refreshBufferMs = DEFAULT_PROVIDER_REFRESH_BUFFER_MS;

  constructor(private readonly refreshToken: RefreshOpenAI = refreshOpenAIToken) {}

  parseConnectInput(input: unknown): OpenAIProviderConnectInput {
    return connectInputSchema.parse(input);
  }

  async connect(
    input: OpenAIProviderConnectInput
  ): Promise<ProviderConnectionResult<OpenAIProviderCredential>> {
    const result = await this.refresh({ refreshToken: input.refreshToken });
    this.validateExternalIdentity(result.externalAccountId, input.accountId);
    return {
      credential: result.credential,
      externalAccountId: result.externalAccountId,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
    };
  }

  parseCredential(payload: unknown, schemaVersion: number): OpenAIProviderCredential {
    if (schemaVersion !== this.credentialSchemaVersion) {
      throw new ProviderCredentialError(
        `Unsupported OpenAI credential schema version: ${schemaVersion}`
      );
    }
    const result = credentialSchema.safeParse(payload);
    if (!result.success) throw new ProviderCredentialError("Invalid OpenAI provider credential");
    return result.data;
  }

  async refresh(
    credential: OpenAIProviderCredential,
    now = Date.now()
  ): Promise<ProviderRefreshResult<OpenAIProviderCredential>> {
    try {
      const tokens = await this.refreshToken(credential.refreshToken);
      if (!tokens.refresh_token) {
        throw new ProviderRefreshError(
          "OpenAI refresh did not return a replacement refresh token",
          "ambiguous"
        );
      }
      const accessTokenExpiresAt =
        now + (tokens.expires_in ?? DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS / 1000) * 1000;
      const accountId = extractOpenAIAccountId(tokens);
      return {
        credential: {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt,
          ...(accountId ? { accountId } : {}),
        },
        accessToken: tokens.access_token,
        accessTokenExpiresAt,
        externalAccountId: accountId,
      };
    } catch (error) {
      if (error instanceof ProviderRefreshError) throw error;
      if (error instanceof OpenAITokenRefreshError && isUnauthorized(error)) {
        throw new ProviderRefreshError("OpenAI refresh was unauthorized", "unauthorized", {
          cause: error,
        });
      }
      throw new ProviderRefreshError("OpenAI refresh outcome was ambiguous", "ambiguous", {
        cause: error,
      });
    }
  }

  cachedAccess(credential: OpenAIProviderCredential) {
    return credential.accessToken && credential.accessTokenExpiresAt
      ? {
          accessToken: credential.accessToken,
          accessTokenExpiresAt: credential.accessTokenExpiresAt,
        }
      : null;
  }

  runtimeMetadata(
    credential: OpenAIProviderCredential,
    externalAccountId: string | null
  ): Record<string, string> {
    const accountId = credential.accountId ?? externalAccountId;
    return accountId ? { accountId } : {};
  }

  validateExternalIdentity(actual: string | undefined, expected: string | null): void {
    if (!actual) {
      throw new ProviderIdentityError("OpenAI account identity could not be verified");
    }
    if (!expected || actual !== expected) {
      throw new ProviderIdentityError("OpenAI account identity did not match");
    }
  }
}
