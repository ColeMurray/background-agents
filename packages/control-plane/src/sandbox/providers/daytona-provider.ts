/**
 * Daytona sandbox provider implementation backed by the Daytona shim service.
 */

import type { DaytonaServiceClient } from "../daytona-service-client";
import { DaytonaServiceApiError } from "../daytona-service-client";
import {
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = "daytona";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(private readonly client: DaytonaServiceClient) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const result = await this.client.createSandbox(
        {
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          repoOwner: config.repoOwner,
          repoName: config.repoName,
          controlPlaneUrl: config.controlPlaneUrl,
          sandboxAuthToken: config.sandboxAuthToken,
          provider: config.provider,
          model: config.model,
          userEnvVars: config.userEnvVars,
          timeoutSeconds: config.timeoutSeconds,
          branch: config.branch,
          codeServerEnabled: config.codeServerEnabled,
          sandboxSettings: config.sandboxSettings,
        },
        config.correlation
      );

      return {
        sandboxId: result.sandboxId,
        providerObjectId: result.providerObjectId,
        status: result.status,
        createdAt: result.createdAt,
        codeServerUrl: result.codeServerUrl,
        codeServerPassword: result.codeServerPassword,
        tunnelUrls: result.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create Daytona sandbox", error);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      return await this.client.resumeSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          sandboxId: config.sandboxId,
          timeoutSeconds: config.timeoutSeconds,
          codeServerEnabled: config.codeServerEnabled,
          sandboxSettings: config.sandboxSettings,
        },
        config.correlation
      );
    } catch (error) {
      throw this.classifyError("Failed to resume Daytona sandbox", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      return await this.client.stopSandbox(
        {
          providerObjectId: config.providerObjectId,
          sessionId: config.sessionId,
          reason: config.reason,
        },
        config.correlation
      );
    } catch (error) {
      throw this.classifyError("Failed to stop Daytona sandbox", error);
    }
  }

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof DaytonaServiceApiError) {
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }

    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createDaytonaProvider(client: DaytonaServiceClient): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client);
}
