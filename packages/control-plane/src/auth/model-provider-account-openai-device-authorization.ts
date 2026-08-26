import {
  checkOpenAIDeviceAuthorization,
  exchangeOpenAIAuthorizationCode,
  extractOpenAIAccountId,
  openAIAccessTokenLifetimeMs,
  OPENAI_DEVICE_VERIFICATION_URL,
  startOpenAIDeviceAuthorization,
  type OpenAITokenResponse,
} from "./openai";
import type {
  ProviderDeviceAuthorizationCapability,
  ProviderDeviceAuthorizationPollResult,
} from "./model-provider-account-adapters";
import type { OpenAIProviderCredential } from "./model-provider-account-openai-adapter";
import { z } from "zod";

const openAIDeviceAuthorizationStateSchema = z.strictObject({
  deviceAuthId: z.string().min(1).max(4096),
  userCode: z.string().min(1).max(128),
});

export type OpenAIDeviceAuthorizationState = z.infer<typeof openAIDeviceAuthorizationStateSchema>;

type OpenAIDeviceDependencies = {
  start: typeof startOpenAIDeviceAuthorization;
  check: typeof checkOpenAIDeviceAuthorization;
  exchange: typeof exchangeOpenAIAuthorizationCode;
  now: () => number;
};

export class OpenAIProviderDeviceAuthorization implements ProviderDeviceAuthorizationCapability<
  OpenAIProviderCredential,
  OpenAIDeviceAuthorizationState
> {
  readonly stateSchemaVersion = 1;

  constructor(
    private readonly dependencies: OpenAIDeviceDependencies = {
      start: startOpenAIDeviceAuthorization,
      check: checkOpenAIDeviceAuthorization,
      exchange: exchangeOpenAIAuthorizationCode,
      now: () => Date.now(),
    }
  ) {}

  async start() {
    const started = await this.dependencies.start();
    return {
      providerState: {
        deviceAuthId: started.deviceAuthId,
        userCode: started.userCode,
      },
      userCode: started.userCode,
      verificationUrl: OPENAI_DEVICE_VERIFICATION_URL,
      intervalMs: started.intervalMs,
    };
  }

  parseState(payload: unknown, schemaVersion: number): OpenAIDeviceAuthorizationState {
    if (schemaVersion !== this.stateSchemaVersion) {
      throw new Error(`Unsupported OpenAI device authorization state version: ${schemaVersion}`);
    }
    return openAIDeviceAuthorizationStateSchema.parse(payload);
  }

  async poll(
    state: OpenAIDeviceAuthorizationState
  ): Promise<ProviderDeviceAuthorizationPollResult<OpenAIProviderCredential>> {
    const status = await this.dependencies.check(state.deviceAuthId, state.userCode);
    if (status.status === "pending") return { status: "pending" };
    const tokens = await this.dependencies.exchange(status.authorizationCode, status.codeVerifier);
    return { status: "connected", connection: this.connection(tokens) };
  }

  private connection(tokens: OpenAITokenResponse) {
    const externalAccountId = extractOpenAIAccountId(tokens);
    if (!externalAccountId) throw new Error("OpenAI account identity could not be verified");
    const accessTokenExpiresAt =
      this.dependencies.now() + openAIAccessTokenLifetimeMs(tokens.expires_in);
    return {
      credential: {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessTokenExpiresAt,
        accountId: externalAccountId,
      },
      externalAccountId,
      accessTokenExpiresAt,
    };
  }
}
