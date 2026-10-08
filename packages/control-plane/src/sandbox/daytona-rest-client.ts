/**
 * Direct REST client for the Daytona sandbox, snapshot and toolbox APIs.
 *
 * Replaces the Python shim service by calling Daytona's REST API with native
 * fetch() from Cloudflare Workers. Bearer token auth, per-operation timeouts,
 * and a caller signal composed with every one of them so a multi-request flow
 * (stop, capture, poll) can be bounded as a whole.
 *
 * Three transports live here. The sandbox and snapshot APIs share
 * `DAYTONA_API_URL`; the toolbox is a per-sandbox proxy whose base URL the
 * sandbox itself reports, and whose paths are prefixed with the sandbox id.
 * Nothing hard-codes the hosted proxy: a self-hosted deployment answers with
 * its own.
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
  /**
   * Snapshot name for fresh sandboxes. Absent on a deployment that only
   * finalizes or reclaims resources a previous configuration created, so it
   * is required at the create call rather than at construction.
   */
  baseSnapshot?: string;
  /**
   * Explicit toolbox proxy base URL. Unset on the hosted service, where each
   * sandbox reports its own; set it for a deployment whose proxy the sandbox
   * record does not name.
   */
  toolboxApiUrl?: string;
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
/** Capture copies the whole build filesystem; the request only accepts it. */
const TIMEOUT_SNAPSHOT_MS = 120_000;
const TIMEOUT_SNAPSHOT_GET_MS = 15_000;
const TIMEOUT_SNAPSHOT_MUTATE_MS = 30_000;
const TIMEOUT_TOOLBOX_MS = 30_000;

/** Longest provider error body kept on an error message. */
const MAX_ERROR_BODY_CHARS = 300;

// ---------------------------------------------------------------------------
// Lifecycle states
// ---------------------------------------------------------------------------

/**
 * Sandbox states of the tested API version. `unknown` is Daytona's own value
 * for a state it cannot report, and is also what an unrecognized string maps
 * to: a non-error state is never read as ready.
 */
export const DAYTONA_SANDBOX_STATES = [
  "creating",
  "restoring",
  "destroyed",
  "destroying",
  "started",
  "stopped",
  "starting",
  "stopping",
  "error",
  "build_failed",
  "pending_build",
  "building_snapshot",
  "unknown",
  "pulling_snapshot",
  "archived",
  "archiving",
  "resizing",
  "snapshotting",
  "forking",
  "pausing",
  "paused",
  "resuming",
] as const;

export type DaytonaSandboxState = (typeof DAYTONA_SANDBOX_STATES)[number];

/**
 * Snapshot states of the tested API version. `active` is the only state a
 * create can use; `inactive` is cold storage an activation brings back.
 */
export const DAYTONA_SNAPSHOT_STATES = [
  "building",
  "pending",
  "pulling",
  "snapshotting",
  "active",
  "inactive",
  "error",
  "build_failed",
  "removing",
] as const;

export type DaytonaSnapshotState = (typeof DAYTONA_SNAPSHOT_STATES)[number] | "unknown";

export function parseDaytonaSandboxState(value: string): DaytonaSandboxState {
  return (DAYTONA_SANDBOX_STATES as readonly string[]).includes(value)
    ? (value as DaytonaSandboxState)
    : "unknown";
}

export function parseDaytonaSnapshotState(value: string): DaytonaSnapshotState {
  return (DAYTONA_SNAPSHOT_STATES as readonly string[]).includes(value)
    ? (value as DaytonaSnapshotState)
    : "unknown";
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Optional metadata read leniently: a field Daytona reports in an unexpected
 * shape must not fail the lifecycle read that carries it, because `id` and
 * `state` are what the caller acts on.
 */
const optionalString = z.string().nullish().catch(undefined);

export const daytonaSandboxResponseSchema = z.object({
  id: z.string(),
  state: z.string(),
  name: optionalString,
  recoverable: z.boolean().nullish().catch(undefined),
  labels: z.record(z.string(), z.string()).nullish().catch(undefined),
  errorReason: optionalString,
  createdAt: optionalString,
  /** Wall-clock end of the sandbox's hard TTL, when one was requested. */
  autoDestroyAt: optionalString,
  toolboxProxyUrl: optionalString,
});

export type DaytonaSandboxResponse = z.infer<typeof daytonaSandboxResponseSchema>;

const daytonaSnapshotResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  /**
   * The sandbox this snapshot was captured from. The only evidence that a
   * snapshot found by a reserved name belongs to this build rather than to a
   * name collision.
   */
  sourceSandboxId: optionalString,
  errorReason: optionalString,
});

export type DaytonaSnapshotResponse = z.infer<typeof daytonaSnapshotResponseSchema>;

export const daytonaSignedPreviewUrlResponseSchema = z.object({
  url: z.string(),
});

export type DaytonaSignedPreviewUrlResponse = z.infer<typeof daytonaSignedPreviewUrlResponseSchema>;

const daytonaToolboxProxyUrlResponseSchema = z.object({
  url: z.string(),
});

const daytonaSessionCommandStartedSchema = z.object({
  cmdId: z.string(),
  exitCode: z.number().nullish().catch(undefined),
});

export type DaytonaSessionCommandStarted = z.infer<typeof daytonaSessionCommandStartedSchema>;

const daytonaSessionCommandSchema = z.object({
  id: z.string(),
  /** Absent or null while the command is still running. */
  exitCode: z.number().nullish().catch(undefined),
});

export type DaytonaSessionCommand = z.infer<typeof daytonaSessionCommandSchema>;

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
  /** Hard wall-clock lifetime in whole minutes, regardless of sandbox state. */
  ttlMinutes?: number;
  public?: boolean;
  target?: string;
}

/** One sandbox's toolbox endpoint: its proxy base URL and its own id. */
export interface DaytonaToolboxTarget {
  sandboxId: string;
  /** A base URL `resolveToolboxBaseUrl` returned, and only that. */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a multi-request Daytona flow is cancelled: the caller's budget
 * ran out between two of its requests.
 */
export class DaytonaCancelledError extends Error {
  constructor() {
    super("Daytona operation cancelled before it completed");
    this.name = "DaytonaCancelledError";
  }
}

/** Thrown when Daytona returns 404 — the resource no longer exists. */
export class DaytonaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaNotFoundError";
  }
}

/**
 * Non-404 Daytona API error. Carries the HTTP status for classification and,
 * for a rate-limited read, the provider's own retry guidance.
 *
 * The message never carries the request body: command text, stdin payloads
 * and create envs pass through this client, and an error message reaches
 * structured logs and failure tooltips. Response bodies are truncated and
 * have the API key redacted out of them.
 */
export class DaytonaApiError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    public readonly status: number,
    options?: { retryAfterMs?: number }
  ) {
    super(message);
    this.name = "DaytonaApiError";
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

// ---------------------------------------------------------------------------
// Resource naming
// ---------------------------------------------------------------------------

/**
 * The provider-side name of a build's source sandbox or captured snapshot.
 *
 * Derived from the immutable build id so an uncertain create or capture can
 * be reconciled by name alone, and hashed so the name stays inside Daytona's
 * charset whatever a scope id contains — a nested owner, a long identity, or
 * a character no provider name accepts. Full scope identity travels in labels
 * and in D1, never in this name.
 */
export async function daytonaBuildResourceName(
  kind: "source" | "image",
  buildId: string
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(buildId));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `oi-${kind}-${hex.slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type DaytonaMethod = "DELETE" | "GET" | "POST";

interface DaytonaRequest {
  method: DaytonaMethod;
  path: string;
  timeoutMs: number;
  body?: unknown;
  signal?: AbortSignal;
  /** Transport base URL; defaults to the sandbox/snapshot API. */
  baseUrl?: string;
  /**
   * Drop the response body from the error message. Set on endpoints whose
   * bodies can echo the request — the toolbox's command and stdin routes.
   */
  redactBody?: boolean;
}

export class DaytonaRestClient {
  private readonly baseUrl: string;
  private readonly toolboxBaseUrl?: string;

  constructor(public readonly config: DaytonaRestConfig) {
    if (!config.apiUrl) {
      throw new Error("DaytonaRestClient requires apiUrl");
    }
    if (!config.apiKey) {
      throw new Error("DaytonaRestClient requires apiKey");
    }

    this.baseUrl = trimTrailingSlashes(config.apiUrl);
    const toolboxApiUrl = config.toolboxApiUrl?.trim();
    if (toolboxApiUrl) {
      this.toolboxBaseUrl = trimTrailingSlashes(toolboxApiUrl);
    }
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /**
   * The configured base snapshot. Only creates need one, so a cleanup-only
   * deployment can hold credentials without a current base image.
   */
  requireBaseSnapshot(): string {
    const baseSnapshot = this.config.baseSnapshot;
    if (!baseSnapshot) {
      throw new Error("DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes");
    }
    return baseSnapshot;
  }

  // -----------------------------------------------------------------------
  // Sandbox lifecycle
  // -----------------------------------------------------------------------

  async createSandbox(
    params: DaytonaCreateSandboxParams,
    signal?: AbortSignal
  ): Promise<DaytonaSandboxResponse> {
    const startMs = Date.now();
    try {
      return await this.requestJson(daytonaSandboxResponseSchema, {
        method: "POST",
        path: "/sandbox",
        timeoutMs: TIMEOUT_CREATE_MS,
        body: params,
        signal,
      });
    } finally {
      log.info("daytona.create_sandbox", {
        duration_ms: Date.now() - startMs,
        sandbox_name: params.name,
      });
    }
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<DaytonaSandboxResponse> {
    return this.requestJson(daytonaSandboxResponseSchema, {
      method: "GET",
      path: `/sandbox/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_GET_MS,
      signal,
    });
  }

  async startSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid({
      method: "POST",
      path: `/sandbox/${encodeURIComponent(id)}/start`,
      timeoutMs: TIMEOUT_START_MS,
      signal,
    });
  }

  async stopSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid({
      method: "POST",
      path: `/sandbox/${encodeURIComponent(id)}/stop`,
      timeoutMs: TIMEOUT_STOP_MS,
      signal,
    });
  }

  async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid({
      method: "DELETE",
      path: `/sandbox/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_DELETE_MS,
      signal,
    });
  }

  async recoverSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid({
      method: "POST",
      path: `/sandbox/${encodeURIComponent(id)}/recover`,
      timeoutMs: TIMEOUT_RECOVER_MS,
      signal,
    });
  }

  /** The expiry rides in `expiresInSeconds`; under any other name the API signs its own default. */
  async getSignedPreviewUrl(
    id: string,
    port: number,
    expirySeconds: number,
    signal?: AbortSignal
  ): Promise<DaytonaSignedPreviewUrlResponse> {
    return this.requestJson(daytonaSignedPreviewUrlResponseSchema, {
      method: "GET",
      path: `/sandbox/${encodeURIComponent(id)}/ports/${port}/signed-preview-url?expiresInSeconds=${expirySeconds}`,
      timeoutMs: TIMEOUT_PREVIEW_URL_MS,
      signal,
    });
  }

  // -----------------------------------------------------------------------
  // Snapshots
  // -----------------------------------------------------------------------

  /**
   * Request a filesystem-only capture of a stopped sandbox. The response is
   * the SOURCE sandbox, not the snapshot: acceptance means the capture was
   * requested, and only a snapshot lookup can say whether it exists.
   */
  async createSandboxSnapshot(
    sandboxIdOrName: string,
    params: { name: string; includeMemory: boolean },
    signal?: AbortSignal
  ): Promise<DaytonaSandboxResponse> {
    return this.requestJson(daytonaSandboxResponseSchema, {
      method: "POST",
      path: `/sandbox/${encodeURIComponent(sandboxIdOrName)}/snapshot`,
      timeoutMs: TIMEOUT_SNAPSHOT_MS,
      body: params,
      signal,
    });
  }

  /** Look a snapshot up by its immutable id or by name. 404 throws. */
  async getSnapshot(idOrName: string, signal?: AbortSignal): Promise<DaytonaSnapshotResponse> {
    return this.requestJson(daytonaSnapshotResponseSchema, {
      method: "GET",
      path: `/snapshots/${encodeURIComponent(idOrName)}`,
      timeoutMs: TIMEOUT_SNAPSHOT_GET_MS,
      signal,
    });
  }

  /** Activation takes the immutable id; resolve a name through getSnapshot first. */
  async activateSnapshot(id: string, signal?: AbortSignal): Promise<DaytonaSnapshotResponse> {
    return this.requestJson(daytonaSnapshotResponseSchema, {
      method: "POST",
      path: `/snapshots/${encodeURIComponent(id)}/activate`,
      timeoutMs: TIMEOUT_SNAPSHOT_MUTATE_MS,
      signal,
    });
  }

  /** Deletion takes the immutable id and is asynchronous (state `removing`). */
  async deleteSnapshot(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid({
      method: "DELETE",
      path: `/snapshots/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_SNAPSHOT_MUTATE_MS,
      signal,
    });
  }

  // -----------------------------------------------------------------------
  // Toolbox (per-sandbox proxy)
  // -----------------------------------------------------------------------

  /**
   * The toolbox base URL for one sandbox: the configured override, else the
   * sandbox's own `toolboxProxyUrl`, else the dedicated lookup.
   *
   * Every source is checked before it is returned, and this is the only place
   * a toolbox target's base URL comes from: the API key rides in the
   * Authorization header of every toolbox request, so a base URL that would
   * carry it in cleartext is refused before the first one is issued.
   */
  async resolveToolboxBaseUrl(
    sandboxId: string,
    options?: { sandbox?: DaytonaSandboxResponse; signal?: AbortSignal }
  ): Promise<string> {
    if (this.toolboxBaseUrl) {
      return requireSecureToolboxUrl(this.toolboxBaseUrl, "configured toolbox URL");
    }
    const reported = options?.sandbox?.toolboxProxyUrl;
    if (reported) {
      return requireSecureToolboxUrl(reported, "sandbox-reported toolbox proxy URL");
    }
    const resolved = await this.requestJson(daytonaToolboxProxyUrlResponseSchema, {
      method: "GET",
      path: `/sandbox/${encodeURIComponent(sandboxId)}/toolbox-proxy-url`,
      timeoutMs: TIMEOUT_GET_MS,
      signal: options?.signal,
    });
    return requireSecureToolboxUrl(resolved.url, "toolbox proxy lookup");
  }

  async createProcessSession(
    target: DaytonaToolboxTarget,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid({
      method: "POST",
      path: `${this.toolboxPath(target)}/process/session`,
      timeoutMs: TIMEOUT_TOOLBOX_MS,
      body: { sessionId },
      baseUrl: target.baseUrl,
      signal,
    });
  }

  /**
   * Start one command in a process session.
   *
   * `runAsync` returns as soon as the command is running, so the caller can
   * then write its stdin; `suppressInputEcho` keeps that input out of the
   * command's recorded logs, which is what makes stdin a usable secret
   * channel at all.
   */
  async executeSessionCommand(
    target: DaytonaToolboxTarget,
    sessionId: string,
    command: string,
    signal?: AbortSignal
  ): Promise<DaytonaSessionCommandStarted> {
    return this.requestJson(daytonaSessionCommandStartedSchema, {
      method: "POST",
      path: `${this.toolboxPath(target)}/process/session/${encodeURIComponent(sessionId)}/exec`,
      timeoutMs: TIMEOUT_TOOLBOX_MS,
      body: { command, runAsync: true, suppressInputEcho: true },
      baseUrl: target.baseUrl,
      redactBody: true,
      signal,
    });
  }

  /**
   * Write to a running command's stdin. The one secret-bearing request.
   *
   * The toolbox delivers the payload the body carries under `data`, and
   * nothing else in the body reaches the command.
   */
  async sendSessionCommandInput(
    target: DaytonaToolboxTarget,
    sessionId: string,
    commandId: string,
    input: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid({
      method: "POST",
      path: `${this.toolboxPath(target)}/process/session/${encodeURIComponent(
        sessionId
      )}/command/${encodeURIComponent(commandId)}/input`,
      timeoutMs: TIMEOUT_TOOLBOX_MS,
      body: { data: input },
      baseUrl: target.baseUrl,
      redactBody: true,
      signal,
    });
  }

  async getSessionCommand(
    target: DaytonaToolboxTarget,
    sessionId: string,
    commandId: string,
    signal?: AbortSignal
  ): Promise<DaytonaSessionCommand> {
    return this.requestJson(daytonaSessionCommandSchema, {
      method: "GET",
      path: `${this.toolboxPath(target)}/process/session/${encodeURIComponent(
        sessionId
      )}/command/${encodeURIComponent(commandId)}`,
      timeoutMs: TIMEOUT_TOOLBOX_MS,
      baseUrl: target.baseUrl,
      redactBody: true,
      signal,
    });
  }

  async deleteProcessSession(
    target: DaytonaToolboxTarget,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid({
      method: "DELETE",
      path: `${this.toolboxPath(target)}/process/session/${encodeURIComponent(sessionId)}`,
      timeoutMs: TIMEOUT_TOOLBOX_MS,
      baseUrl: target.baseUrl,
      signal,
    });
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Toolbox routes are prefixed with the sandbox they address. */
  private toolboxPath(target: DaytonaToolboxTarget): string {
    return `/${encodeURIComponent(target.sandboxId)}`;
  }

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
  private requestJson<T>(schema: z.ZodType<T>, request: DaytonaRequest): Promise<T> {
    return this.send(request, async (response) =>
      this.parseJson(schema, await response.text(), response.status)
    );
  }

  /**
   * Command whose success body carries nothing we act on. Daytona answers
   * start, stop, delete and the toolbox session routes with an empty 200/204
   * or with a status blob; both are discarded, so neither shape can fail the
   * call.
   */
  private requestVoid(request: DaytonaRequest): Promise<void> {
    return this.send<void>(request, () => {});
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
   * Issue the request under its own timeout, composed with the caller's
   * signal so a whole flow can be cancelled, and hand a successful response
   * to `consume`. The timeout stays armed while `consume` reads the body.
   */
  private async send<T>(
    request: DaytonaRequest,
    consume: (response: Response) => T | Promise<T>
  ): Promise<T> {
    const url = `${request.baseUrl ?? this.baseUrl}${request.path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);

    try {
      const init: RequestInit = {
        method: request.method,
        headers: this.getHeaders(),
        signal: request.signal
          ? AbortSignal.any([controller.signal, request.signal])
          : controller.signal,
      };
      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }

      const response = await fetch(url, init);

      if (response.status === 404) {
        await response.text();
        throw new DaytonaNotFoundError(`Daytona resource not found: ${request.path}`);
      }

      if (!response.ok) {
        throw new DaytonaApiError(
          this.errorMessage(request, response.status, await response.text()),
          response.status,
          retryAfterOptions(response)
        );
      }

      return await consume(response);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * An error message an operator can act on and a log can hold: the endpoint,
   * the status, and — unless the endpoint echoes its request — a truncated,
   * key-redacted excerpt of the provider's own body.
   */
  private errorMessage(request: DaytonaRequest, status: number, body: string): string {
    const endpoint = `${request.method} ${request.path}`;
    if (request.redactBody) {
      return `Daytona API error ${status} on ${endpoint}`;
    }
    const excerpt = this.sanitizeBody(body);
    return excerpt
      ? `Daytona API error ${status} on ${endpoint}: ${excerpt}`
      : `Daytona API error ${status} on ${endpoint}`;
  }

  private sanitizeBody(body: string): string {
    const redacted = body.split(this.config.apiKey).join("[redacted]").trim();
    return redacted.length > MAX_ERROR_BODY_CHARS
      ? `${redacted.slice(0, MAX_ERROR_BODY_CHARS)}...`
      : redacted;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Which of the three toolbox URL sources a refusal is about. */
type ToolboxUrlSource =
  | "configured toolbox URL"
  | "sandbox-reported toolbox proxy URL"
  | "toolbox proxy lookup";

/** Hosts a toolbox URL may address over plain HTTP: a runner on this machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * A toolbox base URL the API key may be sent to.
 *
 * Every toolbox request carries the key in its Authorization header, so a
 * base URL that is not HTTPS is refused here rather than after a request has
 * already disclosed it. Plain HTTP is accepted only for a loopback host,
 * where nothing leaves the machine.
 *
 * The refusal names the source and the scheme and nothing else: a proxy URL
 * can itself carry a signed token, and this message reaches logs.
 */
function requireSecureToolboxUrl(url: string, source: ToolboxUrlSource): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Daytona ${source} is not a valid URL`);
  }
  const secure =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname));
  if (!secure) {
    throw new Error(`Daytona ${source} must use https, not ${parsed.protocol.slice(0, -1)}`);
  }
  return trimTrailingSlashes(trimmed);
}

/**
 * Pace one step of a polling flow, and end the flow the moment the caller's
 * budget is spent.
 *
 * Rejecting rather than resolving on abort is what keeps a cancelled poll
 * from spinning: a loop whose wait returns instantly, over a transport that
 * ignores the signal, would never yield to its own deadline again.
 */
export function delayUnlessCancelled(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DaytonaCancelledError());
      return;
    }
    const timeoutId = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        reject(new DaytonaCancelledError());
      },
      { once: true }
    );
  });
}

/**
 * Rate-limit guidance, for reads and polls a caller may safely repeat. A
 * mutation is never retried on this: the request may have been applied.
 */
function retryAfterOptions(response: Response): { retryAfterMs: number } | undefined {
  if (response.status !== 429) return undefined;
  // An absent header is absent guidance, not zero seconds: Number(null) is 0.
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const retryAfter = Number(header.trim());
  if (!Number.isFinite(retryAfter) || retryAfter < 0) return undefined;
  return { retryAfterMs: retryAfter * 1000 };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDaytonaRestClient(config: DaytonaRestConfig): DaytonaRestClient {
  return new DaytonaRestClient(config);
}
