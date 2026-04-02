/**
 * Cloudflare Sandbox provider implementation.
 *
 * Uses the @cloudflare/sandbox SDK to manage sandbox lifecycle.
 * The SDK handles container start/stop automatically — no manual
 * start() or startAndWaitForPorts() calls needed.
 */

import {
  SandboxProviderError,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import { getSandbox } from "../../containers/sandbox-container";

/**
 * Secrets passed from the control plane env to the sandbox.
 */
export interface ContainerSecrets {
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

/**
 * Cloudflare Sandbox provider.
 *
 * Creates sandboxes using the @cloudflare/sandbox SDK. The SDK's getSandbox()
 * returns a Sandbox instance that auto-starts on first operation. Operations
 * like gitCheckout(), exec(), and startProcess() call INTO the container.
 */
export class CloudflareContainerProvider implements SandboxProvider {
  readonly name = "cloudflare-sandbox";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: false,
    supportsRestore: false,
    supportsWarm: false,
  };

  constructor(
    private readonly sandboxBinding: DurableObjectNamespace,
    private readonly secrets: ContainerSecrets
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Get a sandbox instance keyed by sandbox ID (session affinity).
      // The container auto-starts on first operation — no manual start() needed.
      const sandbox = getSandbox(this.sandboxBinding, config.sandboxId, {
        sleepAfter: "1h",
      });

      // Set environment variables for the sandbox process
      await sandbox.setEnvVars({
        ANTHROPIC_API_KEY: this.secrets.anthropicApiKey,
        GITHUB_APP_ID: this.secrets.githubAppId,
        GITHUB_APP_PRIVATE_KEY: this.secrets.githubAppPrivateKey,
        GITHUB_APP_INSTALLATION_ID: this.secrets.githubAppInstallationId,
        SANDBOX_ID: config.sandboxId,
        CONTROL_PLANE_URL: config.controlPlaneUrl,
        SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
        REPO_OWNER: config.repoOwner,
        REPO_NAME: config.repoName,
        SESSION_CONFIG: JSON.stringify({
          session_id: config.sessionId,
          provider: config.provider,
          model: config.model,
          branch: config.branch || "main",
        }),
      });

      // Merge user env vars (repo secrets)
      if (config.userEnvVars && Object.keys(config.userEnvVars).length > 0) {
        await sandbox.setEnvVars(config.userEnvVars);
      }

      // Clone the repository
      const repoUrl = `https://github.com/${config.repoOwner}/${config.repoName}.git`;
      await sandbox.gitCheckout(repoUrl, {
        branch: config.branch,
        targetDir: `/workspace/${config.repoName}`,
        depth: 100,
      });

      // Run setup script if it exists (5 min timeout)
      await sandbox.exec(
        `cd /workspace/${config.repoName} && [ -f .openinspect/setup.sh ] && bash .openinspect/setup.sh || true`,
        { timeout: 300_000 }
      );

      // Start OpenCode server as a background process
      const proc = await sandbox.startProcess(
        `cd /workspace/${config.repoName} && opencode server --port 4096`,
        { cwd: `/workspace/${config.repoName}` }
      );

      // Wait for OpenCode to be ready (30s timeout)
      await proc.waitForPort(4096, { timeout: 30_000 });

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        status: "running",
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof SandboxProviderError) {
        throw error;
      }
      throw SandboxProviderError.fromFetchError("Failed to create sandbox", error);
    }
  }
}

/**
 * Factory function to create a CloudflareContainerProvider.
 */
export function createContainerProvider(
  sandboxBinding: DurableObjectNamespace,
  secrets: ContainerSecrets
): CloudflareContainerProvider {
  return new CloudflareContainerProvider(sandboxBinding, secrets);
}
