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
import { getSandbox, type Sandbox } from "../../containers/sandbox-container";

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
    private readonly sandboxBinding: DurableObjectNamespace<Sandbox>,
    private readonly secrets: ContainerSecrets
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // Get a sandbox instance keyed by sandbox ID (session affinity).
      const sandbox = getSandbox(this.sandboxBinding, config.sandboxId, {
        sleepAfter: "1h",
      });

      // Clone repo (triggers container start, relatively fast for public repos)
      const repoUrl = `https://github.com/${config.repoOwner}/${config.repoName}.git`;
      console.log("[sandbox] gitCheckout", repoUrl);
      await sandbox.gitCheckout(repoUrl, {
        branch: config.branch,
        targetDir: `/workspace/${config.repoName}`,
        depth: 100,
      });
      console.log("[sandbox] gitCheckout done");

      // Build env vars map. We write these to a file inside the container
      // and source it in the exec command — this is the most reliable approach
      // since setEnvVars() doesn't propagate to exec(), and the exec `env`
      // option may not be supported by the container agent (v0.7.18 vs SDK v0.8.4).
      const sandboxEnv: Record<string, string> = {
        SANDBOX_ID: config.sandboxId,
        CONTROL_PLANE_URL: config.controlPlaneUrl,
        SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
        REPO_OWNER: config.repoOwner,
        REPO_NAME: config.repoName,
        VCS_HOST: "github.com",
        VCS_CLONE_USERNAME: "x-access-token",
        PYTHONPATH: "/app",
        PYTHONUNBUFFERED: "1",
        HOME: "/root",
        // Skip git clone — we already did it via gitCheckout() above.
        RESTORED_FROM_SNAPSHOT: "true",
        SESSION_CONFIG: JSON.stringify({
          session_id: config.sessionId,
          provider: config.provider,
          model: config.model,
          branch: config.branch || "main",
        }),
      };

      if (this.secrets.anthropicApiKey) {
        sandboxEnv.ANTHROPIC_API_KEY = this.secrets.anthropicApiKey;
      }
      if (this.secrets.githubAppId) {
        sandboxEnv.GITHUB_APP_ID = this.secrets.githubAppId;
      }
      if (this.secrets.githubAppPrivateKey) {
        sandboxEnv.GITHUB_APP_PRIVATE_KEY = this.secrets.githubAppPrivateKey;
      }
      if (this.secrets.githubAppInstallationId) {
        sandboxEnv.GITHUB_APP_INSTALLATION_ID = this.secrets.githubAppInstallationId;
      }

      // Merge user-configured env vars (repo secrets from the UI).
      if (config.userEnvVars) {
        Object.assign(sandboxEnv, config.userEnvVars);
      }

      // Write env vars to a file inside the container, then source it.
      // Uses base64-encoded values to avoid any shell escaping issues with
      // multiline PEM keys, JSON, or special characters.
      const envLines = Object.entries(sandboxEnv).map(
        ([k, v]) => `export ${k}="$(echo '${Buffer.from(v).toString("base64")}' | base64 -d)"`
      );
      const envScript = `#!/bin/sh\n${envLines.join("\n")}\n`;
      console.log("[sandbox] writing env file with", Object.keys(sandboxEnv).length, "vars");
      await sandbox.writeFile("/tmp/sandbox-env.sh", envScript);

      // Start the Python entrypoint as a fire-and-forget command.
      // The entrypoint handles: setup.sh → start.sh → OpenCode → bridge.
      // The bridge connects back to the control plane via WebSocket.
      // On timeout, the SDK closes the caller-side connection but the
      // process continues running inside the container.
      console.log("[sandbox] starting entrypoint via exec");
      sandbox
        .exec(
          `source /tmp/sandbox-env.sh && cd /workspace/${config.repoName} && python3 -m sandbox_runtime.entrypoint`,
          { timeout: 600_000 }
        )
        .then((result) => {
          console.log("[sandbox] entrypoint exited", {
            exitCode: result.exitCode,
            stdout: result.stdout?.substring(0, 200),
            stderr: result.stderr?.substring(0, 200),
          });
        })
        .catch((err) => {
          console.error("[sandbox] entrypoint failed", String(err));
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
  sandboxBinding: DurableObjectNamespace<Sandbox>,
  secrets: ContainerSecrets
): CloudflareContainerProvider {
  return new CloudflareContainerProvider(sandboxBinding, secrets);
}
