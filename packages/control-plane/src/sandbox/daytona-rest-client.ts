/**
 * Direct REST client for the Daytona sandbox API.
 *
 * Replaces the Python shim service by calling Daytona's REST API with native
 * fetch() from Cloudflare Workers. Bearer token auth, per-operation timeouts.
 */

import { createLogger } from "../logger";
import { z } from "zod";

const log = createLogger("daytona-rest-client");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DaytonaRestConfig {
  /** Daytona REST API base URL (e.g. "https://app.daytona.io/api") */
  apiUrl: string;
  /** Bearer token for Daytona API auth */
  apiKey: string;
  /** Optional Daytona target name */
  target?: string;
  /** Snapshot name for fresh sandboxes */
  baseSnapshot: string;
  /** Minutes before Daytona auto-stops an idle sandbox (default 120) */
  autoStopIntervalMinutes: number;
  /** Minutes before Daytona auto-archives a stopped sandbox (default 10080) */
  autoArchiveIntervalMinutes: number;
}

// ---------------------------------------------------------------------------
// Per-operation timeouts (ms)
// ---------------------------------------------------------------------------

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_START_MS = 60_000;
const TIMEOUT_RECOVER_MS = 60_000;
const TIMEOUT_STOP_MS = 30_000;
const TIMEOUT_DELETE_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_PREVIEW_URL_MS = 15_000;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export const daytonaSandboxResponseSchema = z.object({
  id: z.string(),
  state: z.string(),
  recoverable: z.boolean().optional(),
});

export type DaytonaSandboxResponse = z.infer<typeof daytonaSandboxResponseSchema>;

export const daytonaSignedPreviewUrlResponseSchema = z.object({
  url: z.string(),
});

export type DaytonaSignedPreviewUrlResponse = z.infer<typeof daytonaSignedPreviewUrlResponseSchema>;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface DaytonaCreateSandboxParams {
  name: string;
  snapshot: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  public?: boolean;
  target?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when Daytona returns 404 — sandbox no longer exists. */
export class DaytonaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaNotFoundError";
  }
}

/** Thrown for non-404 Daytona API errors. Carries HTTP status for classification. */
export class DaytonaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DaytonaApiError";
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DaytonaRestClient {
  private readonly baseUrl: string;

  constructor(public readonly config: DaytonaRestConfig) {
    if (!config.apiUrl) {
      throw new Error("DaytonaRestClient requires apiUrl");
    }
    if (!config.apiKey) {
      throw new Error("DaytonaRestClient requires apiKey");
    }
    if (!config.baseSnapshot) {
      throw new Error("DaytonaRestClient requires baseSnapshot");
    }

    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async createSandbox(params: DaytonaCreateSandboxParams): Promise<DaytonaSandboxResponse> {
    const startMs = Date.now();
    try {
      return await this.requestJson(
        "POST",
        "/sandbox",
        TIMEOUT_CREATE_MS,
        daytonaSandboxResponseSchema,
        { body: params }
      );
    } finally {
      log.info("daytona.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_name: params.name,
      });
    }
  }

  async getSandbox(id: string): Promise<DaytonaSandboxResponse> {
    return this.requestJson("GET", `/sandbox/${id}`, TIMEOUT_GET_MS, daytonaSandboxResponseSchema);
  }

  async startSandbox(id: string): Promise<void> {
    await this.requestVoid("POST", `/sandbox/${id}/start`, TIMEOUT_START_MS);
  }

  async stopSandbox(id: string): Promise<void> {
    await this.requestVoid("POST", `/sandbox/${id}/stop`, TIMEOUT_STOP_MS);
  }

  async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("DELETE", `/sandbox/${id}`, TIMEOUT_DELETE_MS, { signal });
  }

  async recoverSandbox(id: string): Promise<void> {
    await this.requestVoid("POST", `/sandbox/${id}/recover`, TIMEOUT_RECOVER_MS);
  }

  async getSignedPreviewUrl(
    id: string,
    port: number,
    expirySeconds: number
  ): Promise<DaytonaSignedPreviewUrlResponse> {
    return this.requestJson(
      "GET",
      `/sandbox/${id}/ports/${port}/signed-preview-url?expires_in_seconds=${expirySeconds}`,
      TIMEOUT_PREVIEW_URL_MS,
      daytonaSignedPreviewUrlResponseSchema
    );
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  /**
   * Request whose success body is required: it must be JSON and must satisfy
   * `schema`, otherwise the call fails as an invalid response. The value type
   * comes from the schema, so validating the body is the only way to produce
   * one — a caller cannot opt out of it.
   */
  private requestJson<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    schema: z.ZodType<T>,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<T> {
    return this.send(method, path, timeoutMs, options, async (response) =>
      this.parseJson(schema, await response.text(), response.status)
    );
  }

  /**
   * Command whose success body carries nothing we act on. Daytona answers start,
   * stop, and recover with an empty 200/204 or with a status blob; both are
   * discarded, so neither shape can fail the call.
   */
  private requestVoid(
    method: "DELETE" | "GET" | "POST",
    path: string,
    timeoutMs: number,
    options?: { body?: unknown; signal?: AbortSignal }
  ): Promise<void> {
    return this.send<void>(method, path, timeoutMs, options, () => {});
  }

  /**
   * Validate a required body. Daytona does not always label JSON responses with
   * `application/json`, so the text is parsed regardless of content type; a
   * missing, non-JSON, or non-conforming body is a protocol violation and is
   * reported as one instead of reaching the caller.
   */
  private parseJson<T>(schema: z.ZodType<T>, text: string, status: number): T {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DaytonaApiError("Invalid Daytona API response", status);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new DaytonaApiError("Invalid Daytona API response", status);
    }
    return parsed.data;
  }

  /**
   * Issue the request under `timeoutMs` and hand a successful response to
   * `consume`. The timeout stays armed while `consume` reads the body.
   */
  private async send<T>(
    method: "DELETE" | "GET" | "POST",
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
      if (options?.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }

      const response = await fetch(url, init);

      if (response.status === 404) {
        const text = await response.text();
        throw new DaytonaNotFoundError(text || `Not found: ${path}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new DaytonaApiError(text || response.statusText, response.status);
      }

      return await consume(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaRestClient(config: DaytonaRestConfig): DaytonaRestClient {
  return new DaytonaRestClient(config);
}
