/**
 * Signed, read-only control-plane client.
 *
 * Signs every request as the `mcp` service. That principal asserts no actor
 * (`ASSERTION_RIGHTS.mcp` is null), so the control plane resolves it to a bare
 * service principal that cannot act as any person — the whole point of giving
 * this tool its own service name instead of reusing a bot's.
 */

import { buildOutboundAuthHeaders } from "@open-inspect/shared/service-auth";

/** Longest control-plane response this client will buffer. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}

export interface ControlPlaneClientConfig {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(config: ControlPlaneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET a control-plane path and parse the JSON body.
   *
   * Only GET is exposed. The `mcp` secret would be accepted on the mutating
   * routes that share the user-or-service policy — stopping sessions, deleting
   * them, triggering automations — so the restriction lives here, in the one
   * place every tool goes through, rather than in each tool's discipline.
   */
  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const request = { method: "GET", url: url.toString() };
    const headers = await buildOutboundAuthHeaders(
      { service: "mcp", secret: this.secret },
      request
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "GET",
        headers: { ...headers, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (cause) {
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new ControlPlaneError(`${request.method} ${path} failed: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }

    const body = await readCapped(response);
    if (!response.ok) {
      // 401 here means the signature was rejected: a wrong secret, or a
      // control plane that predates the `mcp` service name.
      throw new ControlPlaneError(
        `${request.method} ${path} returned ${response.status}: ${body.slice(0, 500)}`,
        response.status
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ControlPlaneError(
        `${request.method} ${path} returned non-JSON: ${body.slice(0, 200)}`,
        response.status
      );
    }
  }
}

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? text.slice(0, MAX_RESPONSE_BYTES) : text;
}
