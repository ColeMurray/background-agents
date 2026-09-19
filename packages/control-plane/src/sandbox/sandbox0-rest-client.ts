import { withRequestDeadline } from "./request-deadline";

export const DEFAULT_SANDBOX0_REQUEST_TIMEOUT_MS = 120_000;

export interface Sandbox0ClientConfig {
  apiKey: string;
  apiUrl?: string;
}

export class Sandbox0ApiError extends Error {
  /** Retain retry-relevant status without including provider response bodies. */
  constructor(
    public readonly status: number,
    public readonly code: string,
    endpoint: string
  ) {
    // Provider error bodies can contain customer data; never copy them to logs.
    super(`Sandbox0 ${endpoint} failed (${status}, ${code})`);
    this.name = "Sandbox0ApiError";
  }
}

/** Fetch-only transport, usable from Workers and the Node control plane. */
export class Sandbox0RestClient {
  private readonly apiUrl: string;

  /** Reject endpoints that could expose bearer credentials over insecure transport. */
  constructor(private readonly config: Sandbox0ClientConfig) {
    const url = new URL(config.apiUrl || "https://api.sandbox0.ai");
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("Sandbox0 API URL must use HTTPS (HTTP is allowed on loopback)");
    if (!config.apiKey) throw new Error("SANDBOX0_API_KEY is required");
    this.apiUrl = url.href.replace(/\/$/, "");
  }

  /** Unwrap an authenticated response under a deadline; never follow redirects or replay writes. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal; idempotencyKey?: string; timeoutMs?: number } = {}
  ): Promise<T> {
    return withRequestDeadline(
      "Sandbox0",
      path,
      options.timeoutMs ?? DEFAULT_SANDBOX0_REQUEST_TIMEOUT_MS,
      options.signal,
      async (signal) => {
        const response = await fetch(`${this.apiUrl}${path}`, {
          method,
          signal,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        // Gateways may return HTML errors; retain the HTTP status for retry policy.
        if (!response.ok) throw new Sandbox0ApiError(response.status, "request_failed", path);
        const envelope = (await response.json()) as { data?: T };
        if (envelope.data === undefined) throw new Error(`Sandbox0 ${path} returned no data`);
        return envelope.data;
      }
    );
  }
}

/** Treat the provider ID as a single path segment, not caller-supplied routing. */
export function sandbox0Path(sandboxId: string): string {
  return `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}`;
}
