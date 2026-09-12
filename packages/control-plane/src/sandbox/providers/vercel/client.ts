/**
 * Worker-compatible Vercel Sandbox REST client.
 *
 * The published @vercel/sandbox SDK currently imports Node-only modules, so
 * the Cloudflare Worker control plane talks to Vercel's documented Sandbox API
 * with fetch directly.
 */

import { createLogger } from "../../../logger";
import type { CorrelationContext } from "../../../logger";
import { z } from "zod";
import { withRequestDeadline } from "../../request-deadline";

const log = createLogger("vercel-sandbox-client");

const DEFAULT_VERCEL_API_BASE_URL = "https://vercel.com/api";
const USER_AGENT = "open-inspect/vercel-sandbox";

export const VERCEL_SANDBOX_START_REQUEST_DEADLINE_MS = 60_000;
export const VERCEL_COMMAND_REQUEST_DEADLINE_MS = 60_000;
// Exceeds the lifecycle's snapshot budget so caller cancellation retains precedence.
export const VERCEL_SNAPSHOT_REQUEST_DEADLINE_MS = 310_000;
export const VERCEL_API_REQUEST_DEADLINE_MS = 60_000;
export const VERCEL_CLEANUP_REQUEST_DEADLINE_MS = 60_000;
export const VERCEL_COMMAND_REQUEST_DEADLINE_HEADROOM_MS = 10_000;

export interface VercelSandboxClientConfig {
  token: string;
  projectId: string;
  teamId?: string;
  apiBaseUrl?: string;
}

const vercelSandboxStatusSchema = z.enum([
  "pending",
  "running",
  "stopping",
  "stopped",
  "failed",
  "aborted",
  "snapshotting",
]);

const vercelSandboxRouteSchema = z.object({
  url: z.string().optional(),
  subdomain: z.string(),
  port: z.number(),
});

export type VercelSandboxRoute = z.infer<typeof vercelSandboxRouteSchema>;

const vercelSandboxSessionSchema = z.object({
  id: z.string(),
  status: vercelSandboxStatusSchema,
  createdAt: z.number(),
  cwd: z.string(),
  timeout: z.number(),
});

export type VercelSandboxSession = z.infer<typeof vercelSandboxSessionSchema>;

export type VercelVcpus = 1 | 2 | 4 | 8;

const vercelSandboxMetadataSchema = z.object({
  name: z.string(),
  currentSessionId: z.string(),
  currentSnapshotId: z.string().optional(),
  createdAt: z.number(),
  status: vercelSandboxStatusSchema,
});

export type VercelSandboxMetadata = z.infer<typeof vercelSandboxMetadataSchema>;

export interface VercelCreateSandboxRequest {
  name: string;
  runtime?: string;
  timeoutMs?: number;
  resources?: { vcpus: VercelVcpus };
  ports?: number[];
  env?: Record<string, string>;
  tags?: Record<string, string>;
  sourceSnapshotId?: string;
  signal?: AbortSignal;
}

const vercelCreateSandboxResponseSchema = z.object({
  sandbox: vercelSandboxMetadataSchema,
  session: vercelSandboxSessionSchema,
  routes: z.array(vercelSandboxRouteSchema),
});

export type VercelCreateSandboxResponse = z.infer<typeof vercelCreateSandboxResponseSchema>;

export interface VercelRunCommandRequest {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VercelWriteFileArchiveRequest {
  sessionId: string;
  archive: Uint8Array;
  extractDir: string;
  signal?: AbortSignal;
}

export interface VercelListSnapshotsRequest {
  name?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
  signal?: AbortSignal;
}

export interface VercelCommandResult {
  commandId: string;
  exitCode: number | null;
}

const vercelSnapshotStatusSchema = z.enum(["created", "deleted", "failed"]);

const vercelSnapshotMetadataSchema = z.object({
  id: z.string(),
  sourceSessionId: z.string(),
  status: vercelSnapshotStatusSchema,
  region: z.string().optional(),
  sizeBytes: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  expiresAt: z.number().optional(),
  lastUsedAt: z.number().optional(),
  creationMethod: z.string().optional(),
  parentId: z.string().optional(),
});

export type VercelSnapshotMetadata = z.infer<typeof vercelSnapshotMetadataSchema>;

const vercelSnapshotResponseSchema = z.object({
  snapshot: z.object({
    id: z.string(),
    status: vercelSnapshotStatusSchema,
    createdAt: z.number(),
  }),
  session: vercelSandboxSessionSchema,
});

export type VercelSnapshotResponse = z.infer<typeof vercelSnapshotResponseSchema>;

const vercelStartCommandResponseSchema = z.object({
  command: z.object({
    id: z.string(),
    exitCode: z.number().nullable(),
  }),
});

const vercelListSnapshotsResponseSchema = z.object({
  snapshots: z.array(vercelSnapshotMetadataSchema),
});

export class VercelSandboxApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseText?: string
  ) {
    super(message);
    this.name = "VercelSandboxApiError";
  }
}

export class VercelSandboxClient {
  private readonly apiBaseUrl: string;

  constructor(private readonly config: VercelSandboxClientConfig) {
    if (!config.token) throw new Error("VercelSandboxClient requires VERCEL_TOKEN");
    if (!config.projectId) throw new Error("VercelSandboxClient requires VERCEL_PROJECT_ID");
    this.apiBaseUrl = (config.apiBaseUrl || DEFAULT_VERCEL_API_BASE_URL).replace(/\/$/, "");
  }

  async createSandbox(
    request: VercelCreateSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<VercelCreateSandboxResponse> {
    const response = await this.requestJson(
      "/v2/sandboxes",
      {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({
          projectId: this.config.projectId,
          name: request.name,
          runtime: request.runtime,
          timeout: request.timeoutMs,
          resources: request.resources,
          ports: request.ports ?? [],
          env: request.env,
          tags: request.tags,
          source: request.sourceSnapshotId
            ? { type: "snapshot", snapshotId: request.sourceSnapshotId }
            : undefined,
        }),
      },
      vercelCreateSandboxResponseSchema,
      correlation,
      "createSandbox",
      VERCEL_SANDBOX_START_REQUEST_DEADLINE_MS
    );

    return response;
  }

  async startCommand(
    request: VercelRunCommandRequest,
    correlation?: CorrelationContext
  ): Promise<VercelCommandResult> {
    const response = await this.requestJson(
      `/v2/sandboxes/sessions/${encodeURIComponent(request.sessionId)}/cmd`,
      {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({
          command: request.command,
          args: request.args ?? [],
          cwd: request.cwd,
          env: request.env ?? {},
          sudo: request.sudo ?? false,
          timeout: request.timeoutMs,
        }),
      },
      vercelStartCommandResponseSchema,
      correlation,
      "startCommand",
      VERCEL_COMMAND_REQUEST_DEADLINE_MS
    );

    return { commandId: response.command.id, exitCode: response.command.exitCode };
  }

  async runCommandAndWait(
    request: VercelRunCommandRequest,
    correlation?: CorrelationContext
  ): Promise<VercelCommandResult> {
    return this.requestCommandStream(
      `/v2/sandboxes/sessions/${encodeURIComponent(request.sessionId)}/cmd`,
      {
        method: "POST",
        signal: request.signal,
        body: JSON.stringify({
          command: request.command,
          args: request.args ?? [],
          cwd: request.cwd,
          env: request.env ?? {},
          sudo: request.sudo ?? false,
          wait: true,
          timeout: request.timeoutMs,
        }),
      },
      correlation,
      "runCommandAndWait",
      request.timeoutMs === undefined
        ? VERCEL_COMMAND_REQUEST_DEADLINE_MS
        : request.timeoutMs + VERCEL_COMMAND_REQUEST_DEADLINE_HEADROOM_MS
    );
  }

  async writeFileArchive(
    request: VercelWriteFileArchiveRequest,
    correlation?: CorrelationContext
  ): Promise<void> {
    await this.requestVoid(
      `/v2/sandboxes/sessions/${encodeURIComponent(request.sessionId)}/fs/write`,
      {
        method: "POST",
        headers: {
          "content-type": "application/gzip",
          "x-cwd": request.extractDir,
        },
        signal: request.signal,
        body: request.archive,
      },
      correlation,
      "writeFileArchive",
      VERCEL_API_REQUEST_DEADLINE_MS
    );
  }

  async snapshotSession(
    sessionId: string,
    opts: { expirationMs?: number; signal?: AbortSignal } = {},
    correlation?: CorrelationContext
  ): Promise<VercelSnapshotResponse> {
    const body =
      opts.expirationMs === undefined
        ? undefined
        : JSON.stringify({ expiration: opts.expirationMs });
    return this.requestJson(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { method: "POST", body, signal: opts.signal },
      vercelSnapshotResponseSchema,
      correlation,
      "snapshotSession",
      VERCEL_SNAPSHOT_REQUEST_DEADLINE_MS
    );
  }

  async listSnapshots(
    request: VercelListSnapshotsRequest = {},
    correlation?: CorrelationContext
  ): Promise<VercelSnapshotMetadata[]> {
    const response = await this.requestJson(
      buildQueryPath("/v2/sandboxes/snapshots", {
        project: this.config.projectId,
        name: request.name,
        limit: request.limit,
        sortOrder: request.sortOrder,
      }),
      { method: "GET", signal: request.signal },
      vercelListSnapshotsResponseSchema,
      correlation,
      "listSnapshots",
      VERCEL_API_REQUEST_DEADLINE_MS
    );
    return response.snapshots;
  }

  async stopSession(
    sessionId: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid(
      `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: "POST", signal },
      correlation,
      "stopSession",
      VERCEL_CLEANUP_REQUEST_DEADLINE_MS
    );
  }

  async deleteSnapshot(
    snapshotId: string,
    correlation?: CorrelationContext,
    signal?: AbortSignal
  ): Promise<void> {
    await this.requestVoid(
      `/v2/sandboxes/snapshots/${encodeURIComponent(snapshotId)}`,
      { method: "DELETE", signal },
      correlation,
      "deleteSnapshot",
      VERCEL_CLEANUP_REQUEST_DEADLINE_MS
    );
  }

  private requestJson<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    correlation: CorrelationContext | undefined,
    endpoint: string,
    deadlineMs: number
  ): Promise<T> {
    return this.send(
      path,
      init,
      correlation,
      endpoint,
      async (response) => this.parseJson(schema, await response.text(), response.status, endpoint),
      deadlineMs
    );
  }

  private requestVoid(
    path: string,
    init: RequestInit,
    correlation: CorrelationContext | undefined,
    endpoint: string,
    deadlineMs: number
  ): Promise<void> {
    return this.send(
      path,
      init,
      correlation,
      endpoint,
      async (response) => {
        await response.arrayBuffer();
      },
      deadlineMs
    );
  }

  private parseJson<T>(schema: z.ZodType<T>, text: string, status: number, endpoint: string): T {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new VercelSandboxApiError(
        `Vercel Sandbox API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        status,
        text
      );
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new VercelSandboxApiError(
        `Vercel Sandbox API returned an invalid ${endpoint} response: ${z.prettifyError(parsed.error)}`,
        status,
        text
      );
    }
    return parsed.data;
  }

  private requestCommandStream(
    path: string,
    init: RequestInit,
    correlation: CorrelationContext | undefined,
    endpoint: string,
    deadlineMs: number
  ): Promise<VercelCommandResult> {
    return this.send(path, init, correlation, endpoint, parseCommandNdjsonStream, deadlineMs);
  }

  private async send<T>(
    path: string,
    init: RequestInit,
    correlation: CorrelationContext | undefined,
    endpoint: string,
    consume: (response: Response) => T | Promise<T>,
    deadlineMs: number
  ): Promise<T> {
    const startTime = Date.now();
    let httpStatus: number | undefined;
    let outcome: "success" | "error" = "error";

    try {
      const url = this.buildUrl(path);
      const headers = this.buildHeaders(init, correlation);
      const result = await withRequestDeadline(
        "Vercel Sandbox",
        endpoint,
        deadlineMs,
        init.signal,
        async (signal) => {
          const response = await fetch(url.toString(), { ...init, headers, signal });
          httpStatus = response.status;

          if (!response.ok) {
            const text = await readResponseText(response);
            throw new VercelSandboxApiError(
              `Vercel Sandbox API error: ${response.status} ${text}`,
              response.status,
              text
            );
          }

          return await consume(response);
        }
      );
      outcome = "success";
      return result;
    } finally {
      log.info("vercel_sandbox.request", {
        event: "vercel_sandbox.request",
        endpoint,
        trace_id: correlation?.trace_id,
        request_id: correlation?.request_id,
        http_status: httpStatus,
        duration_ms: Date.now() - startTime,
        outcome,
      });
    }
  }

  private buildUrl(path: string): URL {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    if (this.config.teamId) {
      url.searchParams.set("teamId", this.config.teamId);
    }
    return url;
  }

  private buildHeaders(init: RequestInit, correlation?: CorrelationContext): Headers {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.config.token}`);
    headers.set("Content-Type", headers.get("Content-Type") || "application/json");
    headers.set("User-Agent", USER_AGENT);
    if (correlation?.trace_id) headers.set("x-trace-id", correlation.trace_id);
    if (correlation?.request_id) headers.set("x-request-id", correlation.request_id);
    if (correlation?.session_id) headers.set("x-session-id", correlation.session_id);
    if (correlation?.sandbox_id) headers.set("x-sandbox-id", correlation.sandbox_id);
    return headers;
  }
}

function parseCommandNdjson(text: string, status: number): VercelCommandResult {
  let commandId = "";
  let exitCode: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const command = parseCommandLine(line);
    if (!command) continue;
    if (command.commandId) commandId = command.commandId;
    if (command.exitCode !== undefined) exitCode = command.exitCode;
  }

  if (!commandId) {
    throw new VercelSandboxApiError(
      "Vercel command stream did not include a command id",
      status,
      text
    );
  }

  return { commandId, exitCode };
}

async function parseCommandNdjsonStream(response: Response): Promise<VercelCommandResult> {
  if (!response.body) {
    return parseCommandNdjson(await response.text(), response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseExcerpt = "";
  let commandId = "";
  let exitCode: number | null = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (responseExcerpt.length < 4096) {
      responseExcerpt += `${trimmed}\n`;
    }
    const command = parseCommandLine(trimmed);
    if (!command) return;
    if (command.commandId) commandId = command.commandId;
    if (command.exitCode !== undefined) exitCode = command.exitCode;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }

  buffer += decoder.decode();
  consumeLine(buffer);

  if (!commandId) {
    throw new VercelSandboxApiError(
      "Vercel command stream did not include a command id",
      response.status,
      responseExcerpt
    );
  }

  return { commandId, exitCode };
}

function parseCommandLine(line: string): { commandId?: string; exitCode?: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("command" in parsed)) return null;
  const command = (parsed as { command?: { id?: unknown; exitCode?: unknown } }).command;
  if (!command) return null;
  const result: { commandId?: string; exitCode?: number | null } = {};
  if (typeof command.id === "string") result.commandId = command.id;
  if (typeof command.exitCode === "number" || command.exitCode === null) {
    result.exitCode = command.exitCode;
  }
  return result;
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createVercelSandboxClient(config: VercelSandboxClientConfig): VercelSandboxClient {
  return new VercelSandboxClient(config);
}

function buildQueryPath(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}
