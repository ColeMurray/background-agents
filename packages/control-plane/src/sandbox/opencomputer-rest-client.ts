/**
 * Direct REST client for OpenComputer sandboxes.
 *
 * The path names are intentionally configurable because OpenComputer deployments
 * may expose versioned or compatibility routes. Defaults are the canonical MVP
 * shape expected by OpenInspect.
 */

import { createLogger } from "../logger";

const log = createLogger("opencomputer-rest-client");

export const OPENCOMPUTER_CHECKPOINT_KIND = "disk_only" as const;

export const OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY = {
  mode: "delete_oldest",
  maxCount: 30,
} as const;

export interface OpenComputerRestConfig {
  /** OpenComputer API base URL, e.g. https://api.opencomputer.dev */
  apiUrl: string;
  /** OpenComputer API key */
  apiKey: string;
  /** Declarative template identifier containing the OpenInspect runtime */
  template: string;
  /** Header used for API key authentication. Defaults to X-API-Key. */
  authHeaderName?: string;
  /** Optional prefix for the API key header value, e.g. "Bearer ". */
  authHeaderValuePrefix?: string;
  /** Optional route path overrides */
  paths?: Partial<OpenComputerApiPaths>;
}

export interface OpenComputerApiPaths {
  sandboxes: string;
  sandboxFromCheckpoint: string;
  sandbox: string;
  wake: string;
  hibernate: string;
  timeout: string;
  tunnel: string;
  exec: string;
  checkpoints: string;
  checkpoint: string;
  secretStores: string;
  secretStore: string;
  secret: string;
}

export interface OpenComputerSandboxResponse {
  id: string;
  sandboxID?: string;
  state?: string;
  status?: string;
  sandboxDomain?: string;
  routes?: Array<{ port: number; url: string }>;
  tunnelUrls?: Record<string, string>;
}

export interface OpenComputerCreateSandboxParams {
  name: string;
  template: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSeconds?: number;
  secretStore?: string;
}

export interface OpenComputerForkCheckpointParams {
  checkpointId: string;
  name: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  timeoutSeconds?: number;
  secretStore?: string;
}

export interface OpenComputerCheckpointResponse {
  id: string;
  sandboxId: string;
  orgId?: string;
  name?: string;
  kind?: "full" | "disk_only";
  status?: string;
  createdAt?: string;
}

export type OpenComputerCheckpointRetentionPolicy = typeof OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY;

export interface OpenComputerCreateCheckpointOptions {
  kind?: typeof OPENCOMPUTER_CHECKPOINT_KIND;
  retentionPolicy?: OpenComputerCheckpointRetentionPolicy;
}

export interface OpenComputerDeleteSandboxOptions {
  deleteSecretStore?: boolean;
}

export interface OpenComputerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OpenComputerSecretStoreResponse {
  id: string;
  name: string;
  egressAllowlist?: string[];
}

export interface OpenComputerCreateSecretStoreParams {
  name: string;
  egressAllowlist?: string[];
}

export interface OpenComputerSetSecretParams {
  storeId: string;
  name: string;
  value: string;
  allowedHosts?: string[];
}

export interface OpenComputerTunnelResponse {
  url: string;
  hostname?: string;
}

export class OpenComputerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenComputerNotFoundError";
  }
}

export class OpenComputerApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "OpenComputerApiError";
  }
}

const DEFAULT_PATHS: OpenComputerApiPaths = {
  sandboxes: "/sandboxes",
  sandboxFromCheckpoint: "/sandboxes/from-checkpoint/:checkpointId",
  sandbox: "/sandboxes/:id",
  wake: "/sandboxes/:id/wake",
  hibernate: "/sandboxes/:id/hibernate",
  timeout: "/sandboxes/:id/timeout",
  tunnel: "/sandboxes/:id/preview",
  exec: "/sandboxes/:id/exec/run",
  checkpoints: "/sandboxes/:id/checkpoints",
  checkpoint: "/sandboxes/:id/checkpoints/:checkpointId",
  secretStores: "/secret-stores",
  secretStore: "/secret-stores/:id",
  secret: "/secret-stores/:id/secrets/:name",
};

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_WAKE_MS = 60_000;
const TIMEOUT_HIBERNATE_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_TUNNEL_MS = 15_000;
const TIMEOUT_EXEC_MS = 15_000;
const TIMEOUT_BUILD_EXEC_MS = 30 * 60_000;
const TIMEOUT_CHECKPOINT_MS = 5 * 60_000;
const TIMEOUT_SECRET_STORE_MS = 30_000;
const RUNTIME_ENTRYPOINT_EXEC_TIMEOUT_MS = 10_000;
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const OPENSANDBOX_PROXY_CA = "/usr/local/share/ca-certificates/opensandbox-proxy.crt";
const PYTHON_VENV = "/home/sandbox/.venv";
const USER_BIN = "/home/sandbox/.local/bin";
const RUNTIME_CA_EXPORTS =
  `SSL_CERT_FILE=${SYSTEM_CA_BUNDLE} ` +
  `CURL_CA_BUNDLE=${SYSTEM_CA_BUNDLE} ` +
  `REQUESTS_CA_BUNDLE=${SYSTEM_CA_BUNDLE} ` +
  `NODE_EXTRA_CA_CERTS=${OPENSANDBOX_PROXY_CA} ` +
  `NPM_CONFIG_CAFILE=${OPENSANDBOX_PROXY_CA} ` +
  `GIT_SSL_CAINFO=${OPENSANDBOX_PROXY_CA}`;
const LOCAL_NO_PROXY = "localhost,127.0.0.1,::1";
const RUNTIME_HOSTS_BOOTSTRAP =
  "grep -Eq '^[[:space:]]*127\\.0\\.0\\.1[[:space:]].*\\blocalhost\\b' /etc/hosts || " +
  "printf '%s\\n' '127.0.0.1 localhost' | sudo tee -a /etc/hosts >/dev/null; " +
  "grep -Eq '^[[:space:]]*::1[[:space:]].*\\blocalhost\\b' /etc/hosts || " +
  "printf '%s\\n' '::1 localhost ip6-localhost ip6-loopback' | sudo tee -a /etc/hosts >/dev/null";
// Runtime version the sandbox reports back to the image-build callback.
// OpenComputer launches the runtime via `exec`, which does NOT inherit the
// image's baked env, so SANDBOX_VERSION must be re-exported here — otherwise the
// runtime reports an empty version and the build-complete callback is rejected
// (runtime-version floor check). Keep in sync with the value baked in
// packages/opencomputer-infra/src/build-template.ts (SANDBOX_VERSION).
const OPENCOMPUTER_SANDBOX_VERSION = "v54-opencode-1-17-18";
const RUNTIME_ENV_EXPORTS =
  "export HOME=/home/sandbox " +
  `VIRTUAL_ENV=${PYTHON_VENV} ` +
  "XDG_CONFIG_HOME=/home/sandbox/.config " +
  "PYTHONPATH=/app " +
  "NODE_PATH=/home/sandbox/.npm-global/lib/node_modules:/usr/lib/node_modules " +
  `OPENINSPECT_BIN_INSTALL_DIR=${USER_BIN} ` +
  `NO_PROXY=${LOCAL_NO_PROXY} ` +
  `no_proxy=${LOCAL_NO_PROXY} ` +
  `PATH=${PYTHON_VENV}/bin:/home/sandbox/.npm-global/bin:${USER_BIN}:/home/sandbox/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin ` +
  `SANDBOX_VERSION=${OPENCOMPUTER_SANDBOX_VERSION} ` +
  RUNTIME_CA_EXPORTS;
const RUNTIME_CA_BOOTSTRAP =
  `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo update-ca-certificates >/tmp/openinspect-update-ca.log 2>&1 || true; ` +
  `[ -f ${OPENSANDBOX_PROXY_CA} ] && sudo git config --system http.sslCAInfo ${OPENSANDBOX_PROXY_CA} || true`;
const RUNTIME_LOG_PATH = "/var/log/openinspect-runtime.log";
const LEGACY_RUNTIME_LOG_PATH = "/tmp/openinspect-runtime.log";
const RUNTIME_LOG_BOOTSTRAP =
  `sudo touch ${RUNTIME_LOG_PATH}; ` +
  `sudo chown "$(id -u):$(id -g)" ${RUNTIME_LOG_PATH}; ` +
  `ln -sf ${RUNTIME_LOG_PATH} ${LEGACY_RUNTIME_LOG_PATH}`;

export class OpenComputerRestClient {
  private readonly baseUrl: string;
  private readonly paths: OpenComputerApiPaths;

  constructor(public readonly config: OpenComputerRestConfig) {
    if (!config.apiUrl) throw new Error("OpenComputerRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("OpenComputerRestClient requires apiKey");
    if (!config.template) throw new Error("OpenComputerRestClient requires template");

    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.paths = { ...DEFAULT_PATHS, ...(config.paths ?? {}) };
  }

  async createSandbox(
    params: OpenComputerCreateSandboxParams
  ): Promise<OpenComputerSandboxResponse> {
    const startMs = Date.now();
    const body: Record<string, unknown> = {
      templateID: "base",
      snapshot: params.template,
      envs: params.env,
      metadata: params.labels,
    };
    if (params.timeoutSeconds !== undefined) {
      body.timeout = params.timeoutSeconds;
    }
    if (params.secretStore) {
      body.secretStore = params.secretStore;
    }

    try {
      const response = await this.request<OpenComputerSandboxResponse>(
        "POST",
        this.paths.sandboxes,
        TIMEOUT_CREATE_MS,
        body
      );
      return this.normalizeSandbox(response);
    } finally {
      log.info("opencomputer.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_name: params.name,
      });
    }
  }

  async forkFromCheckpoint(
    params: OpenComputerForkCheckpointParams
  ): Promise<OpenComputerSandboxResponse> {
    const body: Record<string, unknown> = {
      envs: params.env,
      metadata: params.labels,
    };
    if (params.timeoutSeconds !== undefined) {
      body.timeout = params.timeoutSeconds;
    }
    if (params.secretStore) {
      body.secretStore = params.secretStore;
    }

    const response = await this.request<OpenComputerSandboxResponse>(
      "POST",
      this.expandPath(this.paths.sandboxFromCheckpoint, { checkpointId: params.checkpointId }),
      TIMEOUT_CREATE_MS,
      body
    );
    return this.normalizeSandbox(response);
  }

  async createSecretStore(
    params: OpenComputerCreateSecretStoreParams
  ): Promise<OpenComputerSecretStoreResponse> {
    return await this.request<OpenComputerSecretStoreResponse>(
      "POST",
      this.paths.secretStores,
      TIMEOUT_SECRET_STORE_MS,
      {
        name: params.name,
        egressAllowlist: params.egressAllowlist,
      }
    );
  }

  async setSecret(params: OpenComputerSetSecretParams): Promise<void> {
    await this.request<void>(
      "PUT",
      this.expandPath(this.paths.secret, {
        id: params.storeId,
        name: params.name,
      }),
      TIMEOUT_SECRET_STORE_MS,
      {
        value: params.value,
        allowedHosts: params.allowedHosts,
      }
    );
  }

  async deleteSecretStore(id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      this.expandPath(this.paths.secretStore, { id }),
      TIMEOUT_SECRET_STORE_MS
    );
  }

  async getSandbox(id: string): Promise<OpenComputerSandboxResponse> {
    const response = await this.request<OpenComputerSandboxResponse>(
      "GET",
      this.expandPath(this.paths.sandbox, { id }),
      TIMEOUT_GET_MS
    );
    return this.normalizeSandbox(response);
  }

  async wakeSandbox(id: string): Promise<OpenComputerSandboxResponse | void> {
    const response = await this.request<OpenComputerSandboxResponse | void>(
      "POST",
      this.expandPath(this.paths.wake, { id }),
      TIMEOUT_WAKE_MS
    );
    return response ? this.normalizeSandbox(response) : response;
  }

  async hibernateSandbox(id: string): Promise<void> {
    await this.request<void>(
      "POST",
      this.expandPath(this.paths.hibernate, { id }),
      TIMEOUT_HIBERNATE_MS
    );
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.request<void>("POST", this.expandPath(this.paths.timeout, { id }), TIMEOUT_GET_MS, {
      timeout: timeoutSeconds,
    });
  }

  async deleteSandbox(id: string, options?: OpenComputerDeleteSandboxOptions): Promise<void> {
    const params = new URLSearchParams();
    if (options?.deleteSecretStore) params.set("deleteSecretStore", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    await this.request<void>(
      "DELETE",
      `${this.expandPath(this.paths.sandbox, { id })}${query}`,
      TIMEOUT_GET_MS
    );
  }

  async startRuntime(id: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const exports = this.shellExportEnv(extraEnv);
    await this.request<void>("POST", this.expandPath(this.paths.exec, { id }), TIMEOUT_EXEC_MS, {
      cmd: "sh",
      args: [
        "-c",
        `${RUNTIME_HOSTS_BOOTSTRAP}; ${RUNTIME_CA_BOOTSTRAP}; ${RUNTIME_LOG_BOOTSTRAP}; ${RUNTIME_ENV_EXPORTS}; ${exports}nohup python3 -m sandbox_runtime.entrypoint >>${RUNTIME_LOG_PATH} 2>&1 & echo $!`,
      ],
      timeout: RUNTIME_ENTRYPOINT_EXEC_TIMEOUT_MS / 1000,
    });
  }

  async runRuntimeForeground(
    id: string,
    timeoutSeconds: number,
    extraEnv: Record<string, string> = {}
  ): Promise<OpenComputerExecResult> {
    const exports = this.shellExportEnv(extraEnv);
    return await this.request<OpenComputerExecResult>(
      "POST",
      this.expandPath(this.paths.exec, { id }),
      TIMEOUT_BUILD_EXEC_MS,
      {
        cmd: "sh",
        args: [
          "-c",
          `${RUNTIME_HOSTS_BOOTSTRAP}; ${RUNTIME_CA_BOOTSTRAP}; ${RUNTIME_LOG_BOOTSTRAP}; ${RUNTIME_ENV_EXPORTS}; ${exports} python3 -m sandbox_runtime.entrypoint >>${RUNTIME_LOG_PATH} 2>&1`,
        ],
        timeout: timeoutSeconds,
      }
    );
  }

  async createCheckpoint(
    id: string,
    name: string,
    options: OpenComputerCreateCheckpointOptions = {}
  ): Promise<OpenComputerCheckpointResponse> {
    return await this.request<OpenComputerCheckpointResponse>(
      "POST",
      this.expandPath(this.paths.checkpoints, { id }),
      TIMEOUT_CHECKPOINT_MS,
      {
        name,
        kind: options.kind ?? OPENCOMPUTER_CHECKPOINT_KIND,
        retentionPolicy: options.retentionPolicy ?? OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
      }
    );
  }

  async deleteCheckpoint(id: string, checkpointId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      this.expandPath(this.paths.checkpoint, { id, checkpointId }),
      TIMEOUT_CHECKPOINT_MS
    );
  }

  async getTunnelUrl(id: string, port: number): Promise<OpenComputerTunnelResponse> {
    const response = await this.request<OpenComputerTunnelResponse>(
      "POST",
      this.expandPath(this.paths.tunnel, { id, port: String(port) }),
      TIMEOUT_TUNNEL_MS,
      { port }
    );
    return {
      ...response,
      url: response.url ?? (response.hostname ? `https://${response.hostname}` : ""),
    };
  }

  private getHeaders(): Record<string, string> {
    const authHeaderName = this.config.authHeaderName ?? "X-API-Key";
    return {
      "Content-Type": "application/json",
      [authHeaderName]: `${this.config.authHeaderValuePrefix ?? ""}${this.config.apiKey}`,
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    timeoutMs: number,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: this.getHeaders(),
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);

      const response = await fetch(url, init);

      if (response.status === 404) {
        const text = await response.text();
        throw new OpenComputerNotFoundError(text || `Not found: ${path}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new OpenComputerApiError(text || response.statusText, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return undefined as T;
    } catch (error) {
      // The per-call timeout fires controller.abort(); the resulting AbortError
      // — from fetch OR a body read — must surface as an attributed timeout so
      // it is actionable in logs and build error_messages. The message must
      // contain "timeout" so SandboxProviderError classifies it transient
      // (isTransientNetworkError), not permanent — otherwise it trips the
      // circuit breaker. Our typed API errors (OpenComputer*Error) have
      // distinct names and rethrow unchanged.
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`OpenComputer request timeout after ${timeoutMs}ms (${method} ${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private expandPath(path: string, params: Record<string, string>): string {
    let expanded = path;
    for (const [key, value] of Object.entries(params)) {
      expanded = expanded.replace(`:${key}`, encodeURIComponent(value));
    }
    return expanded;
  }

  private shellExportEnv(env: Record<string, string>): string {
    const entries = Object.entries(env).filter(([, value]) => value.length > 0);
    if (entries.length === 0) return "";
    return `${entries.map(([key, value]) => `${key}=${this.shellQuote(value)}`).join(" ")} `;
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  private normalizeSandbox(response: OpenComputerSandboxResponse): OpenComputerSandboxResponse {
    const id = response.id || response.sandboxID;
    if (!id) return response;
    return { ...response, id };
  }
}

export function createOpenComputerRestClient(
  config: OpenComputerRestConfig
): OpenComputerRestClient {
  return new OpenComputerRestClient(config);
}
