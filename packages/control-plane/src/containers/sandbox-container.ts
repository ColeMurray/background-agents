import { Container } from "@cloudflare/containers";

/** Port the OpenCode server listens on inside the container. */
export const SANDBOX_DEFAULT_PORT = 4096;

/** Port code-server listens on inside the container. */
export const SANDBOX_CODE_SERVER_PORT = 8080;

/** Inactivity timeout before the container sleeps. */
export const SANDBOX_SLEEP_AFTER = "60m";

/**
 * Session configuration stored in DO storage before starting the container.
 * Read back by fetch("/configure") and passed as envVars to startAndWaitForPorts().
 */
export interface SandboxSessionConfig {
  sandboxId: string;
  sessionId: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  repoOwner: string;
  repoName: string;
  provider: string;
  model: string;
  branch?: string;
  userEnvVars?: Record<string, string>;
  codeServerEnabled?: boolean;
  anthropicApiKey?: string;
  githubAppId?: string;
  githubAppPrivateKey?: string;
  githubAppInstallationId?: string;
}

/**
 * Cloudflare Container wrapping the sandbox runtime.
 *
 * Each instance is a Durable Object addressed by session/sandbox ID.
 * The Python sandbox_runtime.entrypoint runs inside the container and
 * connects back to the control plane via outbound WebSocket.
 */
export class SandboxContainer extends Container {
  defaultPort = SANDBOX_DEFAULT_PORT;
  sleepAfter = SANDBOX_SLEEP_AFTER;
  enableInternet = true;
  pingEndpoint = "/health";

  private sessionConfig: SandboxSessionConfig | null = null;

  /**
   * Handle requests from the control plane.
   *
   * Routes:
   * - POST /configure — store session config, start container
   * - GET /status — return container state
   * - POST /destroy — stop the container
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/configure") {
      return this.handleConfigure(request);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return this.handleStatus();
    }

    if (request.method === "POST" && url.pathname === "/destroy") {
      return this.handleDestroy();
    }

    // Forward all other requests to the container process
    return super.fetch(request);
  }

  // Fix 1: No onActivityExpired override — the base class's default this.stop()
  // is the correct behavior so the container sleeps after 60m of inactivity.

  override async onStart(): Promise<void> {
    // Restore config from DO storage on restart (e.g., after a deploy)
    const stored = await this.ctx.storage.get<SandboxSessionConfig>("sessionConfig");
    if (stored) {
      this.sessionConfig = stored;
    }
  }

  override async onStop(): Promise<void> {
    // Cleanup: remove config from memory (DO storage persists independently)
    this.sessionConfig = null;
  }

  override onError(error: unknown): void {
    console.error("SandboxContainer error:", error);
  }

  private async handleConfigure(request: Request): Promise<Response> {
    const config = (await request.json()) as SandboxSessionConfig;

    // Fix 3: Validate required configuration fields before persisting
    if (!config.sandboxId || !config.sessionId || !config.controlPlaneUrl || !config.sandboxAuthToken) {
      return Response.json({ error: "Missing required configuration fields" }, { status: 400 });
    }

    this.sessionConfig = config;

    // Persist config in DO storage so it survives deploys
    await this.ctx.storage.put("sessionConfig", config);

    // Build environment variables for the container process
    const envVars: Record<string, string> = {
      SANDBOX_ID: config.sandboxId,
      SESSION_ID: config.sessionId,
      CONTROL_PLANE_URL: config.controlPlaneUrl,
      SANDBOX_AUTH_TOKEN: config.sandboxAuthToken,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
      PROVIDER: config.provider,
      MODEL: config.model,
      PYTHONUNBUFFERED: "1",
      HOME: "/root",
      NODE_ENV: "development",
      NODE_PATH: "/usr/lib/node_modules",
    };

    if (config.branch) {
      envVars.BRANCH = config.branch;
    }
    if (config.anthropicApiKey) {
      envVars.ANTHROPIC_API_KEY = config.anthropicApiKey;
    }
    if (config.githubAppId) {
      envVars.GITHUB_APP_ID = config.githubAppId;
    }
    if (config.githubAppPrivateKey) {
      envVars.GITHUB_APP_PRIVATE_KEY = config.githubAppPrivateKey;
    }
    if (config.githubAppInstallationId) {
      envVars.GITHUB_APP_INSTALLATION_ID = config.githubAppInstallationId;
    }
    if (config.codeServerEnabled) {
      envVars.CODE_SERVER_ENABLED = "true";
    }

    // Merge user-provided env vars (repo secrets)
    if (config.userEnvVars) {
      for (const [key, value] of Object.entries(config.userEnvVars)) {
        envVars[key] = value;
      }
    }

    // Build required ports list
    const ports = config.codeServerEnabled
      ? [SANDBOX_DEFAULT_PORT, SANDBOX_CODE_SERVER_PORT]
      : [SANDBOX_DEFAULT_PORT];

    // Fix 4: Wrap startAndWaitForPorts in try/catch
    try {
      await this.startAndWaitForPorts({ ports, startOptions: { envVars } });
    } catch (error) {
      console.error("SandboxContainer start failed:", error);
      return Response.json({ success: false, error: String(error) }, { status: 500 });
    }

    return Response.json({ success: true, sandboxId: config.sandboxId });
  }

  private async handleStatus(): Promise<Response> {
    // Fix 2: Include "healthy" state as running
    const state = await this.getState();
    const running = state.status === "running" || state.status === "healthy";
    return Response.json({
      running,
      sandboxId: this.sessionConfig?.sandboxId ?? null,
    });
  }

  private async handleDestroy(): Promise<Response> {
    try {
      this.ctx.container.destroy();
    } catch (error) {
      // Fix 5: Log instead of silently swallowing errors
      console.warn("SandboxContainer destroy failed (may already be stopped):", error);
    }
    return Response.json({ success: true });
  }
}
