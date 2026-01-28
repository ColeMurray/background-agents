/**
 * Cloudflare Sandbox manager.
 *
 * Implements the SandboxManager interface using Cloudflare's container platform.
 * Does not support snapshots in the current implementation.
 */

import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../types";
import type { SandboxManager, StartSandboxConfig, StartSandboxResult } from "./types";

/**
 * Cloudflare sandbox manager.
 *
 * Uses the Cloudflare Sandbox SDK to manage container lifecycle.
 * Each sandbox is a Durable Object that wraps a container.
 */
export class CloudflareSandboxManager implements SandboxManager {
  private readonly env: Env;
  private readonly sleepAfter: string;

  constructor(env: Env) {
    this.env = env;
    // Default to 1 hour sleep timeout
    this.sleepAfter = env.SANDBOX_SLEEP_AFTER || "1h";
  }

  /**
   * Get or create a sandbox instance by ID.
   *
   * The sandbox container starts lazily on first operation.
   */
  private getSandboxInstance(sandboxId: string): ReturnType<typeof getSandbox> {
    if (!this.env.Sandbox) {
      throw new Error("Sandbox binding not configured. Add 'Sandbox' to wrangler.jsonc bindings.");
    }
    return getSandbox(this.env.Sandbox, sandboxId, {
      sleepAfter: this.sleepAfter,
    });
  }

  /**
   * Cloudflare does not support snapshots in this implementation.
   */
  supportsSnapshots(): boolean {
    return false;
  }

  /**
   * Start a sandbox with the supervisor process.
   *
   * This starts the container and runs the supervisor which:
   * 1. Clones the repository
   * 2. Starts OpenCode server
   * 3. Starts the bridge for WebSocket communication
   */
  async startSandbox(config: StartSandboxConfig): Promise<StartSandboxResult> {
    const sandbox = this.getSandboxInstance(config.sandboxId);

    // Build session config JSON
    const sessionConfig = JSON.stringify({
      session_id: config.sessionId,
      repo_owner: config.repoOwner,
      repo_name: config.repoName,
      provider: config.provider || "anthropic",
      model: config.model || "claude-sonnet-4-5",
      git_user: config.gitUserName
        ? {
            name: config.gitUserName,
            email: config.gitUserEmail || `${config.gitUserName}@users.noreply.github.com`,
          }
        : undefined,
    });

    // Environment variables for the sandbox supervisor process
    const envVars: Record<string, string> = {
      SANDBOX_ID: config.sandboxId,
      SESSION_ID: config.sessionId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      SESSION_CONFIG: sessionConfig,
    };

    // Add GitHub App token if available
    if (config.githubAppToken) {
      envVars.GITHUB_APP_TOKEN = config.githubAppToken;
    }

    // Add Anthropic API key from environment
    if (this.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    }

    console.log(
      `[cloudflare] Starting sandbox ${config.sandboxId} for ${config.repoOwner}/${config.repoName}`
    );

    // Start the supervisor process with environment variables
    const process = await sandbox.startProcess("node /app/supervisor.js", {
      cwd: "/workspace",
      env: envVars,
    });

    console.log(`[cloudflare] Supervisor started for ${config.sandboxId}, pid: ${process.pid}`);

    return {
      sandboxId: config.sandboxId,
      status: "starting",
    };
  }

  /**
   * Stop and destroy a sandbox.
   */
  async destroySandbox(sandboxId: string): Promise<void> {
    console.log(`[cloudflare] Destroying sandbox ${sandboxId}`);
    const sandbox = this.getSandboxInstance(sandboxId);
    await sandbox.destroy();
  }

  /**
   * Execute a command in a sandbox.
   */
  async exec(
    sandboxId: string,
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number; success: boolean }> {
    const sandbox = this.getSandboxInstance(sandboxId);
    const result = await sandbox.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.success,
    };
  }

  /**
   * Read a file from the sandbox.
   */
  async readFile(sandboxId: string, path: string): Promise<string> {
    const sandbox = this.getSandboxInstance(sandboxId);
    const result = await sandbox.readFile(path);
    return result.content;
  }

  /**
   * Write a file to the sandbox.
   */
  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const sandbox = this.getSandboxInstance(sandboxId);
    await sandbox.writeFile(path, content);
  }
}

/**
 * Create a Cloudflare sandbox manager.
 */
export function createCloudflareSandboxManager(env: Env): CloudflareSandboxManager {
  return new CloudflareSandboxManager(env);
}
