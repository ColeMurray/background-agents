/**
 * Direct REST client for the Daytona sandbox API.
 *
 * Replaces the Python shim service by calling Daytona's REST API with native
 * fetch() from Cloudflare Workers. Bearer token auth, per-operation timeouts.
 */

import { createLogger } from "../logger";

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
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_PREVIEW_URL_MS = 15_000;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface DaytonaSandboxResponse {
  id: string;
  state: string;
  recoverable?: boolean;
}

export interface DaytonaSignedPreviewUrlResponse {
  url: string;
}

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
      return await this.request<DaytonaSandboxResponse>(
        "POST",
        "/sandbox",
        TIMEOUT_CREATE_MS,
        params
      );
    } finally {
      log.info("daytona.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_name: params.name,
      });
    }
  }

  async getSandbox(id: string): Promise<DaytonaSandboxResponse> {
    return this.request<DaytonaSandboxResponse>("GET", `/sandbox/${id}`, TIMEOUT_GET_MS);
  }

  async startSandbox(id: string): Promise<void> {
    await this.request<void>("POST", `/sandbox/${id}/start`, TIMEOUT_START_MS);
  }

  async stopSandbox(id: string): Promise<void> {
    await this.request<void>("POST", `/sandbox/${id}/stop`, TIMEOUT_STOP_MS);
  }

  async recoverSandbox(id: string): Promise<void> {
    await this.request<void>("POST", `/sandbox/${id}/recover`, TIMEOUT_RECOVER_MS);
  }

  async getSignedPreviewUrl(
    id: string,
    port: number,
    expirySeconds: number
  ): Promise<DaytonaSignedPreviewUrlResponse> {
    return this.request<DaytonaSignedPreviewUrlResponse>(
      "GET",
      `/sandbox/${id}/ports/${port}/signed-preview-url?expires_in_seconds=${expirySeconds}`,
      TIMEOUT_PREVIEW_URL_MS
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

  private async request<T>(
    method: "GET" | "POST",
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
      if (body !== undefined) {
        init.body = JSON.stringify(body);
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

      // Some endpoints (start, stop, recover) may return empty 200/204
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaRestClient(config: DaytonaRestConfig): DaytonaRestClient {
  return new DaytonaRestClient(config);
}
