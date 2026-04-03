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
      const sandbox = getSandbox(this.sandboxBinding, config.sandboxId, {
        sleepAfter: "1h",
      });

      // Set env vars (fast — just stores config, doesn't block on container start)
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

      if (config.userEnvVars && Object.keys(config.userEnvVars).length > 0) {
        await sandbox.setEnvVars(config.userEnvVars);
      }

      // Clone repo (triggers container start, relatively fast for public repos)
      const repoUrl = `https://github.com/${config.repoOwner}/${config.repoName}.git`;
      console.log("[sandbox] gitCheckout", repoUrl);
      await sandbox.gitCheckout(repoUrl, {
        branch: config.branch,
        targetDir: `/workspace/${config.repoName}`,
        depth: 100,
      });
      console.log("[sandbox] gitCheckout done");

      // Start the full sandbox runtime (setup + OpenCode + bridge) in the background.
      // The Python entrypoint handles: setup.sh → start.sh → OpenCode → bridge.
      // The bridge connects back to the control plane via WebSocket, which transitions
      // the sandbox from "connecting" to "running".
      console.log("[sandbox] starting sandbox runtime (entrypoint)");
      sandbox
        .exec(`cd /workspace/${config.repoName} && python3 -m sandbox_runtime.entrypoint`, {
          timeout: 600_000,
        })
        .then((result) => {
          console.log("[sandbox] entrypoint exited", { exitCode: result.exitCode });
        })
        .catch((err) => {
          console.error("[sandbox] entrypoint failed", err);
        });

      // Return "warming" — the bridge will connect back via WebSocket and
      // transition the sandbox to "running". The lifecycle manager waits
      // for this in the "connecting" phase.
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("Sandbox creation failed:", errorMsg);
      throw SandboxProviderError.fromFetchError(`Failed to create sandbox: ${errorMsg}`, error);
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
