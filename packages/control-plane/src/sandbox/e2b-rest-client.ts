/**
 * Direct REST client for the E2B sandbox API.
 *
 * Wire-level details verified against the E2B API reference:
 * https://e2b.dev/docs/api-reference
 */

import { createLogger } from "../logger";

const log = createLogger("e2b-rest-client");

export interface E2BRestConfig {
  apiUrl: string;
  apiKey: string;
  templateId: string;
}

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_CONNECT_MS = 60_000;
const TIMEOUT_PAUSE_MS = 30_000;
const TIMEOUT_KILL_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_REFRESH_MS = 15_000;
const TIMEOUT_SETTTL_MS = 15_000;
const TIMEOUT_WRITE_FILE_MS = 30_000;
const TIMEOUT_TEMPLATE_MS = 30_000;

export interface E2BSandboxDetail {
  sandboxID: string;
  templateID: string;
  state: "running" | "paused" | "killed" | string;
  startedAt?: string;
  endAt?: string;
  /** Custom sandbox domain for dedicated clusters; null/absent on the default cloud. */
  domain?: string | null;
}

export interface E2BSandboxCreated {
  sandboxID: string;
  templateID: string;
  /** Custom envd domain for dedicated clusters; null/absent on the default cloud. */
  domain?: string | null;
  /** Token required to reach envd on secure sandboxes; null/absent on Hobby. */
  envdAccessToken?: string | null;
}

/** Default port envd listens on inside every sandbox. */
const ENVD_PORT = 49983;
/** Default sandbox host suffix (overridden by the create response `domain`). */
const DEFAULT_SANDBOX_DOMAIN = "e2b.app";
/**
 * Path the per-session env file is written to. The template launcher
 * (packages/e2b-infra/oi-launch.py) polls this exact path — keep them in sync.
 */
export const SESSION_ENV_PATH = "/tmp/oi-session.env";

export interface E2BCreateSandboxParams {
  templateID: string;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeout?: number;
  autoPause?: boolean;
}

// ---------------------------------------------------------------------------
// Template builds (repo-image prebuilds)
//
// Per-repo prebuilt environments are E2B *templates* built on top of the base
// template (`fromTemplate`), per E2B's guidance: template creates are much
// faster than snapshot-forks and ~10x smaller on disk. The whole build flow is
// REST-drivable with the runtime API key (verified live against /v3/templates
// and /v2/templates/{id}/builds/{id} on 2026-06-04).
// ---------------------------------------------------------------------------

export interface E2BTemplateCreated {
  templateID: string;
  buildID: string;
  /** Full names including team namespace (e.g. "team/oi-repo-acme-web:default"). */
  names: string[];
}

/** One Dockerfile-style instruction executed by the remote template builder. */
export interface E2BTemplateStep {
  /** Instruction type, e.g. "RUN", "ENV", "WORKDIR". */
  type: string;
  args: string[];
  /** Re-run this step even when the builder has it cached. */
  force?: boolean;
}

export interface E2BStartTemplateBuildParams {
  /** Existing template to layer on top of (base layer is cache-shared). */
  fromTemplate: string;
  steps: E2BTemplateStep[];
  /**
   * Start command, run once at build and memory-snapshotted — must be
   * re-declared per build (not inherited from `fromTemplate`).
   */
  startCmd: string;
  /** Health check the builder waits on before snapshotting the start command. */
  readyCmd: string;
}

export type E2BTemplateBuildStatus = "building" | "ready" | "error" | "waiting" | string;

export interface E2BTemplateBuildInfo {
  templateID: string;
  buildID: string;
  status: E2BTemplateBuildStatus;
  /** Builder log lines; RUN step args are echoed verbatim (avoid logging them on). */
  logEntries?: Array<{ level?: string; message?: string }>;
  reason?: string;
}

export class E2BNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BNotFoundError";
  }
}

export class E2BConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2BConflictError";
  }
}

export class E2BApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: { code?: string; message?: string } | string
  ) {
    super(message);
    this.name = "E2BApiError";
  }
}

export class E2BRestClient {
  private readonly baseUrl: string;

  constructor(public readonly config: E2BRestConfig) {
    if (!config.apiUrl) throw new Error("E2BRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("E2BRestClient requires apiKey");
    if (!config.templateId) throw new Error("E2BRestClient requires templateId");
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
  }

  async createSandbox(params: E2BCreateSandboxParams): Promise<E2BSandboxCreated> {
    const startMs = Date.now();
    try {
      return await this.request<E2BSandboxCreated>("POST", "/sandboxes", TIMEOUT_CREATE_MS, {
        templateID: params.templateID,
        envVars: params.envVars,
        metadata: params.metadata,
        timeout: params.timeout,
        autoPause: params.autoPause ?? false,
      });
    } finally {
      log.info("e2b.create_sandbox", {
        duration_ms: Date.now() - startMs,
        template_id: params.templateID,
      });
    }
  }

  /**
   * Write the per-session env file into a sandbox via envd's filesystem API.
   *
   * E2B's template start command runs at build (not per create) and can't see
   * create-time env vars, so the supervisor is launched by oi-launch.py, which
   * reads this file. Writing it (rather than passing env to POST /sandboxes) is
   * what delivers per-session config to the supervisor. The launcher polls
   * SESSION_ENV_PATH, so this must target the same path.
   */
  async writeSessionEnv(
    sandboxId: string,
    env: Record<string, string>,
    opts?: { domain?: string | null; envdAccessToken?: string | null }
  ): Promise<void> {
    const domain = opts?.domain || DEFAULT_SANDBOX_DOMAIN;
    const url =
      `https://${ENVD_PORT}-${sandboxId}.${domain}/files` +
      `?path=${encodeURIComponent(SESSION_ENV_PATH)}&username=user`;

    const form = new FormData();
    form.append(
      "file",
      new Blob([JSON.stringify(env)], { type: "application/json" }),
      SESSION_ENV_PATH
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_WRITE_FILE_MS);
    const startMs = Date.now();
    try {
      // Do NOT set Content-Type — fetch derives the multipart boundary itself.
      const headers: Record<string, string> = {};
      if (opts?.envdAccessToken) headers["X-Access-Token"] = opts.envdAccessToken;

      const response = await fetch(url, {
        method: "POST",
        body: form,
        headers,
        signal: controller.signal,
      });
      if (response.status === 404) {
        throw new E2BNotFoundError(`Sandbox ${sandboxId} envd not reachable`);
      }
      if (!response.ok) {
        const text = await response.text();
        throw new E2BApiError(
          text || `Failed to write session env (${response.status})`,
          response.status,
          text
        );
      }
    } finally {
      clearTimeout(timeoutId);
      log.info("e2b.write_session_env", {
        duration_ms: Date.now() - startMs,
        var_count: Object.keys(env).length,
      });
    }
  }

  async getSandbox(id: string): Promise<E2BSandboxDetail> {
    return this.request<E2BSandboxDetail>("GET", `/sandboxes/${id}`, TIMEOUT_GET_MS);
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.request<void>("POST", `/sandboxes/${id}/pause`, TIMEOUT_PAUSE_MS);
  }

  async connectSandbox(id: string, timeoutSeconds: number): Promise<E2BSandboxDetail> {
    return this.request<E2BSandboxDetail>("POST", `/sandboxes/${id}/connect`, TIMEOUT_CONNECT_MS, {
      timeout: timeoutSeconds,
    });
  }

  async killSandbox(id: string): Promise<void> {
    await this.request<void>("DELETE", `/sandboxes/${id}`, TIMEOUT_KILL_MS);
  }

  async setTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.request<void>("POST", `/sandboxes/${id}/timeout`, TIMEOUT_SETTTL_MS, {
      timeout: timeoutSeconds,
    });
  }

  async refreshKeepalive(id: string, durationSeconds: number): Promise<void> {
    await this.request<void>("POST", `/sandboxes/${id}/refreshes`, TIMEOUT_REFRESH_MS, {
      duration: durationSeconds,
    });
  }

  getHostnameForPort(sandboxId: string, port: number, domain?: string | null): string {
    return `https://${port}-${sandboxId}.${domain || DEFAULT_SANDBOX_DOMAIN}`;
  }

  /**
   * Register a template (or get a new buildID for an existing one — POSTing an
   * existing `name` re-targets that template, which is what makes repo-image
   * replacement atomic: sessions keep resolving the name while a new build runs).
   */
  async createTemplate(
    name: string,
    opts?: { cpuCount?: number; memoryMB?: number }
  ): Promise<E2BTemplateCreated> {
    return this.request<E2BTemplateCreated>("POST", "/v3/templates", TIMEOUT_TEMPLATE_MS, {
      name,
      cpuCount: opts?.cpuCount,
      memoryMB: opts?.memoryMB,
    });
  }

  /**
   * Start a template build. The build runs on E2B's remote builder — nothing of
   * ours executes in a sandbox, so no control-plane secrets enter the data plane.
   * NOTE: RUN step args appear verbatim in build logs; any clone token in a step
   * must be short-lived (GitHub App installation tokens expire in 1h).
   */
  async startTemplateBuild(
    templateID: string,
    buildID: string,
    params: E2BStartTemplateBuildParams
  ): Promise<void> {
    await this.request<void>(
      "POST",
      `/v2/templates/${templateID}/builds/${buildID}`,
      TIMEOUT_TEMPLATE_MS,
      {
        fromTemplate: params.fromTemplate,
        steps: params.steps,
        startCmd: params.startCmd,
        readyCmd: params.readyCmd,
      }
    );
  }

  async getTemplateBuildStatus(templateID: string, buildID: string): Promise<E2BTemplateBuildInfo> {
    return this.request<E2BTemplateBuildInfo>(
      "GET",
      `/templates/${templateID}/builds/${buildID}/status`,
      TIMEOUT_TEMPLATE_MS
    );
  }

  /** Delete a template by name (without the team namespace) or raw template ID. */
  async deleteTemplate(nameOrId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/templates/${encodeURIComponent(nameOrId)}`,
      TIMEOUT_TEMPLATE_MS
    );
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
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

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        // A timeout fires controller.abort(), which rejects the fetch with an
        // AbortError. Surface it as a transient timeout so it doesn't count
        // toward the sandbox circuit breaker as a permanent failure.
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`E2B request timeout after ${timeoutMs}ms (${method} ${path})`);
        }
        throw error;
      }

      if (response.status === 404) {
        throw new E2BNotFoundError((await response.text()) || `Not found: ${path}`);
      }
      if (response.status === 409) {
        throw new E2BConflictError((await response.text()) || `Conflict: ${path}`);
      }
      if (!response.ok) {
        const text = await response.text();
        let parsedBody: { code?: string; message?: string } | string | undefined = text;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json") && text) {
          try {
            parsedBody = JSON.parse(text) as { code?: string; message?: string };
          } catch {
            parsedBody = text;
          }
        }
        throw new E2BApiError(text || response.statusText, response.status, parsedBody);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }
      return undefined as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createE2BRestClient(config: E2BRestConfig): E2BRestClient {
  return new E2BRestClient(config);
}
