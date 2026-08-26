/**
 * Direct REST client for OpenComputer sandboxes.
 *
 * The path names are intentionally configurable because OpenComputer deployments
 * may expose versioned or compatibility routes. Defaults are the canonical MVP
 * shape expected by OpenInspect.
 */

import { createLogger } from "../logger";
import { z } from "zod";
import { SANDBOX_RUNTIME_VERSION } from "./runtime-manifest";

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
  template?: string;
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

export const openComputerSandboxApiResponseSchema = z
  .object({
    id: z.string().optional(),
    sandboxID: z.string().optional(),
    state: z.string().optional(),
    status: z.string().optional(),
    sandboxDomain: z.string().optional(),
    routes: z.array(z.object({ port: z.number(), url: z.string() })).optional(),
    tunnelUrls: z.record(z.string(), z.string()).optional(),
  })
  .refine((response) => response.id !== undefined || response.sandboxID !== undefined, {
    message: "Expected id or sandboxID",
  });

type OpenComputerSandboxApiResponse = z.infer<typeof openComputerSandboxApiResponseSchema>;

export type OpenComputerSandboxResponse = OpenComputerSandboxApiResponse & { id: string };

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

export const openComputerCheckpointResponseSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  orgId: z.string().optional(),
  name: z.string().optional(),
  kind: z.enum(["full", "disk_only"]).optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
});

export type OpenComputerCheckpointResponse = z.infer<typeof openComputerCheckpointResponseSchema>;

export type OpenComputerCheckpointRetentionPolicy = typeof OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY;

export interface OpenComputerCreateCheckpointOptions {
  kind?: typeof OPENCOMPUTER_CHECKPOINT_KIND;
  retentionPolicy?: OpenComputerCheckpointRetentionPolicy;
}

export interface OpenComputerDeleteSandboxOptions {
  deleteSecretStore?: boolean;
}

export const openComputerExecResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

export type OpenComputerExecResult = z.infer<typeof openComputerExecResultSchema>;

export const openComputerSecretStoreResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  egressAllowlist: z.array(z.string()).optional(),
});

export type OpenComputerSecretStoreResponse = z.infer<typeof openComputerSecretStoreResponseSchema>;

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

/**
 * A tunnel response has to carry a reachable address: OpenComputer answers
 * either with a full `url` or with a bare `hostname` that becomes an https URL.
 * A response with neither (`{}`, or empty strings) is not a tunnel — turning it
 * into `url: ""` would hand code-server, VNC, and custom tunnel access a blank
 * address as if validation had passed. The invariant therefore lives in the
 * schema, and the normalized `url` is its output.
 */
const openComputerTunnelApiResponseSchema = z
  .object({
    url: z.string().optional(),
    hostname: z.string().optional(),
  })
  .transform((response, ctx) => {
    const hostname = response.hostname?.trim();
    const url = response.url?.trim() || (hostname ? `https://${hostname}` : "");
    if (!url) {
      ctx.addIssue("Expected a non-empty url or hostname");
      return z.NEVER;
    }
    return { ...response, url };
  });

export type OpenComputerTunnelResponse = z.infer<typeof openComputerTunnelApiResponseSchema>;

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
// (runtime-version floor check).
export const OPENCOMPUTER_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;
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

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface RequestOptions {
  body?: unknown;
  /** Caller-owned cancellation, combined with the per-call timeout. */
  signal?: AbortSignal;
}

export class OpenComputerRestClient {
  private readonly baseUrl: string;
  private readonly paths: OpenComputerApiPaths;

  constructor(public readonly config: OpenComputerRestConfig) {
    if (!config.apiUrl) throw new Error("OpenComputerRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("OpenComputerRestClient requires apiKey");
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
      const response = await this.requestJson(
        "POST",
        this.paths.sandboxes,
        TIMEOUT_CREATE_MS,
        openComputerSandboxApiResponseSchema,
        { body }
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

    const response = await this.requestJson(
      "POST",
      this.expandPath(this.paths.sandboxFromCheckpoint, { checkpointId: params.checkpointId }),
      TIMEOUT_CREATE_MS,
      openComputerSandboxApiResponseSchema,
      { body }
    );
    return this.normalizeSandbox(response);
  }

  async createSecretStore(
    params: OpenComputerCreateSecretStoreParams
  ): Promise<OpenComputerSecretStoreResponse> {
    return await this.requestJson(
      "POST",
      this.paths.secretStores,
      TIMEOUT_SECRET_STORE_MS,
      openComputerSecretStoreResponseSchema,
      { body: { name: params.name, egressAllowlist: params.egressAllowlist } }
    );
  }

  async setSecret(params: OpenComputerSetSecretParams): Promise<void> {
    await this.requestVoid(
      "PUT",
      this.expandPath(this.paths.secret, {
        id: params.storeId,
        name: params.name,
      }),
      TIMEOUT_SECRET_STORE_MS,
      { body: { value: params.value, allowedHosts: params.allowedHosts } }
    );
  }

  async deleteSecretStore(id: string): Promise<void> {
    await this.requestVoid(
      "DELETE",
      this.expandPath(this.paths.secretStore, { id }),
      TIMEOUT_SECRET_STORE_MS
    );
  }

  async getSandbox(id: string): Promise<OpenComputerSandboxResponse> {
    const response = await this.requestJson(
      "GET",
      this.expandPath(this.paths.sandbox, { id }),
      TIMEOUT_GET_MS,
      openComputerSandboxApiResponseSchema
    );
    return this.normalizeSandbox(response);
  }

  /**
   * Wake a hibernated sandbox. OpenComputer answers either with the woken
   * sandbox or with an empty success, so an absent body is a legitimate result
   * and the caller re-reads state it already holds. A body that is present must
   * still describe a sandbox.
   */
  async wakeSandbox(id: string): Promise<OpenComputerSandboxResponse | undefined> {
    const response = await this.requestOptionalJson(
      "POST",
      this.expandPath(this.paths.wake, { id }),
      TIMEOUT_WAKE_MS,
      openComputerSandboxApiResponseSchema
    );
    return response ? this.normalizeSandbox(response) : undefined;
  }

  async hibernateSandbox(id: string): Promise<void> {
    await this.requestVoid(
      "POST",
      this.expandPath(this.paths.hibernate, { id }),
      TIMEOUT_HIBERNATE_MS
    );
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.requestVoid("POST", this.expandPath(this.paths.timeout, { id }), TIMEOUT_GET_MS, {
      body: { timeout: timeoutSeconds },
    });
  }

  async deleteSandbox(
    id: string,
    options?: OpenComputerDeleteSandboxOptions,
    signal?: AbortSignal
  ): Promise<void> {
    const params = new URLSearchParams();
    if (options?.deleteSecretStore) params.set("deleteSecretStore", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    await this.requestVoid(
      "DELETE",
      `${this.expandPath(this.paths.sandbox, { id })}${query}`,
      TIMEOUT_GET_MS,
      { signal }
    );
  }

  async startRuntime(id: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const exports = this.shellExportEnv(extraEnv);
    await this.requestVoid("POST", this.expandPath(this.paths.exec, { id }), TIMEOUT_EXEC_MS, {
      body: {
        cmd: "sh",
        args: [
          "-c",
          `${RUNTIME_HOSTS_BOOTSTRAP}; ${RUNTIME_CA_BOOTSTRAP}; ${RUNTIME_LOG_BOOTSTRAP}; ${RUNTIME_ENV_EXPORTS}; ${exports}nohup python3 -m sandbox_runtime.entrypoint >>${RUNTIME_LOG_PATH} 2>&1 & echo $!`,
        ],
        timeout: RUNTIME_ENTRYPOINT_EXEC_TIMEOUT_MS / 1000,
      },
    });
  }

  async runRuntimeForeground(
    id: string,
    timeoutSeconds: number,
    extraEnv: Record<string, string> = {}
  ): Promise<OpenComputerExecResult> {
    const exports = this.shellExportEnv(extraEnv);
    return await this.requestJson(
      "POST",
      this.expandPath(this.paths.exec, { id }),
      TIMEOUT_BUILD_EXEC_MS,
      openComputerExecResultSchema,
      {
        body: {
          cmd: "sh",
          args: [
            "-c",
            `${RUNTIME_HOSTS_BOOTSTRAP}; ${RUNTIME_CA_BOOTSTRAP}; ${RUNTIME_LOG_BOOTSTRAP}; ${RUNTIME_ENV_EXPORTS}; ${exports} python3 -m sandbox_runtime.entrypoint >>${RUNTIME_LOG_PATH} 2>&1`,
          ],
          timeout: timeoutSeconds,
        },
      }
    );
  }

  async createCheckpoint(
    id: string,
    name: string,
    options: OpenComputerCreateCheckpointOptions = {},
    signal?: AbortSignal
  ): Promise<OpenComputerCheckpointResponse> {
    return await this.requestJson(
      "POST",
      this.expandPath(this.paths.checkpoints, { id }),
      TIMEOUT_CHECKPOINT_MS,
      openComputerCheckpointResponseSchema,
      {
        body: {
          name,
          kind: options.kind ?? OPENCOMPUTER_CHECKPOINT_KIND,
          retentionPolicy: options.retentionPolicy ?? OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
        },
        signal,
      }
    );
  }

  async deleteCheckpoint(id: string, checkpointId: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid(
      "DELETE",
      this.expandPath(this.paths.checkpoint, { id, checkpointId }),
      TIMEOUT_CHECKPOINT_MS,
      { signal }
    );
  }

  async getTunnelUrl(id: string, port: number): Promise<OpenComputerTunnelResponse> {
    return await this.requestJson(
      "POST",
      this.expandPath(this.paths.tunnel, { id, port: String(port) }),
      TIMEOUT_TUNNEL_MS,
      openComputerTunnelApiResponseSchema,
      { body: { port } }
    );
  }

  private getHeaders(): Record<string, string> {
    const authHeaderName = this.config.authHeaderName ?? "X-API-Key";
    return {
      "Content-Type": "application/json",
      [authHeaderName]: `${this.config.authHeaderValuePrefix ?? ""}${this.config.apiKey}`,
    };
  }

  /**
   * Request whose success body is required: it must be JSON and must satisfy
   * `schema`, otherwise the call fails as an invalid response. The value type
   * comes from the schema, so validating the body is the only way to produce
   * one — a caller cannot opt out of it.
   */
  private requestJson<T>(
    method: HttpMethod,
    path: string,
    timeoutMs: number,
    schema: z.ZodType<T>,
    options?: RequestOptions
  ): Promise<T> {
    return this.send(method, path, timeoutMs, options, async (response) =>
      this.parseJson(schema, await response.text(), response.status)
    );
  }

  /**
   * Request whose success body is optional. Only `wake` is like this: it answers
   * either with the woken sandbox or with an empty success. An empty body yields
   * `undefined`; anything else still has to satisfy `schema`, so a malformed
   * sandbox fails the call instead of masquerading as the empty case.
   */
  private requestOptionalJson<T>(
    method: HttpMethod,
    path: string,
    timeoutMs: number,
    schema: z.ZodType<T>,
    options?: RequestOptions
  ): Promise<T | undefined> {
    return this.send(method, path, timeoutMs, options, async (response) => {
      const text = await response.text();
      if (text.trim() === "") return undefined;
      return this.parseJson(schema, text, response.status);
    });
  }

  /**
   * Command whose success body carries nothing we act on. OpenComputer answers
   * some of these with 204 and others with a status blob; both are discarded, so
   * neither shape can fail the call.
   */
  private requestVoid(
    method: HttpMethod,
    path: string,
    timeoutMs: number,
    options?: RequestOptions
  ): Promise<void> {
    return this.send<void>(method, path, timeoutMs, options, () => {});
  }

  /**
   * Validate a required body. OpenComputer does not always label JSON responses
   * with `application/json`, so the text is parsed regardless of content type; a
   * missing, non-JSON, or non-conforming body is a protocol violation and is
   * reported as one instead of reaching the caller.
   */
  private parseJson<T>(schema: z.ZodType<T>, text: string, status: number): T {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new OpenComputerApiError("Invalid OpenComputer API response", status);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new OpenComputerApiError("Invalid OpenComputer API response", status);
    }
    return parsed.data;
  }

  /**
   * Issue the request under `timeoutMs` and hand a successful response to
   * `consume`. The timeout stays armed while `consume` reads the body so an
   * abort raised there is translated like any other (see the catch below).
   */
  private async send<T>(
    method: HttpMethod,
    path: string,
    timeoutMs: number,
    options: RequestOptions | undefined,
    consume: (response: Response) => T | Promise<T>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const externalSignal = options?.signal;
      const init: RequestInit = {
        method,
        headers: this.getHeaders(),
        signal: externalSignal
          ? AbortSignal.any([controller.signal, externalSignal])
          : controller.signal,
      };
      if (options?.body !== undefined) init.body = JSON.stringify(options.body);

      const response = await fetch(url, init);

      if (response.status === 404) {
        const text = await response.text();
        throw new OpenComputerNotFoundError(text || `Not found: ${path}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new OpenComputerApiError(text || response.statusText, response.status);
      }

      return await consume(response);
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

  private normalizeSandbox(response: OpenComputerSandboxApiResponse): OpenComputerSandboxResponse {
    const id = response.id || response.sandboxID;
    if (!id) {
      throw new OpenComputerApiError("Invalid OpenComputer API response", 200);
    }
    return { ...response, id };
  }
}

export function createOpenComputerRestClient(
  config: OpenComputerRestConfig
): OpenComputerRestClient {
  return new OpenComputerRestClient(config);
}
