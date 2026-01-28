#!/usr/bin/env node
/**
 * Sandbox supervisor - manages OpenCode server and bridge lifecycle.
 *
 * Runs as the main process inside the sandbox container. Responsibilities:
 * 1. Perform git sync with latest code
 * 2. Start OpenCode server
 * 3. Start bridge process for control plane communication
 * 4. Monitor processes and restart on crash with exponential backoff
 * 5. Handle graceful shutdown on SIGTERM/SIGINT
 *
 * Port of packages/modal-infra/src/sandbox/entrypoint.py
 */

import type { ChildProcess } from "node:child_process";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionConfig } from "./types.js";

// Configuration
const OPENCODE_PORT = 4096;
const HEALTH_CHECK_TIMEOUT = 30_000; // 30 seconds
const HEALTH_CHECK_INTERVAL = 500; // 500ms between checks
const MAX_RESTARTS = 5;
const BACKOFF_BASE = 2;
const BACKOFF_MAX = 60_000; // 60 seconds

class SandboxSupervisor {
  private opencodeProcess: ChildProcess | null = null;
  private bridgeProcess: ChildProcess | null = null;
  private shutdownRequested = false;
  private gitSyncComplete = false;
  private opencodeReady = false;

  // Configuration from environment
  private readonly sandboxId: string;
  private readonly controlPlaneUrl: string;
  private readonly sandboxToken: string;
  private readonly repoOwner: string;
  private readonly repoName: string;
  private readonly githubAppToken: string;
  private readonly sessionConfig: SessionConfig;
  private readonly restoredFromSnapshot: boolean;

  // Paths
  private readonly workspacePath = "/workspace";
  private readonly repoPath: string;

  constructor() {
    this.sandboxId = process.env.SANDBOX_ID || "unknown";
    this.controlPlaneUrl = process.env.CONTROL_PLANE_URL || "";
    this.sandboxToken = process.env.SANDBOX_AUTH_TOKEN || "";
    this.repoOwner = process.env.REPO_OWNER || "";
    this.repoName = process.env.REPO_NAME || "";
    this.githubAppToken = process.env.GITHUB_APP_TOKEN || "";
    this.restoredFromSnapshot = process.env.RESTORED_FROM_SNAPSHOT === "true";

    // Parse session config
    const sessionConfigJson = process.env.SESSION_CONFIG || "{}";
    try {
      this.sessionConfig = JSON.parse(sessionConfigJson);
    } catch {
      this.sessionConfig = {
        session_id: "",
        repo_owner: this.repoOwner,
        repo_name: this.repoName,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      };
    }

    this.repoPath = path.join(this.workspacePath, this.repoName);
  }

  /**
   * Execute a command and return stdout.
   */
  private exec(command: string, options: { cwd?: string } = {}): string {
    try {
      return execSync(command, {
        encoding: "utf-8",
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      const err = error as { stderr?: Buffer; message: string };
      throw new Error(err.stderr?.toString() || err.message);
    }
  }

  /**
   * Execute a command asynchronously and return result.
   */
  private async execAsync(
    command: string,
    args: string[],
    options: { cwd?: string } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({ code: code || 0, stdout, stderr });
      });

      proc.on("error", (err) => {
        resolve({ code: 1, stdout, stderr: err.message });
      });
    });
  }

  /**
   * Clone repository if needed, then synchronize with latest changes.
   */
  async performGitSync(): Promise<boolean> {
    console.log("[supervisor] Git sync environment:");
    console.log(`[supervisor]   REPO_OWNER=${this.repoOwner}`);
    console.log(`[supervisor]   REPO_NAME=${this.repoName}`);
    console.log(`[supervisor]   repo_path=${this.repoPath}`);
    console.log(`[supervisor]   GITHUB_APP_TOKEN=${this.githubAppToken ? "<set>" : "<not set>"}`);
    console.log(`[supervisor] Starting git sync for ${this.repoOwner}/${this.repoName}`);

    // Clone the repository if it doesn't exist
    if (!fs.existsSync(this.repoPath)) {
      console.log(`[supervisor] Repository not found at ${this.repoPath}, cloning...`);

      if (!this.repoOwner || !this.repoName) {
        console.log("[supervisor] No repository configured, skipping clone");
        this.gitSyncComplete = true;
        return true;
      }

      // Use authenticated URL if GitHub App token is available
      let cloneUrl: string;
      if (this.githubAppToken) {
        cloneUrl = `https://x-access-token:${this.githubAppToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
        console.log("[supervisor] Cloning from authenticated URL (token hidden)");
      } else {
        cloneUrl = `https://github.com/${this.repoOwner}/${this.repoName}.git`;
        console.log(`[supervisor] Cloning from ${cloneUrl} (no auth token)`);
      }

      const result = await this.execAsync("git", [
        "clone",
        "--depth",
        "1",
        cloneUrl,
        this.repoPath,
      ]);

      if (result.code !== 0) {
        console.log(`[supervisor] Git clone failed: ${result.stderr}`);
        this.gitSyncComplete = true;
        return false;
      }

      console.log(`[supervisor] Repository cloned successfully to ${this.repoPath}`);
    }

    try {
      // Configure remote URL with auth token if available
      if (this.githubAppToken) {
        const authUrl = `https://x-access-token:${this.githubAppToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
        await this.execAsync("git", ["remote", "set-url", "origin", authUrl], {
          cwd: this.repoPath,
        });
        console.log("[supervisor] Configured remote with auth token");
      }

      // Fetch latest changes
      const fetchResult = await this.execAsync("git", ["fetch", "origin"], { cwd: this.repoPath });
      if (fetchResult.code !== 0) {
        console.log(`[supervisor] Git fetch failed: ${fetchResult.stderr}`);
        return false;
      }

      // Get the base branch (default to main)
      const baseBranch = this.sessionConfig.branch || "main";

      // Rebase onto latest
      const rebaseResult = await this.execAsync("git", ["rebase", `origin/${baseBranch}`], {
        cwd: this.repoPath,
      });

      if (rebaseResult.code !== 0) {
        // Check if there's actually a rebase in progress before trying to abort
        const rebaseMerge = path.join(this.repoPath, ".git", "rebase-merge");
        const rebaseApply = path.join(this.repoPath, ".git", "rebase-apply");

        if (fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply)) {
          await this.execAsync("git", ["rebase", "--abort"], { cwd: this.repoPath });
          console.log("[supervisor] Git rebase aborted");
        }
        console.log("[supervisor] Git rebase failed, continuing with current state");
      }

      // Get current SHA
      const sha = this.exec("git rev-parse HEAD", { cwd: this.repoPath });
      console.log(`[supervisor] Git sync complete, HEAD: ${sha}`);

      this.gitSyncComplete = true;
      return true;
    } catch (error) {
      console.log(`[supervisor] Git sync error: ${error}`);
      this.gitSyncComplete = true; // Allow agent to proceed anyway
      return false;
    }
  }

  /**
   * Quick fetch to check if we're behind after snapshot restore.
   */
  async quickGitFetch(): Promise<void> {
    if (!fs.existsSync(this.repoPath)) {
      console.log("[supervisor] No repo path, skipping quick git fetch");
      return;
    }

    try {
      // Configure remote URL with auth token if available
      if (this.githubAppToken) {
        const authUrl = `https://x-access-token:${this.githubAppToken}@github.com/${this.repoOwner}/${this.repoName}.git`;
        await this.execAsync("git", ["remote", "set-url", "origin", authUrl], {
          cwd: this.repoPath,
        });
        console.log("[supervisor] Configured remote with auth token for quick fetch");
      }

      // Fetch from origin
      const fetchResult = await this.execAsync("git", ["fetch", "--quiet", "origin"], {
        cwd: this.repoPath,
      });

      if (fetchResult.code !== 0) {
        console.log(`[supervisor] Quick git fetch failed: ${fetchResult.stderr}`);
        return;
      }

      // Get the current branch
      const branchResult = await this.execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.repoPath,
      });
      const currentBranch = branchResult.stdout.trim();

      // Check if we have an upstream set
      const behindResult = await this.execAsync(
        "git",
        ["rev-list", "--count", `HEAD..origin/${currentBranch}`],
        { cwd: this.repoPath }
      );

      if (behindResult.code === 0) {
        const commitsBehind = parseInt(behindResult.stdout.trim() || "0", 10);
        if (commitsBehind > 0) {
          console.log(
            `[supervisor] Snapshot is ${commitsBehind} commits behind origin/${currentBranch}`
          );
          console.log("[supervisor] Note: Not auto-rebasing to preserve snapshot state");
        } else {
          console.log("[supervisor] Snapshot is up to date with remote");
        }
      } else {
        console.log("[supervisor] Could not check commits behind (may not have upstream)");
      }
    } catch (error) {
      console.log(`[supervisor] Quick git fetch error: ${error}`);
    }
  }

  /**
   * Configure git identity from session config.
   */
  async configureGitIdentity(): Promise<void> {
    const gitUser = this.sessionConfig.git_user;
    if (!gitUser || !fs.existsSync(this.repoPath)) {
      return;
    }

    try {
      await this.execAsync("git", ["config", "--local", "user.name", gitUser.name], {
        cwd: this.repoPath,
      });
      await this.execAsync("git", ["config", "--local", "user.email", gitUser.email], {
        cwd: this.repoPath,
      });
      console.log(`[supervisor] Git identity configured: ${gitUser.name} <${gitUser.email}>`);
    } catch (error) {
      console.log(`[supervisor] Failed to configure git identity: ${error}`);
    }
  }

  /**
   * Start OpenCode server with configuration.
   */
  async startOpenCode(): Promise<void> {
    console.log("[supervisor] Starting OpenCode server...");

    // Build OpenCode config from session settings
    const provider = this.sessionConfig.provider || "anthropic";
    const model = this.sessionConfig.model || "claude-sonnet-4-5";
    const opencodeConfig = {
      model: `${provider}/${model}`,
    };

    // Determine working directory - use repo path if cloned, otherwise /workspace
    let workdir = this.workspacePath;
    if (fs.existsSync(this.repoPath) && fs.existsSync(path.join(this.repoPath, ".git"))) {
      workdir = this.repoPath;
      console.log(`[supervisor] Using repo directory as workdir: ${workdir}`);
    } else {
      console.log(`[supervisor] Repo not found, using workspace: ${workdir}`);
    }

    // Set up .opencode directory for custom tools
    const opencodeDir = path.join(workdir, ".opencode");
    const toolDest = path.join(opencodeDir, "tool");
    const toolSource = "/app/inspect-plugin.js";

    if (fs.existsSync(toolSource)) {
      // Create .opencode/tool directory
      fs.mkdirSync(toolDest, { recursive: true });
      fs.copyFileSync(toolSource, path.join(toolDest, "create-pull-request.js"));
      console.log("[supervisor] Copied create-pull-request tool");

      // Create node_modules symlink to global modules
      const nodeModules = path.join(opencodeDir, "node_modules");
      const globalModules = "/usr/lib/node_modules";
      if (!fs.existsSync(nodeModules) && fs.existsSync(globalModules)) {
        try {
          fs.symlinkSync(globalModules, nodeModules);
          console.log("[supervisor] Symlinked .opencode/node_modules to global modules");
        } catch (error) {
          console.log(`[supervisor] Warning: Could not symlink node_modules: ${error}`);
        }
      }

      // Create a minimal package.json
      const packageJson = path.join(opencodeDir, "package.json");
      if (!fs.existsSync(packageJson)) {
        fs.writeFileSync(packageJson, '{"name": "opencode-tools", "type": "module"}');
      }
    }

    // Set environment variables
    // NOTE: NODE_TLS_REJECT_UNAUTHORIZED=0 is for local dev behind corporate proxies
    // that do SSL inspection. In production, remove this or use proper CA certs.
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      // Allow self-signed certs for dev (e.g., Cloudflare Zero Trust inspection)
      NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED || "0",
    };

    // Start OpenCode server
    this.opencodeProcess = spawn(
      "opencode",
      ["serve", "--port", String(OPENCODE_PORT), "--hostname", "0.0.0.0", "--print-logs"],
      {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Forward logs
    this.opencodeProcess.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[opencode] ${line}`);
        }
      }
    });

    this.opencodeProcess.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[opencode] ${line}`);
        }
      }
    });

    this.opencodeProcess.on("error", (err) => {
      console.log(`[supervisor] OpenCode process error: ${err}`);
    });

    // Wait for health check
    await this.waitForHealth();
    this.opencodeReady = true;
    console.log("[supervisor] OpenCode server is ready");
  }

  /**
   * Poll health endpoint until server is ready.
   */
  private async waitForHealth(): Promise<void> {
    const healthUrl = `http://localhost:${OPENCODE_PORT}/global/health`;
    const startTime = Date.now();

    while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT) {
      if (this.shutdownRequested) {
        throw new Error("Shutdown requested during startup");
      }

      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          return;
        }
      } catch {
        // Connection refused or timeout, retry
      }

      await this.sleep(HEALTH_CHECK_INTERVAL);
    }

    throw new Error("OpenCode server failed to become healthy");
  }

  /**
   * Start the agent bridge process.
   */
  async startBridge(): Promise<void> {
    console.log("[supervisor] Starting bridge process...");

    if (!this.controlPlaneUrl) {
      console.log("[supervisor] No control plane URL, skipping bridge");
      return;
    }

    // Wait for OpenCode to be ready
    while (!this.opencodeReady) {
      await this.sleep(100);
    }

    // Get session_id from config (required for WebSocket connection)
    const sessionId = this.sessionConfig.session_id || "";
    if (!sessionId) {
      console.log("[supervisor] Warning: No session_id in config, bridge may fail to connect");
    }

    // Run bridge using Bun (has built-in WebSocket support, no need for ws package)
    this.bridgeProcess = spawn(
      "bun",
      [
        "run",
        "/app/bridge.js",
        "--sandbox-id",
        this.sandboxId,
        "--session-id",
        sessionId,
        "--control-plane",
        this.controlPlaneUrl,
        "--token",
        this.sandboxToken,
        "--opencode-port",
        String(OPENCODE_PORT),
      ],
      {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Forward logs
    this.bridgeProcess.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          // Bridge already prefixes with [bridge]
          console.log(line);
        }
      }
    });

    this.bridgeProcess.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(line);
        }
      }
    });

    this.bridgeProcess.on("error", (err) => {
      console.log(`[supervisor] Bridge process error: ${err}`);
    });

    console.log("[supervisor] Bridge process started");

    // Check if bridge crashed immediately during startup
    await this.sleep(500);
    if (this.bridgeProcess.exitCode !== null) {
      console.log(
        `[supervisor] Bridge crashed on startup! Exit code: ${this.bridgeProcess.exitCode}`
      );
    }
  }

  /**
   * Monitor child processes and restart on crash.
   */
  async monitorProcesses(): Promise<void> {
    let restartCount = 0;

    while (!this.shutdownRequested) {
      // Check OpenCode process
      if (this.opencodeProcess && this.opencodeProcess.exitCode !== null) {
        const exitCode = this.opencodeProcess.exitCode;
        restartCount++;

        console.log(
          `[supervisor] OpenCode crashed (exit code: ${exitCode}, restart #${restartCount})`
        );

        if (restartCount > MAX_RESTARTS) {
          console.log("[supervisor] Max restarts exceeded, shutting down");
          await this.reportFatalError(`OpenCode crashed ${restartCount} times, giving up`);
          this.shutdownRequested = true;
          break;
        }

        // Exponential backoff
        const delay = Math.min(Math.pow(BACKOFF_BASE, restartCount) * 1000, BACKOFF_MAX);
        console.log(`[supervisor] Restarting OpenCode in ${delay / 1000}s...`);

        await this.sleep(delay);
        this.opencodeReady = false;
        await this.startOpenCode();
      }

      // Check bridge process
      if (this.bridgeProcess && this.bridgeProcess.exitCode !== null) {
        const exitCode = this.bridgeProcess.exitCode;
        console.log(`[supervisor] Bridge exited (exit code: ${exitCode}), restarting...`);
        await this.startBridge();
      }

      await this.sleep(1000);
    }
  }

  /**
   * Report a fatal error to the control plane.
   */
  private async reportFatalError(message: string): Promise<void> {
    console.log(`[supervisor] FATAL: ${message}`);

    if (!this.controlPlaneUrl) {
      return;
    }

    try {
      await fetch(`${this.controlPlaneUrl}/sandbox/${this.sandboxId}/error`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.sandboxToken}`,
        },
        body: JSON.stringify({ error: message, fatal: true }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      console.log(`[supervisor] Failed to report error: ${error}`);
    }
  }

  /**
   * Main supervisor loop.
   */
  async run(): Promise<void> {
    console.log(`[supervisor] Starting sandbox ${this.sandboxId}`);
    console.log(`[supervisor] Repository: ${this.repoOwner}/${this.repoName}`);

    if (this.restoredFromSnapshot) {
      console.log("[supervisor] Restored from snapshot, will skip full git sync");
    }

    // Set up signal handlers
    process.on("SIGTERM", () => this.handleSignal("SIGTERM"));
    process.on("SIGINT", () => this.handleSignal("SIGINT"));

    try {
      // Phase 1: Git sync
      if (this.restoredFromSnapshot) {
        console.log("[supervisor] Restored from snapshot, performing quick git fetch");
        await this.quickGitFetch();
        this.gitSyncComplete = true;
      } else {
        await this.performGitSync();
      }

      // Phase 2: Configure git identity
      await this.configureGitIdentity();

      // Phase 3: Start OpenCode server
      await this.startOpenCode();

      // Phase 4: Start bridge
      await this.startBridge();

      // Phase 5: Monitor processes
      console.log("[supervisor] Entering monitor_processes loop");
      await this.monitorProcesses();
    } catch (error) {
      console.log(`[supervisor] Error: ${error}`);
      await this.reportFatalError(String(error));
    } finally {
      await this.shutdown();
    }
  }

  /**
   * Handle shutdown signal.
   */
  private handleSignal(signal: string): void {
    console.log(`[supervisor] Received signal ${signal}, shutting down...`);
    this.shutdownRequested = true;
  }

  /**
   * Graceful shutdown of all processes.
   */
  async shutdown(): Promise<void> {
    console.log("[supervisor] Shutting down...");

    // Terminate bridge first
    if (this.bridgeProcess && this.bridgeProcess.exitCode === null) {
      console.log("[supervisor] Terminating bridge...");
      this.bridgeProcess.kill("SIGTERM");
      await this.waitForExit(this.bridgeProcess, 5000);
    }

    // Terminate OpenCode
    if (this.opencodeProcess && this.opencodeProcess.exitCode === null) {
      console.log("[supervisor] Terminating OpenCode...");
      this.opencodeProcess.kill("SIGTERM");
      await this.waitForExit(this.opencodeProcess, 10000);
    }

    console.log("[supervisor] Shutdown complete");
  }

  /**
   * Wait for a process to exit with timeout.
   */
  private async waitForExit(proc: ChildProcess, timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, timeout);

      proc.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Entry point
const supervisor = new SandboxSupervisor();
supervisor.run().catch((error) => {
  console.error(`[supervisor] Fatal error: ${error}`);
  process.exit(1);
});
