/**
 * Read-only control-plane client.
 *
 * Authenticates with a personal access token the user issued to themselves in
 * the web UI. The control plane resolves it to that user, so requests are
 * attributable to a person and revocable by them — and, being an access-token
 * principal, refused every mutating method.
 */

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

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ControlPlaneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * GET a control-plane path and parse the JSON body.
   *
   * Only GET is exposed, but that is ergonomics rather than the security
   * boundary: the control plane refuses every mutating method from an
   * access-token principal, so a `DELETE` bearing this token is rejected
   * whether or not it came from this class (`principalMayUseMethod` in the
   * control plane's `auth/principal.ts`).
   */
  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const request = { method: "GET", url: url.toString() };
    const headers = { Authorization: `Bearer ${this.token}` };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await fetch(request.url, {
        method: "GET",
        headers: { ...headers, Accept: "application/json" },
        signal: controller.signal,
      });
      // Inside the same timer as the fetch: `fetch` resolves on headers, so a
      // control plane that sends headers and then stalls the body would hang
      // the tool call forever if the timeout ended here.
      body = await readCapped(response);
    } catch (cause) {
      // A cap breach already says exactly what happened; rewrapping it as a
      // transport failure would hide the one detail that matters.
      if (cause instanceof ControlPlaneError) throw cause;
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new ControlPlaneError(`${request.method} ${path} failed: ${reason}`, null);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 401 here means the token was rejected: mistyped, revoked, or expired.
      // Issue a new one in the web UI under Settings -> Access tokens.
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

/**
 * Read a response body, refusing to buffer more than `MAX_RESPONSE_BYTES`.
 *
 * Streamed rather than `response.text()`-then-measured: the cap has to bound
 * what is allocated, and a session diff can be arbitrarily large. Counting is
 * in bytes off the wire, not string length — `String.length` is UTF-16 code
 * units, which undercounts every multi-byte character.
 *
 * An oversized body is an error rather than a truncation, because truncated
 * JSON only resurfaces later as a parse failure that blames the wrong thing.
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
    // An abort or an over-cap throw leaves the stream open; cancelling lets
    // the socket close rather than leaking it for the process's lifetime.
    void reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}
