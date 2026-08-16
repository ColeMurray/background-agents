/**
 * Direct REST client for the E2B sandbox API.
 *
 * Wire-level details verified against the E2B API reference:
 * https://e2b.dev/docs/api-reference
 */

import { createLogger } from "../logger";
import { z } from "zod";

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
const TIMEOUT_SETTTL_MS = 15_000;
const TIMEOUT_WRITE_FILE_MS = 30_000;

const e2bSandboxDetailSchema = z.object({
  sandboxID: z.string(),
  templateID: z.string(),
  state: z.string(),
  startedAt: z.string().optional(),
  endAt: z.string().optional(),
  domain: z.string().nullable().optional(),
});

export type E2BSandboxDetail = z.infer<typeof e2bSandboxDetailSchema>;

const e2bSandboxCreatedSchema = z.object({
  sandboxID: z.string(),
  templateID: z.string(),
  domain: z.string().nullable().optional(),
  envdAccessToken: z.string().nullable().optional(),
});

export type E2BSandboxCreated = z.infer<typeof e2bSandboxCreatedSchema>;

/**
 * E2B's `Error` schema types `code` as an integer, not a string slug. Typing it
 * as a string here rejects every real structured error and silently downgrades
 * the body to raw text.
 */
const e2bErrorBodySchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
});

export type E2BErrorBody = z.infer<typeof e2bErrorBodySchema>;

/** Default port envd listens on inside every sandbox. */
const ENVD_PORT = 49983;
/** Default sandbox host suffix (overridden by the create response `domain`). */
const DEFAULT_SANDBOX_DOMAIN = "e2b.app";
/**
 * Path the per-session env file is written to. The template launcher
 * (packages/e2b-infra/oi-launch.py) polls this exact path — keep them in sync.
 */
const SESSION_ENV_PATH = "/tmp/oi-session.env";

export interface E2BCreateSandboxParams {
  templateID: string;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutSeconds?: number;
  /** Pause (not kill) the sandbox when its timeout expires. */
  autoPause?: boolean;
  /** Wake a paused sandbox on inbound activity (only meaningful with autoPause). */
  autoResume?: boolean;
  /**
   * Require an access token to reach envd (returned as `envdAccessToken`). Without it,
   * envd accepts unauthenticated reads/writes of the uploaded session env.
   */
  secure?: boolean;
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
    public readonly body?: E2BErrorBody | string
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
      return await this.requestJson(
        "POST",
        "/sandboxes",
        TIMEOUT_CREATE_MS,
        e2bSandboxCreatedSchema,
        {
          body: {
            templateID: params.templateID,
            envVars: params.envVars,
            metadata: params.metadata,
            timeout: params.timeoutSeconds,
            secure: params.secure ?? false,
            autoPause: params.autoPause ?? false,
            autoResume: { enabled: params.autoResume ?? false },
          },
        }
      );
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
    opts: { domain?: string | null; envdAccessToken: string }
  ): Promise<void> {
    const domain = opts.domain || DEFAULT_SANDBOX_DOMAIN;
    // envd requires the in-sandbox user to write the file as. "user" is E2B's
    // fixed non-root runtime user — the launcher that reads this file runs as it.
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
      // envd requires the access token from create (secure:true); never write anonymously.
      const headers: Record<string, string> = { "X-Access-Token": opts.envdAccessToken };

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
    } catch (error) {
      // Surface a write timeout as a transient error (see request()).
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`E2B writeSessionEnv timeout after ${TIMEOUT_WRITE_FILE_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      log.info("e2b.write_session_env", {
        duration_ms: Date.now() - startMs,
        var_count: Object.keys(env).length,
      });
    }
  }

  async getSandbox(id: string): Promise<E2BSandboxDetail> {
    return this.requestJson("GET", `/sandboxes/${id}`, TIMEOUT_GET_MS, e2bSandboxDetailSchema);
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.requestVoid("POST", `/sandboxes/${id}/pause`, TIMEOUT_PAUSE_MS);
  }

  /**
   * Resume a paused sandbox (or extend a running one).
   *
   * Connect answers with the create-style `Sandbox` shape — `sandboxID`/`templateID`,
   * no `state`, which only `GET /sandboxes/{id}` returns. Callers re-read state
   * through getSandbox when they need it, so this is a command: the success body
   * carries nothing we act on and is discarded.
   */
  async connectSandbox(id: string, timeoutSeconds: number): Promise<void> {
    await this.requestVoid("POST", `/sandboxes/${id}/connect`, TIMEOUT_CONNECT_MS, {
      body: { timeout: timeoutSeconds },
    });
  }

  async killSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("DELETE", `/sandboxes/${id}`, TIMEOUT_KILL_MS, { signal });
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.requestVoid("POST", `/sandboxes/${id}/timeout`, TIMEOUT_SETTTL_MS, {
      body: { timeout: timeoutSeconds },
    });
  }

  getHostnameForPort(sandboxId: string, port: number, domain?: string | null): string {
    return `https://${port}-${sandboxId}.${domain || DEFAULT_SANDBOX_DOMAIN}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.config.apiKey,
    };
  }

  /**
   * Request whose success body is required: it must be JSON and must satisfy
   * `schema`, otherwise the call fails as an invalid response.
   */
  private requestJson<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    schema: z.ZodType<T>,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<T> {
    return this.send(method, path, timeoutMs, options, async (response) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new E2BApiError("Invalid E2B API response", response.status, "invalid_response");
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        throw new E2BApiError("Invalid E2B API response", response.status, "invalid_response");
      }
      return parsed.data;
    });
  }

  /**
   * Command whose success body carries nothing we act on. E2B answers some of
   * these with 204 and others with JSON; both are discarded, so neither shape
   * can fail the call.
   */
  private requestVoid(
    method: "GET" | "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<void> {
    return this.send<void>(method, path, timeoutMs, options, () => {});
  }

  /**
   * Issue the request under `timeoutMs` and hand a successful response to
   * `consume`. The timeout stays armed while `consume` reads the body so an
   * abort raised there is translated like any other (see the catch below).
   */
  private async send<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    timeoutMs: number,
    options: { body?: unknown; signal?: AbortSignal } | undefined,
    consume: (response: Response) => T | Promise<T>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: this.getHeaders(),
        signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      };
      if (options?.body !== undefined) init.body = JSON.stringify(options.body);

      const response = await fetch(url, init);

      if (response.status === 404) {
        throw new E2BNotFoundError((await response.text()) || `Not found: ${path}`);
      }
      if (response.status === 409) {
        throw new E2BConflictError((await response.text()) || `Conflict: ${path}`);
      }
      if (!response.ok) {
        const text = await response.text();
        let parsedBody: E2BErrorBody | string = text;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json") && text) {
          try {
            const parsed = e2bErrorBodySchema.safeParse(JSON.parse(text));
            parsedBody = parsed.success ? parsed.data : text;
          } catch {
            parsedBody = text;
          }
        }
        throw new E2BApiError(text || response.statusText, response.status, parsedBody);
      }

      return await consume(response);
    } catch (error) {
      // A timeout fires controller.abort(); the resulting AbortError — from
      // fetch OR a body read — must surface as a transient timeout so it isn't
      // classified permanent and trip the circuit breaker. Our typed API errors
      // (E2B*Error) have distinct names and rethrow unchanged.
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`E2B request timeout after ${timeoutMs}ms (${method} ${path})`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createE2BRestClient(config: E2BRestConfig): E2BRestClient {
  return new E2BRestClient(config);
}
