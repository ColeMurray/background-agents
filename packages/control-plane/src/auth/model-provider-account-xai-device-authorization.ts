import { z } from "zod";
import {
  DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS,
  type ProviderDeviceAuthorizationCapability,
  type ProviderDeviceAuthorizationPollResult,
} from "./model-provider-account-adapters";
import type { XaiProviderCredential } from "./model-provider-account-xai-adapter";
import { checkXaiDeviceAuthorization, fetchXaiAccountId, startXaiDeviceAuthorization } from "./xai";

const xaiDeviceAuthorizationStateSchema = z.strictObject({
  deviceCode: z.string().min(1).max(4096),
});

export type XaiDeviceAuthorizationState = z.infer<typeof xaiDeviceAuthorizationStateSchema>;

type XaiDeviceDependencies = {
  start: typeof startXaiDeviceAuthorization;
  check: typeof checkXaiDeviceAuthorization;
  accountId: typeof fetchXaiAccountId;
  now: () => number;
};

export class XaiProviderDeviceAuthorization implements ProviderDeviceAuthorizationCapability<
  XaiProviderCredential,
  XaiDeviceAuthorizationState
> {
  readonly stateSchemaVersion = 1;

  constructor(
    private readonly dependencies: XaiDeviceDependencies = {
      start: startXaiDeviceAuthorization,
      check: checkXaiDeviceAuthorization,
      accountId: fetchXaiAccountId,
      now: () => Date.now(),
    }
  ) {}

  async start() {
    const started = await this.dependencies.start();
    return {
      providerState: {
        deviceCode: started.deviceCode,
      },
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      expiresInMs: started.expiresInMs,
      intervalMs: started.intervalMs,
    };
  }

  parseState(payload: unknown, schemaVersion: number): XaiDeviceAuthorizationState {
    if (schemaVersion !== this.stateSchemaVersion) {
      throw new Error(`Unsupported xAI device authorization state version: ${schemaVersion}`);
    }
    return xaiDeviceAuthorizationStateSchema.parse(payload);
  }

  async poll(
    state: XaiDeviceAuthorizationState,
    intervalMs: number
  ): Promise<ProviderDeviceAuthorizationPollResult<XaiProviderCredential>> {
    const result = await this.dependencies.check(state.deviceCode, intervalMs);
    if (result.status !== "connected") return result;

    const externalAccountId = await this.dependencies.accountId(result.tokens.access_token);
    const accessTokenExpiresAt =
      this.dependencies.now() +
      (result.tokens.expires_in ?? DEFAULT_PROVIDER_ACCESS_TOKEN_LIFETIME_MS / 1000) * 1000;
    return {
      status: "connected",
      connection: {
        credential: {
          refreshToken: result.tokens.refresh_token,
          accessToken: result.tokens.access_token,
          accessTokenExpiresAt,
        },
        externalAccountId,
        accessTokenExpiresAt,
      },
    };
  }
}
