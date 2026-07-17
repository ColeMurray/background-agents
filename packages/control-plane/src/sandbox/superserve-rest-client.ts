/**
 * Direct REST client for Superserve sandboxes.
 *
 * Lifecycle requests use the Superserve control plane with X-API-Key auth.
 * Commands run against the per-sandbox data plane with the short-lived access
 * token returned by create/activate.
 */

const CREATE_TIMEOUT_MS = 120_000;
const ACTIVATE_TIMEOUT_MS = 120_000;
const LIFECYCLE_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 20_000;
const RUNTIME_ENTRYPOINT_TIMEOUT_SECONDS = 10;
const MIN_PREVIEW_PORT = 1024;
const MAX_PREVIEW_PORT = 65535;
const RUNTIME_LOG_PATH = "/tmp/openinspect/runtime.log";
const TUNNEL_ENV_FILE_PATH = "/workspace/.tunnels.env";
const SHARED_DATA_PLANE_HOSTS = new Set([
  "sandbox.superserve.ai",
  "staging-sandbox.superserve.ai",
  "usw-sandbox.superserve.ai",
]);

export interface SuperserveRestConfig {
  apiUrl: string;
  apiKey: string;
  template: string;
  sandboxHost: string;
  /** Delete a sandbox after it remains paused for this many seconds. */
  autoDeleteSeconds?: number;
  /** Optional egress rules applied to every sandbox. */
  network?: SuperserveNetworkConfig;
}

export interface SuperserveNetworkConfig {
  allowOut?: string[];
  denyOut?: string[];
}

export interface SuperserveCreateSandboxParams {
  name: string;
  envVars: Record<string, string>;
  metadata: Record<string, string>;
  timeoutSeconds?: number;
}

export interface SuperserveSandboxResponse {
  id: string;
  name?: string;
  status: string;
  access_token?: string;
  created_at?: string;
}

interface SuperserveExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export class SuperserveApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "SuperserveApiError";
  }
}

export class SuperserveNotFoundError extends SuperserveApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = "SuperserveNotFoundError";
  }
}

export class SuperserveRestClient {
  readonly config: SuperserveRestConfig;
  private readonly apiUrl: string;
  private readonly sandboxHost: string;

  constructor(config: SuperserveRestConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.sandboxHost = normalizeSandboxHost(config.sandboxHost);
    this.config = {
      ...config,
      apiUrl: this.apiUrl,
      sandboxHost: this.sandboxHost,
    };
  }

  async createSandbox(params: SuperserveCreateSandboxParams): Promise<SuperserveSandboxResponse> {
    const body: Record<string, unknown> = {
      name: params.name,
      from_template: this.config.template,
      env_vars: params.envVars,
      metadata: params.metadata,
    };
    if (params.timeoutSeconds !== undefined) {
      body.timeout_seconds = params.timeoutSeconds;
    }
    if (this.config.autoDeleteSeconds !== undefined) {
      body.auto_delete_seconds = this.config.autoDeleteSeconds;
    }
    if (this.config.network) {
      body.network = {
        allow_out: this.config.network.allowOut,
        deny_out: this.config.network.denyOut,
      };
    }

    return await this.controlPlaneRequest<SuperserveSandboxResponse>(
      "POST",
      "/sandboxes",
      CREATE_TIMEOUT_MS,
      body
    );
  }

  async activateSandbox(id: string): Promise<SuperserveSandboxResponse> {
    return await this.controlPlaneRequest<SuperserveSandboxResponse>(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/activate`,
      ACTIVATE_TIMEOUT_MS
    );
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.controlPlaneRequest<void>(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/pause`,
      LIFECYCLE_TIMEOUT_MS
    );
  }

  async deleteSandbox(id: string): Promise<void> {
    await this.controlPlaneRequest<void>(
      "DELETE",
      `/sandboxes/${encodeURIComponent(id)}`,
      LIFECYCLE_TIMEOUT_MS
    );
  }

  /** Ensure the Open-Inspect bridge is running without duplicating a preserved process. */
  async startRuntime(
    id: string,
    accessToken: string,
    env: Record<string, string> = {},
    tunnelUrls?: Record<string, string>
  ): Promise<void> {
    const commands = ["mkdir -p /workspace /tmp/openinspect"];
    if (tunnelUrls && Object.keys(tunnelUrls).length > 0) {
      const tunnelEnv = [
        `TUNNEL_SANDBOX_ID=${env.SANDBOX_ID ?? ""}`,
        ...Object.entries(tunnelUrls)
          .sort(([left], [right]) => Number(left) - Number(right))
          .map(([port, url]) => `TUNNEL_${port}=${url}`),
      ].join("\n");
      commands.push(`printf '%s\\n' ${shellQuote(tunnelEnv)} > ${TUNNEL_ENV_FILE_PATH}`);
    }
    commands.push(
      "runtime_module='sandbox_runtime''.''entrypoint'; " +
        "if ! pgrep -f '[s]andbox_runtime[.]entrypoint' >/dev/null 2>&1; then " +
        `nohup python3 -m "$runtime_module" >>${RUNTIME_LOG_PATH} 2>&1 </dev/null & echo $!; ` +
        "fi"
    );

    const result = await this.dataPlaneRequest<SuperserveExecResult>(id, accessToken, "/exec", {
      command: commands.join("; "),
      working_dir: "/workspace",
      env,
      timeout_s: RUNTIME_ENTRYPOINT_TIMEOUT_SECONDS,
    });

    if (result.exit_code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "unknown command failure";
      throw new SuperserveApiError(`Failed to launch sandbox runtime: ${detail}`, 500);
    }
  }

  getPreviewUrl(id: string, port: number): string {
    if (!Number.isInteger(port) || port < MIN_PREVIEW_PORT || port > MAX_PREVIEW_PORT) {
      throw new SuperserveApiError(
        `Invalid Superserve preview port ${port}; expected ${MIN_PREVIEW_PORT}-${MAX_PREVIEW_PORT}`,
        400
      );
    }
    return `https://${port}-${id}.${this.sandboxHost}`;
  }

  private async controlPlaneRequest<T>(
    method: "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    body?: unknown
  ): Promise<T> {
    return await this.request<T>(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs
    );
  }

  private async dataPlaneRequest<T>(
    id: string,
    accessToken: string,
    path: string,
    body: unknown
  ): Promise<T> {
    const useSharedHost = SHARED_DATA_PLANE_HOSTS.has(this.sandboxHost.toLowerCase());
    const baseUrl = useSharedHost
      ? `https://${this.sandboxHost}`
      : `https://boxd-${id}.${this.sandboxHost}`;
    const routingHeaders: Record<string, string> = useSharedHost
      ? { "X-Superserve-Sandbox-Id": id }
      : {};

    return await this.request<T>(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Token": accessToken,
          ...routingHeaders,
        },
        body: JSON.stringify(body),
      },
      EXEC_TIMEOUT_MS
    );
  }

  private async request<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Superserve request timed out after ${timeoutMs}ms`);
        }
        throw error;
      }

      const responseText = await response.text();
      if (response.status === 404) {
        throw new SuperserveNotFoundError(responseText || `Not found: ${url}`);
      }
      if (!response.ok) {
        throw new SuperserveApiError(responseText || response.statusText, response.status);
      }
      if (!responseText) return undefined as T;

      try {
        return JSON.parse(responseText) as T;
      } catch {
        throw new SuperserveApiError(`Invalid JSON response from Superserve: ${responseText}`, 502);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeSandboxHost(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized.includes("/")) {
    throw new Error("SUPERSERVE_SANDBOX_HOST must be a bare hostname");
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createSuperserveRestClient(config: SuperserveRestConfig): SuperserveRestClient {
  return new SuperserveRestClient(config);
}
