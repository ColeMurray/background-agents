/**
 * Direct REST client for the Boat sandbox API.
 *
 * Wire-level details verified against the Boat API reference
 * (https://docs.boat.dev/api/v1) and its OpenAPI document. Every call runs
 * under a per-operation deadline and surfaces Boat's error envelope as a typed
 * error carrying the HTTP status, the stable `code` slug and the request id,
 * so callers classify failures by status and code rather than by message text.
 */

import { createLogger } from "../logger";
import { RequestDeadlineError, withRequestDeadline } from "./request-deadline";
import { scrubEnvValues } from "./scrub-env-values";
import { z } from "zod";

const log = createLogger("boat-rest-client");

export const DEFAULT_BOAT_API_URL = "https://boat.dev/api/v1";

export interface BoatRestConfig {
  apiUrl: string;
  apiKey: string;
  /** Organization wallet to bill (`X-Boat-Org`); the account's active wallet when omitted. */
  org?: string;
}

/** Boat machine sizes, smallest first. */
export const BOAT_MACHINE_TYPES = ["small", "default", "large", "xlarge"] as const;
export type BoatMachineType = (typeof BOAT_MACHINE_TYPES)[number];

export function isBoatMachineType(value: string): value is BoatMachineType {
  return (BOAT_MACHINE_TYPES as readonly string[]).includes(value);
}

/** Sandbox states the API reports; `GET /sandboxes/{id}` is the source of truth. */
export const BOAT_SANDBOX_STATES = [
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
  "cancelled",
] as const;
export type BoatSandboxState = (typeof BOAT_SANDBOX_STATES)[number];

/**
 * The longest Boat holds a request for a sandbox that is still starting: a
 * create that hosts ports waits this long for the sandbox's machine, and a
 * file write this long for the sandbox to be ready.
 */
const BOAT_START_WAIT_MS = 60_000;
// A create that hosts ports answers only once the sandbox's machine is there.
const TIMEOUT_CREATE_MS = BOAT_START_WAIT_MS + 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_UPDATE_MS = 15_000;
const TIMEOUT_STOP_MS = 30_000;
const TIMEOUT_UNSHARE_MS = 15_000;
const TIMEOUT_RESUME_MS = 60_000;
const TIMEOUT_DELETE_MS = 30_000;
const TIMEOUT_COMMAND_START_MS = 30_000;
const TIMEOUT_COMMAND_STATUS_MS = 15_000;
// A write to a sandbox that is still starting is held until it is ready, so
// the file lands on the disk the sandbox keeps.
const TIMEOUT_WRITE_FILE_MS = BOAT_START_WAIT_MS + 15_000;
const TIMEOUT_HOST_PORT_MS = 30_000;
const TIMEOUT_SAVED_SNAPSHOT_MS = 30_000;
/** Headroom over a synchronous command's own timeout for transport and queueing. */
const COMMAND_TRANSPORT_HEADROOM_MS = 15_000;
/** Longest tail of each log a status poll returns; enough for a diagnostic, never a transcript. */
const COMMAND_STATUS_TAIL_BYTES = 4_096;

const boatStopOperationSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "failing", "completed", "superseded"]),
  error: z.string().nullable().optional(),
});

export type BoatStopOperation = z.infer<typeof boatStopOperationSchema>;

/**
 * The subset of Boat's `Sandbox` the control plane acts on. `state` stays a
 * plain string so a state Boat adds later degrades to "not one we know" rather
 * than an invalid response.
 */
const boatSandboxSchema = z.object({
  id: z.string(),
  state: z.string(),
  type: z.string().optional(),
  error: z.string().nullable().optional(),
  /** When Boat stops the sandbox by itself; null when auto-stop is disabled. */
  archiveAfter: z.string().nullable().optional(),
  ttlSeconds: z.number().nullable().optional(),
  snapshotAvailable: z.boolean().optional(),
  hydrated: z.boolean().optional(),
  /** Outcome of the create-time `setupScript`: pending, running, done or failed; null without one. */
  setupStatus: z.string().nullable().optional(),
  setupError: z.string().nullable().optional(),
  /** Set once Boat deleted a stopped sandbox's snapshot data (14 days after the stop). */
  dataExpiredAt: z.string().nullable().optional(),
  subdomain: z.string().nullable().optional(),
  /**
   * `shared` or `private` for a sandbox an organization pays for (every
   * member can use a shared one); null for a personal sandbox.
   */
  visibility: z.string().nullable().optional(),
  stop: boatStopOperationSchema.nullable().optional(),
});

export type BoatSandbox = z.infer<typeof boatSandboxSchema>;

const sandboxEnvelopeSchema = z.object({ sandbox: boatSandboxSchema });

const actionEnvelopeSchema = z.object({
  id: z.string(),
  status: z.string(),
  sandbox: boatSandboxSchema.nullable().optional(),
});

const commandStartedSchema = z.object({
  processId: z.number().int(),
});

const commandFinishedSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
});

export type BoatCommandResult = z.infer<typeof commandFinishedSchema>;

const commandStatusSchema = z.object({
  status: z.enum(["running", "exited", "lost"]),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

export type BoatCommandStatus = z.infer<typeof commandStatusSchema>;

const hostedPortSchema = z.object({
  port: z.number().int(),
  url: z.string(),
  isProtected: z.boolean().optional(),
  access: z.string().optional(),
});

export type BoatHostedPort = z.infer<typeof hostedPortSchema>;

/**
 * What a create answers for one port it was asked to host: the route, as
 * `POST /sandboxes/{id}/host` answers it, or `error` and `message` when that
 * port alone could not be hosted (the sandbox is created regardless).
 */
const createHostedPortSchema = z.object({
  port: z.number().int(),
  url: z.string().optional(),
  isProtected: z.boolean().optional(),
  access: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type BoatCreateHostedPort = z.infer<typeof createHostedPortSchema>;

const createdEnvelopeSchema = z.object({
  sandbox: boatSandboxSchema,
  /** Present when the create was asked to host ports, in request order. */
  hostedPorts: z.array(createHostedPortSchema).optional(),
});

/** A created sandbox, with what Boat answered for each port the create hosted. */
export interface BoatCreatedSandbox {
  sandbox: BoatSandbox;
  /** In the order the create asked for them; empty when it asked for none. */
  hostedPorts: BoatCreateHostedPort[];
}

const fileWrittenSchema = z.object({
  path: z.string(),
  size: z.number().int(),
});

/**
 * The subset of Boat's `SavedSnapshot` the control plane acts on. A saved
 * snapshot is a full, standalone copy of a sandbox's disk under a name of the
 * caller's choosing; it outlives its source sandbox and never expires. Boat
 * reports `status` as `saving`, `ready` or `failed`; it stays a plain string
 * here for the same reason the sandbox state does.
 */
const boatSavedSnapshotSchema = z.object({
  name: z.string(),
  status: z.string(),
  /** Why the save failed; present only when `status` is `failed`. */
  error: z.string().nullable().optional(),
  /** The sandbox the snapshot was saved from. */
  sourceSandboxId: z.string().nullable().optional(),
  /** Machine type the source had; deploys default to it. */
  type: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  createdAt: z.string().optional(),
});

export type BoatSavedSnapshot = z.infer<typeof boatSavedSnapshotSchema>;

const savedSnapshotEnvelopeSchema = z.object({ snapshot: boatSavedSnapshotSchema });

/** Boat's rule for a saved snapshot's name, which `POST /saved-snapshots` enforces. */
export const BOAT_SAVED_SNAPSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Boat's error envelope: `{ ok: false, status, code, message, requestId, ... }`. */
const boatErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  requestId: z.string().optional(),
});

/** Longest provider message carried into a control-plane error. */
const MAX_ERROR_MESSAGE_CHARS = 300;

export interface BoatCreateSandboxParams {
  type: BoatMachineType;
  ttlSeconds: number;
  /**
   * Per-sandbox env, the sole delivery channel for the session env (secrets
   * included). Boat applies it to every process the sandbox starts.
   */
  env: Record<string, string>;
  /** Saved snapshot the sandbox deploys from. */
  from: string;
  /**
   * Account-unique key that makes the create safe to retry after a lost
   * response: Boat answers a repeat with the same key and body with the same
   * sandbox instead of a second billable one.
   */
  idempotencyKey: string;
  /**
   * Whether Boat records command output, the process list and CPU/RAM samples
   * for this sandbox. Off for every sandbox the control plane creates: a
   * session's output stays inside the sandbox, and an image build's setup
   * output can carry the scope's secrets.
   */
  monitoring: boolean;
  /**
   * Shell script Boat runs on the sandbox through bash, as the sandbox user
   * with `env` applied, in the background the moment provisioning completes.
   * A session's launch rides here, so the runtime starts with the machine.
   */
  setupScript?: string;
  /** Display name on Boat's dashboard, at most 120 characters. */
  name?: string;
  /**
   * Who may use a sandbox an organization pays for. Boat sets it before the
   * sandbox gets a machine, so a `private` sandbox is never shared, not even
   * for a moment; a personal sandbox is private whatever this says.
   */
  visibility?: "private" | "shared";
  /**
   * Ports to route with the create, each as {@link BoatRestClient.hostPort}
   * would. Boat waits for the sandbox's machine (usually under a second, at
   * most BOAT_START_WAIT_MS), routes them all and answers their URLs, so they
   * are reachable the moment a service listens.
   */
  hostedPorts?: BoatHostPortRequest[];
}

/** One port to route on a public HTTPS URL. */
export interface BoatHostPortRequest {
  port: number;
  /** An ungated URL instead of one that requires the `_token` query parameter. */
  public: boolean;
  title?: string;
}

export class BoatApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "BoatApiError";
  }
}

/** Boat returned 404: the resource no longer exists (or never did). */
export class BoatNotFoundError extends BoatApiError {
  constructor(message: string, code?: string, requestId?: string) {
    super(message, 404, code, requestId);
    this.name = "BoatNotFoundError";
  }
}

/** Boat returned 409: the request conflicts with the sandbox's current state. */
export class BoatConflictError extends BoatApiError {
  constructor(message: string, code?: string, requestId?: string) {
    super(message, 409, code, requestId);
    this.name = "BoatConflictError";
  }
}

/** The caller's own signal ended the operation before Boat answered. */
export class BoatCancelledError extends Error {
  constructor(operation: string) {
    super(`Boat operation cancelled before it completed (${operation})`);
    this.name = "BoatCancelledError";
  }
}

/** Resolve after `delayMs`, or reject with BoatCancelledError when `signal` aborts first. */
export function delayUnlessCancelled(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BoatCancelledError("delay"));
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new BoatCancelledError("delay"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assertSafeBoatApiUrl(apiUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("BoatRestClient requires a valid apiUrl");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  // The API key rides the Authorization header on every call: never in clear text
  // except to a local stand-in server.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("BoatRestClient apiUrl must use https (http is allowed for loopback only)");
  }
  return parsed;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  signal?: AbortSignal;
  /** Runs over a provider error message before it is shortened and kept on the thrown error. */
  redact?: (message: string) => string;
}

/** The wire form of a port to host, shared by the create and `POST /host`. */
function hostPortBody(request: BoatHostPortRequest): Record<string, unknown> {
  return {
    port: request.port,
    public: request.public,
    ...(request.title ? { title: request.title } : {}),
  };
}

export class BoatRestClient {
  private readonly baseUrl: string;

  constructor(public readonly config: BoatRestConfig) {
    if (!config.apiUrl) throw new Error("BoatRestClient requires apiUrl");
    if (!config.apiKey) throw new Error("BoatRestClient requires apiKey");
    assertSafeBoatApiUrl(config.apiUrl);
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
  }

  /**
   * `POST /sandboxes`: deploy a sandbox from a saved snapshot with its own env
   * and none of the account's secrets (`noEnv`). The 202 answer carries the
   * sandbox while it provisions; poll {@link getSandbox} for readiness.
   */
  async createSandbox(
    params: BoatCreateSandboxParams,
    signal?: AbortSignal
  ): Promise<BoatCreatedSandbox> {
    const startMs = Date.now();
    try {
      const response = await this.requestJson(
        "POST",
        "/sandboxes",
        TIMEOUT_CREATE_MS,
        createdEnvelopeSchema,
        {
          body: {
            type: params.type,
            ttlSeconds: params.ttlSeconds,
            env: params.env,
            from: params.from,
            noEnv: true,
            snapshots: true,
            monitoring: params.monitoring,
            ...(params.setupScript !== undefined ? { setupScript: params.setupScript } : {}),
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
            ...(params.hostedPorts !== undefined
              ? { hostedPorts: params.hostedPorts.map(hostPortBody) }
              : {}),
          },
          headers: { "Idempotency-Key": params.idempotencyKey },
          signal,
          // The request body carries secrets (env): a provider error echoing
          // request values must not reach failure reasons, whole or in part.
          redact: (message) => scrubEnvValues(message, params.env),
        }
      );
      return { sandbox: response.sandbox, hostedPorts: response.hostedPorts ?? [] };
    } finally {
      log.info("boat.create_sandbox", {
        duration_ms: Date.now() - startMs,
        machine_type: params.type,
        from_snapshot: params.from,
      });
    }
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox> {
    const response = await this.requestJson(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}`,
      TIMEOUT_GET_MS,
      sandboxEnvelopeSchema,
      { signal }
    );
    return response.sandbox;
  }

  /**
   * `PATCH /sandboxes/{id}`: a new `ttlSeconds` makes the auto-stop deadline
   * now + `ttlSeconds`; `name` is the display name Boat's dashboard shows,
   * which a create can also set from the start.
   */
  async updateSandbox(
    id: string,
    update: { ttlSeconds?: number; name?: string },
    signal?: AbortSignal
  ): Promise<BoatSandbox> {
    const response = await this.requestJson(
      "PATCH",
      `/sandboxes/${encodeURIComponent(id)}`,
      TIMEOUT_UPDATE_MS,
      sandboxEnvelopeSchema,
      {
        body: {
          ...(update.ttlSeconds !== undefined ? { ttlSeconds: update.ttlSeconds } : {}),
          ...(update.name !== undefined ? { name: update.name } : {}),
        },
        signal,
      }
    );
    return response.sandbox;
  }

  /**
   * `POST /sandboxes/{id}/stop`: snapshot the disk, then release the machine.
   * Never forced: a forced stop discards everything written since the last
   * automatic snapshot. The 202 answer is the start of the operation; poll
   * {@link getSandbox} until `state` is `archived`.
   */
  async stopSandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox | null> {
    const response = await this.requestJson(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/stop`,
      TIMEOUT_STOP_MS,
      actionEnvelopeSchema,
      { body: { force: false }, signal }
    );
    return response.sandbox ?? null;
  }

  /**
   * `POST /sandboxes/{id}/resume`: bring a stopped sandbox back on a machine of
   * its current type with a fresh auto-stop deadline. Idempotent on a running
   * sandbox. Poll {@link getSandbox} for readiness.
   */
  async resumeSandbox(
    id: string,
    options: { ttlSeconds: number },
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/resume`,
      TIMEOUT_RESUME_MS,
      { body: { ttlSeconds: options.ttlSeconds }, signal }
    );
  }

  /**
   * `POST /sandboxes/{id}/unshare`: make an organization-billed sandbox
   * private, so only its creator (this API key) can use it. A no-op on a
   * sandbox that is already private; Boat refuses it for a personal sandbox.
   */
  async unshareSandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox> {
    const response = await this.requestJson(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/unshare`,
      TIMEOUT_UNSHARE_MS,
      sandboxEnvelopeSchema,
      { signal }
    );
    return response.sandbox;
  }

  /** `DELETE /sandboxes/{id}`: irreversible; the confirm header must repeat the id. */
  async deleteSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid("DELETE", `/sandboxes/${encodeURIComponent(id)}`, TIMEOUT_DELETE_MS, {
      headers: { "X-Ascii-Confirm-Delete": id },
      signal,
    });
  }

  /**
   * `POST /sandboxes/{id}/commands` with `detached: true`: start `command`
   * under the sandbox user's shell and return at once with its process id.
   * The command line is kept free of secrets; the session env is applied by
   * Boat from the create-time `env`.
   */
  async startDetachedCommand(
    id: string,
    command: string,
    signal?: AbortSignal
  ): Promise<{ processId: number }> {
    return this.requestJson(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/commands`,
      TIMEOUT_COMMAND_START_MS,
      commandStartedSchema,
      { body: { command, detached: true }, signal }
    );
  }

  /** `POST /sandboxes/{id}/commands`: run `command` to completion (at most 600 s). */
  async runCommand(
    id: string,
    command: string,
    options: { timeoutSeconds: number },
    signal?: AbortSignal
  ): Promise<BoatCommandResult> {
    return this.requestJson(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/commands`,
      options.timeoutSeconds * 1000 + COMMAND_TRANSPORT_HEADROOM_MS,
      commandFinishedSchema,
      { body: { command, timeoutSeconds: options.timeoutSeconds }, signal }
    );
  }

  /** `GET /sandboxes/{id}/commands/{processId}`: state and the tail of each log. */
  async getCommandStatus(
    id: string,
    processId: number,
    signal?: AbortSignal
  ): Promise<BoatCommandStatus> {
    return this.requestJson(
      "GET",
      `/sandboxes/${encodeURIComponent(id)}/commands/${encodeURIComponent(String(processId))}`,
      TIMEOUT_COMMAND_STATUS_MS,
      commandStatusSchema,
      { query: { tailBytes: String(COMMAND_STATUS_TAIL_BYTES) }, signal }
    );
  }

  /**
   * `PUT /sandboxes/{id}/files`: write a UTF-8 text file. Boat accepts paths
   * that resolve under `/home/user` or `/tmp` only.
   */
  async writeFile(
    id: string,
    file: { path: string; content: string },
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestJson(
      "PUT",
      `/sandboxes/${encodeURIComponent(id)}/files`,
      TIMEOUT_WRITE_FILE_MS,
      fileWrittenSchema,
      { body: { path: file.path, content: file.content, encoding: "utf8" }, signal }
    );
  }

  /**
   * `POST /sandboxes/{id}/host`: route `https://<subdomain>-<port>.on.boat.dev`
   * to a port. Idempotent: repeating it returns the same URL and token. A
   * protected route (`public: false`) answers only with its `_token`, which the
   * returned URL carries as a query parameter.
   */
  async hostPort(
    id: string,
    options: BoatHostPortRequest,
    signal?: AbortSignal
  ): Promise<BoatHostedPort> {
    return this.requestJson(
      "POST",
      `/sandboxes/${encodeURIComponent(id)}/host`,
      TIMEOUT_HOST_PORT_MS,
      hostedPortSchema,
      { body: hostPortBody(options), signal }
    );
  }

  /**
   * `POST /saved-snapshots`: freeze a sandbox's disk under `name`. Answers 202
   * with the snapshot in `saving`; a running source takes a fresh capture
   * first, a stopped one is saved from its last automatic snapshot. Poll
   * {@link getSavedSnapshot} until the status settles. Saving under an
   * existing name replaces that artifact once the new save is ready, so a
   * repeat of the same request can never add a second snapshot; one that
   * overlaps a running save answers 409 `save_in_progress`, and an account at
   * its allowance with no money in the wallet answers 402 `credit_required`.
   */
  async saveSavedSnapshot(
    sandboxId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<BoatSavedSnapshot> {
    const response = await this.requestJson(
      "POST",
      "/saved-snapshots",
      TIMEOUT_SAVED_SNAPSHOT_MS,
      savedSnapshotEnvelopeSchema,
      { body: { sandboxId, name }, signal }
    );
    return response.snapshot;
  }

  /** `GET /saved-snapshots/{name}`; 404 surfaces as BoatNotFoundError. */
  async getSavedSnapshot(name: string, signal?: AbortSignal): Promise<BoatSavedSnapshot> {
    const response = await this.requestJson(
      "GET",
      `/saved-snapshots/${encodeURIComponent(name)}`,
      TIMEOUT_SAVED_SNAPSHOT_MS,
      savedSnapshotEnvelopeSchema,
      { signal }
    );
    return response.snapshot;
  }

  /**
   * `DELETE /saved-snapshots/{name}`: release the snapshot and its storage.
   * Sandboxes already deployed from it are unaffected. Refused with 409
   * `save_in_progress` while a save under the name is still running.
   */
  async deleteSavedSnapshot(name: string, signal?: AbortSignal): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/saved-snapshots/${encodeURIComponent(name)}`,
      TIMEOUT_SAVED_SNAPSHOT_MS,
      { signal }
    );
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(this.config.org ? { "X-Boat-Org": this.config.org } : {}),
    };
  }

  /**
   * Request whose success body is required: it must be JSON and must satisfy
   * `schema`, otherwise the call fails as an invalid response.
   */
  private requestJson<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    timeoutMs: number,
    schema: z.ZodType<T>,
    options?: RequestOptions
  ): Promise<T> {
    return this.send(method, path, timeoutMs, options, async (response) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new BoatApiError(
          `Invalid Boat API response for ${method} ${path}`,
          response.status,
          "invalid_response"
        );
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        throw new BoatApiError(
          `Invalid Boat API response for ${method} ${path}`,
          response.status,
          "invalid_response"
        );
      }
      return parsed.data;
    });
  }

  /** Command whose success body carries nothing the caller acts on. */
  private requestVoid(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    timeoutMs: number,
    options?: RequestOptions
  ): Promise<void> {
    return this.send<void>(method, path, timeoutMs, options, () => {});
  }

  /**
   * Issue the request under `timeoutMs` (and the caller's signal) and hand a
   * successful response to `consume`. A deadline surfaces as
   * RequestDeadlineError, which the provider classifies transient; the
   * caller's own abort surfaces as BoatCancelledError.
   */
  private async send<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    timeoutMs: number,
    options: RequestOptions | undefined,
    consume: (response: Response) => T | Promise<T>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options?.query ?? {})) {
      url.searchParams.set(key, value);
    }
    try {
      return await withRequestDeadline(
        "boat",
        `${method} ${path}`,
        timeoutMs,
        options?.signal,
        async (signal) => {
          const init: RequestInit = {
            method,
            headers: { ...this.getHeaders(), ...(options?.headers ?? {}) },
            signal,
          };
          if (options?.body !== undefined) {
            init.headers = { ...init.headers, "Content-Type": "application/json" };
            init.body = JSON.stringify(options.body);
          }
          const response = await fetch(url, init);
          if (!response.ok) {
            throw await toApiError(method, path, response, options?.redact);
          }
          return await consume(response);
        }
      );
    } catch (error) {
      if (
        options?.signal?.aborted &&
        !(error instanceof BoatApiError) &&
        !(error instanceof RequestDeadlineError)
      ) {
        throw new BoatCancelledError(`${method} ${path}`);
      }
      throw error;
    }
  }
}

/**
 * Read Boat's error envelope into a typed error; the body text itself never
 * travels. `redact` sees the whole provider message before it is shortened,
 * so a request value the message echoes cannot survive the cut in part.
 */
async function toApiError(
  method: string,
  path: string,
  response: Response,
  redact: (message: string) => string = (message) => message
): Promise<BoatApiError> {
  let code: string | undefined;
  let message: string | undefined;
  let requestId: string | undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = boatErrorBodySchema.safeParse(await response.json());
      if (parsed.success) ({ code, message, requestId } = parsed.data);
    } catch {
      // A malformed error body still describes the failure by status alone.
    }
  }
  const detail = message ? `: ${redact(message).slice(0, MAX_ERROR_MESSAGE_CHARS)}` : "";
  const summary = `Boat API ${method} ${path} failed with HTTP ${response.status}${
    code ? ` (${code})` : ""
  }${detail}`;
  if (response.status === 404) return new BoatNotFoundError(summary, code, requestId);
  if (response.status === 409) return new BoatConflictError(summary, code, requestId);
  return new BoatApiError(summary, response.status, code, requestId);
}

export function createBoatRestClient(config: BoatRestConfig): BoatRestClient {
  return new BoatRestClient(config);
}
