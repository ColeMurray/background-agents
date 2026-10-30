/**
 * Control-plane client for the MCP server.
 *
 * Authenticates with a personal access token the user issued to themselves in the web UI. The
 * control plane resolves it to that user and narrows the user's permissions to the token's grant,
 * so what this client can do is decided there, not here: a route refuses the token unless it
 * accepts tokens, and a permission check fails unless the token was granted the permission.
 *
 * The token is a bearer credential on every request, so the base URL has to be `https:`, or a
 * loopback host where nothing leaves the machine, and redirects are refused rather than followed.
 */

import { isPersonalAccessTokenFormat } from "@open-inspect/shared/types/personal-access-tokens";

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
  token: string;
  timeoutMs?: number;
}

/**
 * Hosts for which plain `http:` is accepted. The token travels in an `Authorization` header on
 * every request, so cleartext is only safe when the request cannot leave the machine. `URL`
 * reports an IPv6 host with its brackets.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolve the configured base URL, refusing one that would transmit the token in cleartext.
 * Checked before it is stored rather than at each `fetch`, so a misconfigured server fails at
 * startup instead of leaking on its first call.
 */
function requireSecureBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError(`Control plane URL is not a valid URL: ${value}`, null);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    throw new ControlPlaneError(
      `Control plane URL must use https (plain http only for a loopback host): ${value}`,
      null
    );
  }
  if (url.search || url.hash) {
    throw new ControlPlaneError(
      `Control plane URL must not have a query or fragment: ${value}`,
      null
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Refusal codes the control plane answers with, and what the user can do about each. */
function refusalHint(status: number, body: string): string | null {
  if (status === 401) {
    return "The token was rejected: it is mistyped, revoked, or expired. Issue a new one under Settings > Access tokens.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { code, permission } = parsed as { code?: unknown; permission?: unknown };
  if (code === "permission_required" && typeof permission === "string") {
    return (
      `This token was not granted ${permission}, or its owner no longer holds it. ` +
      "Issue a token that includes it under Settings > Access tokens."
    );
  }
  if (code === "personal_access_token_not_accepted") {
    return "This part of the API does not accept personal access tokens.";
  }
  return null;
}

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ControlPlaneClientConfig) {
    this.baseUrl = requireSecureBaseUrl(config.baseUrl);
    if (!isPersonalAccessTokenFormat(config.token)) {
      // The value itself is never echoed: it may be a real credential pasted into the wrong place.
      throw new ControlPlaneError(
        "OPEN_INSPECT_TOKEN is not a personal access token (expected oi_pat_ followed by 64 hex characters)",
        null
      );
    }
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET a control-plane path and parse the JSON body. */
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.send("GET", path, { query });
  }

  /** POST a JSON body to a control-plane path and parse the JSON response. */
  post(
    path: string,
    body: unknown,
    options?: { headers?: Record<string, string> }
  ): Promise<unknown> {
    return this.send("POST", path, { body, headers: options?.headers });
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        // A redirect would carry the bearer token to wherever the response points. The control
        // plane never redirects an API call, so one means something in between is misbehaving.
        redirect: "error",
        signal: controller.signal,
      });
      // Inside the same timer as the fetch: `fetch` resolves on headers, so a control plane that
      // sends headers and then stalls the body would hang the tool call if the timeout ended here.
      body = await readCapped(response);
    } catch (cause) {
      // A cap breach already says exactly what happened; rewrapping it would hide that.
      if (cause instanceof ControlPlaneError) throw cause;
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new ControlPlaneError(`${method} ${path} failed: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const hint = refusalHint(response.status, body);
      throw new ControlPlaneError(
        `${method} ${path} returned ${response.status}: ${body.slice(0, 500)}` +
          (hint ? `\n${hint}` : ""),
        response.status
      );
    }

    try {
      return JSON.parse(body);
    } catch {
      throw new ControlPlaneError(
        `${method} ${path} returned non-JSON: ${body.slice(0, 200)}`,
        response.status
      );
    }
  }
}

/**
 * Read a response body, refusing to buffer more than `MAX_RESPONSE_BYTES`.
 *
 * Streamed rather than `response.text()`-then-measured: the cap has to bound what is allocated,
 * and a session diff can be arbitrarily large. Counting is in bytes off the wire, not string
 * length. An oversized body is an error rather than a truncation, because truncated JSON only
 * resurfaces later as a parse failure that blames the wrong thing.
 */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";

  const decoder = new TextDecoder("utf-8");
  const reader = response.body.getReader();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new ControlPlaneError(
          `response exceeded ${MAX_RESPONSE_BYTES} bytes; narrow the request (a limit, or a single session)`,
          response.status
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // An abort or an over-cap throw leaves the stream open; cancelling lets the socket close.
    void reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
