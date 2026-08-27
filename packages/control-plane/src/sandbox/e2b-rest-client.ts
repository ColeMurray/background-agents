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
// A snapshot bakes the build sandbox's filesystem into a reusable template;
// larger than the other calls because it copies the whole prebuilt filesystem.
const TIMEOUT_SNAPSHOT_MS = 180_000;
const TIMEOUT_DELETE_TEMPLATE_MS = 30_000;
const TIMEOUT_START_PROCESS_MS = 30_000;

/** Connect envelope prefix: one flag byte plus a big-endian uint32 length. */
const ENVELOPE_HEADER_BYTES = 5;
/** Connect end-of-stream flag; that envelope carries `{}` or `{"error": ...}`. */
const ENVELOPE_END_STREAM_FLAG = 0x02;

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

/**
 * Response of `POST /sandboxes/{id}/snapshots`. E2B captures the running
 * sandbox as-is — memory included, which is why the bake quiesces first — into
 * a reusable "snapshot template" whose id doubles as a `templateID`. The
 * image's *contract* is its filesystem only: every spawn from it starts the
 * runtime entrypoint anew. `snapshotID` includes the build tag
 * (e.g. `abc123:default`).
 */
const e2bSnapshotInfoSchema = z.object({
  snapshotID: z.string(),
  names: z.array(z.string()).default([]),
});

export type E2BSnapshotInfo = z.infer<typeof e2bSnapshotInfoSchema>;

/** Default port envd listens on inside every sandbox. */
const ENVD_PORT = 49983;
/** Default sandbox host suffix (overridden by the create response `domain`). */
const DEFAULT_SANDBOX_DOMAIN = "e2b.app";

export interface E2BCreateSandboxParams {
  templateID: string;
  /**
   * Per-sandbox env, applied by envd to every process it starts. The sole
   * delivery channel for session env (secrets included): never pass secrets
   * per-command — envd logs Process/Start requests, values included, into
   * E2B's team-visible platform logs.
   */
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutSeconds?: number;
  /** Pause (not kill) the sandbox when its timeout expires. */
  autoPause?: boolean;
  /** Wake a paused sandbox on inbound activity (only meaningful with autoPause). */
  autoResume?: boolean;
  /**
   * Require an access token to reach envd (returned as `envdAccessToken`). Without it,
   * envd would accept anonymous process starts over the public sandbox host.
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

/**
 * Walk a Connect streaming response, yielding each envelope's flags and JSON.
 * The response is fully buffered before decoding, so a truncated or malformed
 * envelope means the stream is not trustworthy evidence — throw rather than
 * silently dropping what did not parse.
 */
function* decodeConnectEnvelopes(buffer: Uint8Array): Generator<{ flags: number; body: unknown }> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + ENVELOPE_HEADER_BYTES > buffer.length) {
      throw new Error("envd stream truncated mid-envelope");
    }
    const flags = buffer[offset]!;
    const length = view.getUint32(offset + 1);
    const start = offset + ENVELOPE_HEADER_BYTES;
    const end = start + length;
    if (end > buffer.length) {
      throw new Error("envd stream truncated mid-envelope");
    }
    let body: unknown;
    try {
      body = JSON.parse(decoder.decode(buffer.subarray(start, end)));
    } catch {
      throw new Error("envd stream contained a malformed envelope");
    }
    yield { flags, body };
    offset = end;
  }
}

/**
 * Fail unless the stream proves the command ran to a clean exit: a start
 * event, `end.status === "exit status 0"`, and a healthy Connect end-of-stream
 * envelope (the protocol requires one on every completed stream). envd reports
 * command failures in-band (a normal 200 stream ending in a non-zero
 * `exit status`), so the HTTP status alone proves nothing — and a stream
 * missing any part of that shape is a failure, not a success: this guards the
 * spawn path, where a false "started" becomes a session that dies silently on
 * the connecting timeout.
 */
function assertProcessStarted(buffer: Uint8Array): void {
  let started = false;
  let exitedCleanly = false;
  let endOfStream = false;
  for (const { flags, body } of decodeConnectEnvelopes(buffer)) {
    if (flags & ENVELOPE_END_STREAM_FLAG) {
      const streamError = (body as { error?: { message?: string } }).error;
      if (streamError) {
        throw new Error(`envd process start failed: ${streamError.message ?? "stream error"}`);
      }
      endOfStream = true;
      continue;
    }
    const event = (body as { event?: Record<string, { status?: string }> }).event;
    if (event?.start) started = true;
    const status = event?.end?.status;
    if (status !== undefined) {
      if (status !== "exit status 0") {
        throw new Error(`envd process start exited non-zero: ${status}`);
      }
      exitedCleanly = true;
    }
  }
  if (!started || !exitedCleanly || !endOfStream) {
    throw new Error(
      `envd process start stream incomplete ` +
        `(start=${started} clean_exit=${exitedCleanly} end_of_stream=${endOfStream})`
    );
  }
}

/**
 * Strip every create-env value from provider error text before it can escape
 * into a persisted/broadcast failure reason. The create request carries
 * secrets (SANDBOX_AUTH_TOKEN, user secrets, build callback tokens); if E2B
 * ever echoes request values in an error body, the echo must die here. Each
 * value is matched raw and through two levels of JSON escaping — the shapes an
 * echo can take in a parsed message or in raw body text that itself quotes the
 * encoded request. Every non-empty value is scrubbed: user secrets are
 * arbitrary-length, so there is no "too short to matter" — the cost is that
 * incidental text matching a config value ("true", a port) is redacted too,
 * which is the right failure direction for an error path.
 */
function scrubEnvValues(text: string, envVars: Record<string, string>): string {
  const needles = new Set<string>();
  for (const value of Object.values(envVars)) {
    if (!value) continue;
    let form = value;
    for (let i = 0; i < 3; i++) {
      needles.add(form);
      form = JSON.stringify(form).slice(1, -1);
    }
  }
  let scrubbed = text;
  // Longest first, so a short needle cannot split a longer one mid-replacement.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(needle).join("[redacted]");
  }
  return scrubbed;
}

function scrubbedCreateError(error: E2BApiError, envVars: Record<string, string>): E2BApiError {
  const scrub = (text: string) => scrubEnvValues(text, envVars);
  const body =
    typeof error.body === "string"
      ? scrub(error.body)
      : error.body && {
          ...error.body,
          ...(error.body.message === undefined ? {} : { message: scrub(error.body.message) }),
        };
  return new E2BApiError(scrub(error.message), error.status, body);
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
    } catch (error) {
      // This request body carries secrets (envVars): make sure a provider
      // error echoing request values cannot reach failure reasons verbatim.
      if (error instanceof E2BApiError && params.envVars) {
        throw scrubbedCreateError(error, params.envVars);
      }
      throw error;
    } finally {
      log.info("e2b.create_sandbox", {
        duration_ms: Date.now() - startMs,
        template_id: params.templateID,
      });
    }
  }

  async getSandbox(id: string): Promise<E2BSandboxDetail> {
    return this.requestJson("GET", `/sandboxes/${id}`, TIMEOUT_GET_MS, e2bSandboxDetailSchema);
  }

  /**
   * Pause a sandbox. By default E2B persists filesystem + memory (a resumable
   * freeze). Pass `{ memory: false }` for a filesystem-only pause: resuming it
   * cold-boots (reboots) the sandbox from disk, dropping all process memory. The
   * image-build path uses that to discard the build supervisor (and its secret
   * env) before baking a reusable snapshot.
   */
  async pauseSandbox(id: string, opts?: { memory?: boolean }, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("POST", `/sandboxes/${id}/pause`, TIMEOUT_PAUSE_MS, {
      ...(opts?.memory === undefined ? {} : { body: { memory: opts.memory } }),
      signal,
    });
  }

  /**
   * Resume a paused sandbox (or extend a running one).
   *
   * Connect answers with the create-style `Sandbox` shape — `sandboxID`/`templateID`,
   * no `state`, which only `GET /sandboxes/{id}` returns — including a fresh
   * `envdAccessToken` for secure sandboxes. Most callers resume-and-forget;
   * the image bake uses the returned token to scrub the build's supervisor
   * log before snapshotting (takePrebuiltImageSnapshot).
   */
  async connectSandbox(
    id: string,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<E2BSandboxCreated> {
    return this.requestJson(
      "POST",
      `/sandboxes/${id}/connect`,
      TIMEOUT_CONNECT_MS,
      e2bSandboxCreatedSchema,
      { body: { timeout: timeoutSeconds }, signal }
    );
  }

  /**
   * Start a detached process inside a sandbox through envd.
   *
   * envd speaks Connect RPC and `Process/Start` is server-streaming, so the
   * request body must be a Connect *envelope* — one flag byte, then a
   * big-endian uint32 length, then the JSON message. Posting bare JSON to this
   * endpoint returns 415.
   *
   * The command is expected to detach and exit (the caller wants the spawned
   * process to outlive this RPC), so a non-zero exit or a stream-level error is
   * a real failure and throws.
   */
  async startProcess(
    id: string,
    shellCommand: string,
    opts: { domain?: string | null; envdAccessToken: string; signal?: AbortSignal }
  ): Promise<void> {
    const domain = opts.domain || DEFAULT_SANDBOX_DOMAIN;
    const url = `https://${ENVD_PORT}-${id}.${domain}/process.Process/Start`;
    const message = JSON.stringify({
      process: { cmd: "/bin/sh", args: ["-c", shellCommand] },
    });
    const payload = new TextEncoder().encode(message);
    const framed = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.length);
    new DataView(framed.buffer).setUint32(1, payload.length);
    framed.set(payload, ENVELOPE_HEADER_BYTES);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_START_PROCESS_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        body: framed,
        headers: {
          "Content-Type": "application/connect+json",
          "connect-protocol-version": "1",
          "X-Access-Token": opts.envdAccessToken,
        },
        signal: opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new E2BApiError(
          text || `envd process start failed (${response.status})`,
          response.status,
          text
        );
      }
      assertProcessStarted(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`E2B envd process start timeout after ${TIMEOUT_START_PROCESS_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async killSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("DELETE", `/sandboxes/${id}`, TIMEOUT_KILL_MS, { signal });
  }

  async setSandboxTimeout(id: string, timeoutSeconds: number): Promise<void> {
    await this.requestVoid("POST", `/sandboxes/${id}/timeout`, TIMEOUT_SETTTL_MS, {
      body: { timeout: timeoutSeconds },
    });
  }

  /**
   * Bake the sandbox's current filesystem into a reusable snapshot template
   * (`POST /sandboxes/{id}/snapshots`). The returned `snapshotID` is passed
   * verbatim as `templateID` to {@link createSandbox} to spawn a prebuilt-image
   * sandbox. Used by the image-build workflow after `.openinspect/setup.sh` has
   * run once in the build sandbox.
   */
  async createSnapshot(
    id: string,
    options?: { name?: string; signal?: AbortSignal }
  ): Promise<E2BSnapshotInfo> {
    const startMs = Date.now();
    try {
      return await this.requestJson(
        "POST",
        `/sandboxes/${id}/snapshots`,
        TIMEOUT_SNAPSHOT_MS,
        e2bSnapshotInfoSchema,
        { body: options?.name ? { name: options.name } : {}, signal: options?.signal }
      );
    } finally {
      log.info("e2b.create_snapshot", { duration_ms: Date.now() - startMs, sandbox_id: id });
    }
  }

  /**
   * Delete a snapshot template (`DELETE /templates/{templateID}`). Snapshot ids,
   * build tag included, are passed verbatim as the E2B API requires. Used by the
   * image-build reaper to reclaim superseded prebuilt images.
   */
  async deleteTemplate(templateId: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/templates/${encodeURIComponent(templateId)}`,
      TIMEOUT_DELETE_TEMPLATE_MS,
      { signal }
    );
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
    method: "GET" | "POST" | "PUT" | "DELETE",
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
    method: "GET" | "POST" | "PUT" | "DELETE",
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
    method: "GET" | "POST" | "PUT" | "DELETE",
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
