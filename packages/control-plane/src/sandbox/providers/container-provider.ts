import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import type { SandboxSessionConfig } from "../../containers/sandbox-container";

/**
 * Secrets passed from the control plane env to the container at startup.
 * These are NOT part of CreateSandboxConfig — they come from the Worker's env bindings.
 */
export interface ContainerSecrets {
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

/**
 * Cloudflare Container sandbox provider.
 *
 * Creates sandboxes by getting a Durable Object stub for the SandboxContainer
 * class and calling its /configure endpoint with session config.
 */
export class CloudflareContainerProvider implements SandboxProvider {
  readonly name = "cloudflare-container";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(
    private readonly containerBinding: DurableObjectNamespace,
    private readonly secrets: ContainerSecrets
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const doId = this.containerBinding.idFromName(config.sandboxId);
      const stub = this.containerBinding.get(doId);

      const sessionConfig: SandboxSessionConfig = {
        sandboxId: config.sandboxId,
        sessionId: config.sessionId,
        controlPlaneUrl: config.controlPlaneUrl,
        sandboxAuthToken: config.sandboxAuthToken,
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        provider: config.provider,
        model: config.model,
        branch: config.branch,
        userEnvVars: config.userEnvVars,
        codeServerEnabled: config.codeServerEnabled,
        anthropicApiKey: this.secrets.anthropicApiKey,
        githubAppId: this.secrets.githubAppId,
        githubAppPrivateKey: this.secrets.githubAppPrivateKey,
        githubAppInstallationId: this.secrets.githubAppInstallationId,
      };

      const response = await stub.fetch("http://container/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionConfig),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw SandboxProviderError.fromFetchError(
          `Container configure failed: ${errorText}`,
          new Error(errorText),
          response.status
        );
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        status: "warming",
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError(
        "Failed to create container sandbox",
        error
      );
    }
  }
}

export function createContainerProvider(
  containerBinding: DurableObjectNamespace,
  secrets: ContainerSecrets
): CloudflareContainerProvider {
  return new CloudflareContainerProvider(containerBinding, secrets);
}
