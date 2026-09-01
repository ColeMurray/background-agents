import {
  cliDeviceAuthorizationExchangeResponseSchema,
  cliMeResponseSchema,
  CLI_API_VERSION_HEADER,
  CLI_CLIENT_SURFACE_HEADER,
  CLI_CLIENT_VERSION_HEADER,
  CLI_EXTERNAL_API_V1_PATH,
  CLI_EXTERNAL_API_VERSION,
  revokeCliDeviceAuthorizationRequestSchema,
  startCliDeviceAuthorizationResponseSchema,
  type CliDeviceAuthorizationExchangeResponse,
  type CliMeResponse,
  type StartCliDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/cli-auth";
import {
  externalApiErrorResponseSchema,
  externalCreateSessionRequestSchema,
  externalCreateSessionResponseSchema,
  externalEventPageSchema,
  externalEventFeedQuerySchema,
  externalFollowUpRequestSchema,
  externalFollowUpResponseSchema,
  externalSessionListQuerySchema,
  externalSessionListResponseSchema,
  externalSessionSchema,
  externalStopSessionResponseSchema,
  externalSessionWaitResponseSchema,
  type ExternalCreateSessionRequest,
  type ExternalFollowUpRequest,
  type ExternalEventFeedQuery,
  type ExternalSessionListQuery,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import {
  externalArtifactListResponseSchema,
  externalArtifactContentResponseSchema,
  externalDiffContentResponseSchema,
  externalDiffStateResponseSchema,
  externalPullRequestSchema,
  externalChildPromptRequestSchema,
  externalChildSessionListResponseSchema,
  externalChildSessionSchema,
  externalEnvironmentListResponseSchema,
  externalEnvironmentResponseSchema,
  externalDiffListQuerySchema,
  externalKeysetListQuerySchema,
  externalListQuerySchema,
  externalMessageListResponseSchema,
  externalModelListResponseSchema,
  externalProviderAccountListResponseSchema,
  externalPullRequestListResponseSchema,
  externalRepositoryListResponseSchema,
  externalSkillListResponseSchema,
  type ExternalListQuery,
  type ExternalDiffListQuery,
  type ExternalKeysetListQuery,
} from "@open-inspect/shared/types/external-resources-api";
import { sessionAttachmentUploadResponseSchema } from "@open-inspect/shared/types/session-attachments";
import type { z } from "zod";
import { CliError } from "./errors.js";

const SESSIONS_PATH = "/external/v1/sessions";
const EXTERNAL_PATH = "/external/v1";
const MAX_SUCCESS_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_ARTIFACT_CHUNK_BYTES = 512 * 1024;
export type EventPage = z.infer<typeof externalEventPageSchema>;
export type EventQuery = ExternalEventFeedQuery & { signal?: AbortSignal };

export interface ApiClientOptions {
  baseUrl: string;
  authorize?: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  clientSurface?: "cli" | "mcp";
}

/** Typed external API transport shared by CLI commands and MCP operations. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly authorize: () => Promise<string | undefined>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly clientSurface: "cli" | "mcp";

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authorize = options.authorize ?? (() => Promise.resolve(undefined));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clientSurface = options.clientSurface ?? "cli";
  }

  async startDeviceAuthorization(deviceName: string): Promise<StartCliDeviceAuthorizationResponse> {
    return startCliDeviceAuthorizationResponseSchema.parse(
      await this.request(
        `${CLI_EXTERNAL_API_V1_PATH}/device-authorizations`,
        {
          method: "POST",
          body: JSON.stringify({ deviceName }),
        },
        false
      )
    );
  }

  async exchangeDeviceAuthorization(
    deviceSecret: string
  ): Promise<CliDeviceAuthorizationExchangeResponse> {
    return cliDeviceAuthorizationExchangeResponseSchema.parse(
      await this.request(
        `${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/exchange`,
        {
          method: "POST",
          body: JSON.stringify({ deviceSecret }),
        },
        false
      )
    );
  }

  async revokeDeviceAuthorization(deviceSecret: string): Promise<void> {
    await this.request(
      `${CLI_EXTERNAL_API_V1_PATH}/device-authorizations/revoke`,
      {
        method: "POST",
        body: JSON.stringify(revokeCliDeviceAuthorizationRequestSchema.parse({ deviceSecret })),
      },
      false
    );
  }

  async me(signal?: AbortSignal): Promise<CliMeResponse> {
    return cliMeResponseSchema.parse(
      await this.request(`${CLI_EXTERNAL_API_V1_PATH}/me`, { signal })
    );
  }

  async revokeCredential(): Promise<void> {
    await this.request(`${CLI_EXTERNAL_API_V1_PATH}/credentials/current`, { method: "DELETE" });
  }

  async listRepositories(options: ExternalListQuery = {}) {
    return externalRepositoryListResponseSchema.parse(
      await this.request(`${EXTERNAL_PATH}/repositories${listSuffix(options)}`)
    );
  }

  async listEnvironments(options: ExternalListQuery = {}) {
    return externalEnvironmentListResponseSchema.parse(
      await this.request(`${EXTERNAL_PATH}/environments${listSuffix(options)}`)
    );
  }

  async getEnvironment(id: string) {
    return externalEnvironmentResponseSchema.parse(
      await this.request(`${EXTERNAL_PATH}/environments/${encodeURIComponent(id)}`)
    );
  }

  async listModels() {
    return externalModelListResponseSchema.parse(await this.request(`${EXTERNAL_PATH}/models`));
  }

  async listSkills(options: ExternalListQuery = {}) {
    return externalSkillListResponseSchema.parse(
      await this.request(`${EXTERNAL_PATH}/skills${listSuffix(options)}`)
    );
  }

  async listProviderAccounts(options: ExternalListQuery = {}) {
    return externalProviderAccountListResponseSchema.parse(
      await this.request(`${EXTERNAL_PATH}/provider-accounts${listSuffix(options)}`)
    );
  }

  async createSession(
    input: ExternalCreateSessionRequest
  ): Promise<z.infer<typeof externalCreateSessionResponseSchema>> {
    return externalCreateSessionResponseSchema.parse(
      await this.request(SESSIONS_PATH, {
        method: "POST",
        body: JSON.stringify(externalCreateSessionRequestSchema.parse(input)),
      })
    );
  }

  async listSessions(
    options: ExternalSessionListQuery & { signal?: AbortSignal } = {}
  ): Promise<z.infer<typeof externalSessionListResponseSchema>> {
    const { signal, ...queryOptions } = options;
    const parsed = externalSessionListQuerySchema.parse(queryOptions);
    const query = new URLSearchParams();
    if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
    if (parsed.offset !== undefined) query.set("offset", String(parsed.offset));
    if (parsed.status !== undefined) query.set("status", parsed.status);
    if (parsed.excludeStatus !== undefined) query.set("excludeStatus", parsed.excludeStatus);
    if (parsed.excludeAutomationLineage !== undefined) {
      query.set("excludeAutomationLineage", String(parsed.excludeAutomationLineage));
    }
    if (parsed.createdBy !== undefined) query.set("createdBy", parsed.createdBy);
    const suffix = query.size ? `?${query}` : "";
    return externalSessionListResponseSchema.parse(
      await this.request(`${SESSIONS_PATH}${suffix}`, { signal })
    );
  }

  async getSession(id: string, signal?: AbortSignal): Promise<ExternalSession> {
    return externalSessionSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}`, { signal })
    );
  }

  async promptSession(
    id: string,
    input: ExternalFollowUpRequest
  ): Promise<z.infer<typeof externalFollowUpResponseSchema>> {
    return externalFollowUpResponseSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify(externalFollowUpRequestSchema.parse(input)),
      })
    );
  }

  async uploadAttachment(id: string, file: Blob, name: string, idempotencyKey?: string) {
    const form = new FormData();
    form.set("file", file, name);
    return sessionAttachmentUploadResponseSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}/attachments`, {
        method: "POST",
        body: form,
        ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
      })
    );
  }

  async messages(id: string, options: { limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return externalMessageListResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/messages${query.size ? `?${query}` : ""}`
      )
    );
  }

  async artifacts(id: string, options: ExternalKeysetListQuery = {}) {
    return externalArtifactListResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/artifacts${keysetListSuffix(options)}`
      )
    );
  }

  async artifactContent(
    id: string,
    artifactId: string,
    options: { offset?: number; limit?: number } = {}
  ) {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? DEFAULT_ARTIFACT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DEFAULT_ARTIFACT_CHUNK_BYTES
    ) {
      throw new CliError("validation", "Artifact offset/limit is invalid");
    }
    const response = await this.requestRaw(
      `${SESSIONS_PATH}/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/content`,
      {
        headers: {
          Accept: "image/*,video/*",
          Range: `bytes=${offset}-${offset + limit - 1}`,
        },
      }
    );
    const bytes = await readBoundedBytes(response, DEFAULT_ARTIFACT_CHUNK_BYTES);
    const contentRange = response.headers.get("Content-Range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const total = contentRange ? Number(contentRange[3]) : offset + bytes.byteLength;
    const continuationOffset = offset + bytes.byteLength;
    return externalArtifactContentResponseSchema.parse({
      contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
      contentBase64: Buffer.from(bytes).toString("base64"),
      offset,
      hasMore: continuationOffset < total,
      ...(continuationOffset < total ? { continuationOffset } : {}),
    });
  }

  async diff(id: string, options: ExternalDiffListQuery = {}) {
    return externalDiffStateResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/diff${diffListSuffix(options)}`
      )
    );
  }

  async diffFile(
    id: string,
    revisionId: string,
    fileId: string,
    options: { offset?: number; limit?: number } = {}
  ) {
    const query = new URLSearchParams();
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return externalDiffContentResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/diff/${encodeURIComponent(revisionId)}/files/${encodeURIComponent(fileId)}${query.size ? `?${query}` : ""}`
      )
    );
  }

  async pullRequests(id: string, options: ExternalListQuery = {}) {
    return externalPullRequestListResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/pull-requests${listSuffix(options)}`
      )
    );
  }

  async pullRequest(id: string, pullRequestId: string) {
    return externalPullRequestSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/pull-requests/${encodeURIComponent(pullRequestId)}`
      )
    );
  }

  async children(id: string, options: ExternalListQuery = {}) {
    return externalChildSessionListResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/children${listSuffix(options)}`
      )
    );
  }

  async child(id: string, childId: string) {
    return externalChildSessionSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/children/${encodeURIComponent(childId)}`
      )
    );
  }

  async promptChild(
    id: string,
    childId: string,
    input: z.infer<typeof externalChildPromptRequestSchema>
  ) {
    return externalFollowUpResponseSchema.parse(
      await this.request(
        `${SESSIONS_PATH}/${encodeURIComponent(id)}/children/${encodeURIComponent(childId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify(externalChildPromptRequestSchema.parse(input)),
        }
      )
    );
  }

  async stopSession(id: string): Promise<z.infer<typeof externalStopSessionResponseSchema>> {
    return externalStopSessionResponseSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}/stop`, { method: "POST" })
    );
  }

  async events(id: string, options: EventQuery = {}): Promise<EventPage> {
    const { signal, ...queryOptions } = options;
    const parsed = externalEventFeedQuerySchema.parse(queryOptions);
    const query = new URLSearchParams();
    if (parsed.after !== undefined) query.set("after", String(parsed.after));
    if (parsed.cursor) query.set("cursor", parsed.cursor);
    if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
    const suffix = query.size ? `?${query}` : "";
    return externalEventPageSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}/events${suffix}`, {
        signal,
      })
    );
  }

  async waitStatus(
    id: string,
    signal?: AbortSignal
  ): Promise<z.infer<typeof externalSessionWaitResponseSchema>> {
    return externalSessionWaitResponseSchema.parse(
      await this.request(`${SESSIONS_PATH}/${encodeURIComponent(id)}/wait`, { signal })
    );
  }

  private async request(
    path: string,
    init: RequestInit = {},
    authenticated = true
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set(CLI_API_VERSION_HEADER, CLI_EXTERNAL_API_VERSION);
    headers.set(CLI_CLIENT_VERSION_HEADER, "0.1.0");
    headers.set(CLI_CLIENT_SURFACE_HEADER, this.clientSurface);
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    if (authenticated) {
      const credential = await this.authorize();
      if (!credential) throw new CliError("auth", "Authentication required");
      headers.set("Authorization", `Bearer ${credential}`);
    }

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      if (init.signal?.aborted)
        throw new CliError("timeout", "API request was aborted", undefined, undefined, { cause });
      throw new CliError("transport", "API request failed", undefined, undefined, {
        cause,
      });
    }
    if (!response.ok) throw await ApiError.fromResponse(response);
    if (response.status === 204) return undefined;
    return parseJson(await readBounded(response, MAX_SUCCESS_BYTES), "API response");
  }

  private async requestRaw(path: string, init: RequestInit = {}): Promise<Response> {
    const credential = await this.authorize();
    if (!credential) throw new CliError("auth", "Authentication required");
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${credential}`);
      headers.set(CLI_API_VERSION_HEADER, CLI_EXTERNAL_API_VERSION);
      headers.set(CLI_CLIENT_VERSION_HEADER, "0.1.0");
      headers.set(CLI_CLIENT_SURFACE_HEADER, this.clientSurface);
      response = await this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new CliError("transport", "API request failed", undefined, undefined, { cause });
    }
    if (!response.ok) throw await ApiError.fromResponse(response);
    return response;
  }
}

function listSuffix(options: ExternalListQuery): string {
  const parsed = externalListQuerySchema.parse(options);
  const query = new URLSearchParams();
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.offset !== undefined) query.set("offset", String(parsed.offset));
  return query.size ? `?${query}` : "";
}

function keysetListSuffix(options: ExternalKeysetListQuery): string {
  const parsed = externalKeysetListQuerySchema.parse(options);
  const query = new URLSearchParams();
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.cursor !== undefined) query.set("cursor", parsed.cursor);
  return query.size ? `?${query}` : "";
}

function diffListSuffix(options: ExternalDiffListQuery): string {
  const parsed = externalDiffListQuerySchema.parse(options);
  const query = new URLSearchParams();
  if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
  if (parsed.offset !== undefined) query.set("offset", String(parsed.offset));
  if (parsed.revisionId !== undefined) query.set("revisionId", parsed.revisionId);
  return query.size ? `?${query}` : "";
}

export class ApiError extends CliError {
  constructor(status: number, detail: string, context?: Record<string, string>) {
    super(errorKindForStatus(status), `API request failed (${status}): ${detail}`, status, context);
    this.name = "ApiError";
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    const body = await readBounded(response, MAX_ERROR_BYTES).catch(() => "");
    let detail = response.statusText || "Request failed";
    const context: Record<string, string> = {};
    const requestId = response.headers.get("X-Request-ID");
    if (requestId) context.requestId = requestId;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) context.retryAfter = retryAfter;
    if (body) {
      try {
        const parsed = externalApiErrorResponseSchema.safeParse(JSON.parse(body));
        if (parsed.success) {
          detail = parsed.data.error;
          if (parsed.data.code) context.code = parsed.data.code;
          if (parsed.data.requestId) context.requestId = parsed.data.requestId;
          if (parsed.data.permission) context.permission = parsed.data.permission;
        } else {
          const legacy = JSON.parse(body) as { error?: unknown; code?: unknown };
          if (typeof legacy.error === "string") detail = legacy.error;
          if (typeof legacy.code === "string") context.code = legacy.code;
        }
      } catch {
        // Non-JSON error bodies are intentionally ignored.
      }
    }
    return new ApiError(
      response.status,
      safeApiDetail(detail),
      Object.keys(context).length ? context : undefined
    );
  }
}

function errorKindForStatus(status: number): CliError["kind"] {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 408) return "timeout";
  if (status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 426) return "incompatible_client";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  return "general";
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(response, maximumBytes));
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new CliError("transport", `API response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new CliError("transport", `${label} was not valid JSON`, undefined, undefined, { cause });
  }
}

function safeApiDetail(detail: string): string {
  return (
    detail
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 512) || "Request failed"
  );
}
