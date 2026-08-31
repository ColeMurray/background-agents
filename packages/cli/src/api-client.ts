import {
  cliDeviceAuthorizationExchangeResponseSchema,
  cliMeResponseSchema,
  CLI_EXTERNAL_API_V1_PATH,
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
  externalSessionListResponseSchema,
  externalSessionSchema,
  externalStopSessionResponseSchema,
  externalSessionWaitResponseSchema,
  type ExternalCreateSessionRequest,
  type ExternalFollowUpRequest,
  type ExternalEventFeedQuery,
  type ExternalSession,
} from "@open-inspect/shared/types/external-session-api";
import type { z } from "zod";
import { CliError } from "./errors.js";

const SESSIONS_PATH = "/external/v1/sessions";
const MAX_SUCCESS_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
export type EventPage = z.infer<typeof externalEventPageSchema>;
export type EventQuery = ExternalEventFeedQuery & { signal?: AbortSignal };

export interface ApiClientOptions {
  baseUrl: string;
  authorize?: () => Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

/** Typed external API transport shared by CLI commands and MCP operations. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly authorize: () => Promise<string | undefined>;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authorize = options.authorize ?? (() => Promise.resolve(undefined));
    this.fetch = options.fetch ?? globalThis.fetch;
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

  async me(signal?: AbortSignal): Promise<CliMeResponse> {
    return cliMeResponseSchema.parse(
      await this.request(`${CLI_EXTERNAL_API_V1_PATH}/me`, { signal })
    );
  }

  async revokeCredential(): Promise<void> {
    await this.request(`${CLI_EXTERNAL_API_V1_PATH}/credentials/current`, { method: "DELETE" });
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
    signal?: AbortSignal
  ): Promise<z.infer<typeof externalSessionListResponseSchema>> {
    return externalSessionListResponseSchema.parse(await this.request(SESSIONS_PATH, { signal }));
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
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
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
}

export class ApiError extends CliError {
  constructor(status: number, detail: string) {
    super(errorKindForStatus(status), `API request failed (${status}): ${detail}`, status);
    this.name = "ApiError";
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    const body = await readBounded(response, MAX_ERROR_BYTES).catch(() => "");
    let detail = response.statusText || "Request failed";
    if (body) {
      try {
        const parsed = externalApiErrorResponseSchema.safeParse(JSON.parse(body));
        if (parsed.success) detail = parsed.data.error;
      } catch {
        // Non-JSON error bodies are intentionally ignored.
      }
    }
    return new ApiError(response.status, safeApiDetail(detail));
  }
}

function errorKindForStatus(status: number): CliError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service";
  if (status === 400 || status === 422) return "validation";
  if (status === 409) return "conflict";
  return "general";
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
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
  return new TextDecoder().decode(body);
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
