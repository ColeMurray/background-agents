import { z } from "zod";
import { createLogger } from "../logger";
import { withRequestDeadline } from "./request-deadline";

const log = createLogger("boat-rest-client");

const DEFAULT_BOAT_API_URL = "https://boat.dev/api/v1";

const TIMEOUT_CREATE_MS = 90_000;
const TIMEOUT_RESUME_MS = 90_000;
const TIMEOUT_STOP_MS = 30_000;
const TIMEOUT_DELETE_MS = 30_000;
const TIMEOUT_GET_MS = 15_000;
const TIMEOUT_COMMAND_MS = 30_000;
const TIMEOUT_HOST_MS = 15_000;
const TIMEOUT_FILE_MS = 30_000;

export const BOAT_SANDBOX_TYPES = ["small", "default", "large"] as const;
export type BoatSandboxType = (typeof BOAT_SANDBOX_TYPES)[number];

export interface BoatRestConfig {
  apiKey: string;
  apiUrl?: string;
  org?: string;
  baseSnapshot?: string;
}

const boatSandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  type: z.enum(BOAT_SANDBOX_TYPES).optional(),
  vcpu: z.number().int().optional(),
  memoryGB: z.number().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  archiveAfter: z.string().nullable().optional(),
  snapshotAvailable: z.boolean(),
  snapshotCompletedAt: z.string().nullable().optional(),
  lastSnapshotStatus: z.string().nullable().optional(),
});

export type BoatSandbox = z.infer<typeof boatSandboxSchema>;

const boatCreateResponseSchema = z.object({
  sandbox: boatSandboxSchema,
  ttlSeconds: z.number().int().nullable(),
});

const boatSandboxInfoResponseSchema = z.object({ sandbox: boatSandboxSchema });

const boatActionResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  sandbox: boatSandboxSchema.nullable().optional(),
});

const boatCommandStartedSchema = z.object({
  success: z.boolean(),
  processId: z.number().int(),
  pid: z.number().int(),
  command: z.string(),
  startedAt: z.string(),
});

const boatCommandStatusSchema = z.object({
  success: z.boolean(),
  processId: z.number().int(),
  status: z.enum(["running", "exited", "lost"]),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
});

export type BoatCommandStarted = z.infer<typeof boatCommandStartedSchema>;

const boatHostPortResponseSchema = z.object({
  success: z.boolean(),
  port: z.number().int(),
  url: z.string().url(),
  isProtected: z.boolean(),
  access: z.enum(["private", "public"]),
});

export type BoatHostPortResponse = z.infer<typeof boatHostPortResponseSchema>;

const boatFileWriteResponseSchema = z.object({
  success: z.boolean(),
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  size: z.number().int(),
});

const boatDeletionOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(["sandbox", "snapshot"]),
  targetId: z.string(),
  status: z.enum(["pending", "processing", "blocked", "completed"]),
  attemptCount: z.number().int(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
});

export type BoatDeletionOperation = z.infer<typeof boatDeletionOperationSchema>;

const boatDeletionOperationResponseSchema = z.object({ operation: boatDeletionOperationSchema });

const boatErrorEnvelopeSchema = z.object({
  status: z.number().int().optional(),
  code: z.string().optional(),
  requestId: z.string().optional(),
});

export interface BoatCreateSandboxParams {
  type: BoatSandboxType;
  ttlSeconds: number;
  env: Record<string, string>;
  from: string;
  idempotencyKey: string;
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

export class BoatNotFoundError extends BoatApiError {
  constructor(message: string, requestId?: string) {
    super(message, 404, "not_found", requestId);
    this.name = "BoatNotFoundError";
  }
}

export class BoatConflictError extends BoatApiError {
  constructor(message: string, code?: string, requestId?: string) {
    super(message, 409, code, requestId);
    this.name = "BoatConflictError";
  }
}

type BoatMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

interface BoatRequest {
  method: BoatMethod;
  path: string;
  timeoutMs: number;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class BoatRestClient {
  readonly config: Required<Pick<BoatRestConfig, "apiKey">> & Omit<BoatRestConfig, "apiKey">;
  private readonly baseUrl: string;

  constructor(config: BoatRestConfig) {
    if (!config.apiKey.trim()) throw new Error("BoatRestClient requires apiKey");
    const apiUrl = config.apiUrl?.trim() || DEFAULT_BOAT_API_URL;
    assertSafeBoatApiUrl(apiUrl);
    this.baseUrl = apiUrl.replace(/\/+$/, "");
    this.config = { ...config, apiUrl, apiKey: config.apiKey };
  }

  requireBaseSnapshot(): string {
    const snapshot = this.config.baseSnapshot?.trim();
    if (!snapshot) throw new Error("BOAT_BASE_SNAPSHOT is required to create Boat sandboxes");
    return snapshot;
  }

  async createSandbox(params: BoatCreateSandboxParams, signal?: AbortSignal): Promise<BoatSandbox> {
    const response = await this.requestJson(boatCreateResponseSchema, {
      method: "POST",
      path: "/sandboxes",
      timeoutMs: TIMEOUT_CREATE_MS,
      signal,
      headers: { "Idempotency-Key": params.idempotencyKey },
      body: {
        type: params.type,
        ttlSeconds: params.ttlSeconds,
        env: params.env,
        noEnv: true,
        from: params.from,
        ...(this.config.org ? { org: this.config.org } : {}),
      },
    });
    return response.sandbox;
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<BoatSandbox> {
    const response = await this.requestJson(boatSandboxInfoResponseSchema, {
      method: "GET",
      path: `/sandboxes/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_GET_MS,
      signal,
    });
    return response.sandbox;
  }

  async updateSandboxName(id: string, name: string, signal?: AbortSignal): Promise<BoatSandbox> {
    const response = await this.requestJson(boatSandboxInfoResponseSchema, {
      method: "PATCH",
      path: `/sandboxes/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_GET_MS,
      body: { name },
      signal,
    });
    return response.sandbox;
  }

  async resumeSandbox(
    id: string,
    params: { type: BoatSandboxType; ttlSeconds: number },
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestJson(boatActionResponseSchema, {
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(id)}/resume`,
      timeoutMs: TIMEOUT_RESUME_MS,
      body: params,
      signal,
    });
  }

  async stopSandbox(id: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson(boatActionResponseSchema, {
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(id)}/stop`,
      timeoutMs: TIMEOUT_STOP_MS,
      body: { force: false },
      signal,
    });
  }

  async startDetachedCommand(
    id: string,
    command: string,
    signal?: AbortSignal
  ): Promise<BoatCommandStarted> {
    const response = await this.requestJson(boatCommandStartedSchema, {
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(id)}/commands`,
      timeoutMs: TIMEOUT_COMMAND_MS,
      body: { command, detached: true },
      signal,
    });
    if (!response.success) {
      throw new BoatApiError("Boat detached command was not accepted", 200, "command_rejected");
    }
    return response;
  }

  async getCommandStatus(
    id: string,
    processId: number,
    signal?: AbortSignal
  ): Promise<z.infer<typeof boatCommandStatusSchema>> {
    return this.requestJson(boatCommandStatusSchema, {
      method: "GET",
      path: `/sandboxes/${encodeURIComponent(id)}/commands/${processId}`,
      timeoutMs: TIMEOUT_COMMAND_MS,
      signal,
    });
  }

  async hostPort(id: string, port: number, signal?: AbortSignal): Promise<BoatHostPortResponse> {
    const response = await this.requestJson(boatHostPortResponseSchema, {
      method: "POST",
      path: `/sandboxes/${encodeURIComponent(id)}/host`,
      timeoutMs: TIMEOUT_HOST_MS,
      body: { port, public: false },
      signal,
    });
    if (
      !response.success ||
      !response.isProtected ||
      response.access !== "private" ||
      response.port !== port ||
      new URL(response.url).protocol !== "https:"
    ) {
      throw new BoatApiError(
        "Boat did not return a protected private host route",
        200,
        "unsafe_host_route"
      );
    }
    return response;
  }

  async writeTextFile(
    id: string,
    path: string,
    content: string,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await this.requestJson(boatFileWriteResponseSchema, {
      method: "PUT",
      path: `/sandboxes/${encodeURIComponent(id)}/files`,
      timeoutMs: TIMEOUT_FILE_MS,
      body: { path, content, encoding: "utf8" },
      signal,
    });
    if (!response.success) throw new BoatApiError("Boat file write failed", 200);
  }

  async deleteSandbox(id: string, signal?: AbortSignal): Promise<BoatDeletionOperation> {
    const response = await this.requestJson(boatDeletionOperationResponseSchema, {
      method: "DELETE",
      path: `/sandboxes/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_DELETE_MS,
      headers: { "X-Ascii-Confirm-Delete": id },
      signal,
    });
    return response.operation;
  }

  async getDeletionOperation(id: string, signal?: AbortSignal): Promise<BoatDeletionOperation> {
    const response = await this.requestJson(boatDeletionOperationResponseSchema, {
      method: "GET",
      path: `/deletion-operations/${encodeURIComponent(id)}`,
      timeoutMs: TIMEOUT_GET_MS,
      signal,
    });
    return response.operation;
  }

  private async requestJson<T>(schema: z.ZodType<T>, request: BoatRequest): Promise<T> {
    const startedAt = Date.now();
    let httpStatus: number | undefined;
    let outcome = "error";
    try {
      const result = await withRequestDeadline(
        "Boat",
        `${request.method} ${request.path}`,
        request.timeoutMs,
        request.signal,
        async (signal) => {
          const response = await fetch(`${this.baseUrl}${request.path}`, {
            method: request.method,
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
              ...(this.config.org ? { "X-Boat-Org": this.config.org } : {}),
              ...request.headers,
            },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            signal,
          });
          httpStatus = response.status;

          if (!response.ok) throw await this.apiError(response, request.path);
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.includes("application/json")) {
            throw new BoatApiError(
              "Invalid Boat API response",
              response.status,
              "invalid_response"
            );
          }
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            throw new BoatApiError(
              "Invalid Boat API response",
              response.status,
              "invalid_response"
            );
          }
          const parsed = schema.safeParse(body);
          if (!parsed.success) {
            throw new BoatApiError(
              "Invalid Boat API response",
              response.status,
              "invalid_response"
            );
          }
          return parsed.data;
        }
      );
      outcome = "success";
      return result;
    } finally {
      log.info("boat.request", {
        endpoint: `${request.method} ${request.path}`,
        http_status: httpStatus,
        duration_ms: Date.now() - startedAt,
        outcome,
      });
    }
  }

  private async apiError(response: Response, path: string): Promise<BoatApiError> {
    let envelope: z.infer<typeof boatErrorEnvelopeSchema> = {};
    try {
      envelope = boatErrorEnvelopeSchema.parse(await response.json());
    } catch {
      // Response bodies can echo request data. Do not include them in errors.
    }
    const code = envelope.code;
    const requestId = envelope.requestId;
    const message = `Boat API request failed (${response.status}${code ? ` ${code}` : ""}${requestId ? ` request ${requestId}` : ""}, ${path})`;
    if (response.status === 404) return new BoatNotFoundError(message, requestId);
    if (response.status === 409) return new BoatConflictError(message, code, requestId);
    return new BoatApiError(message, response.status, code, requestId);
  }
}

export function createBoatRestClient(config: BoatRestConfig): BoatRestClient {
  return new BoatRestClient(config);
}

function assertSafeBoatApiUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BoatRestClient requires a valid apiUrl");
  }
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
  ) {
    return;
  }
  throw new Error("BoatRestClient apiUrl must use HTTPS except for loopback development URLs");
}
