/**
 * Daytona shim service client.
 *
 * The control plane talks to Daytona through a thin HTTP service because the
 * published TypeScript SDK does not bundle for the Worker target used here.
 */

import { generateInternalToken, type SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../logger";
import type { CorrelationContext } from "../logger";

const log = createLogger("daytona-service-client");

export interface DaytonaCreateSandboxRequest {
  sessionId: string;
  sandboxId: string;
  repoOwner: string;
  repoName: string;
  controlPlaneUrl: string;
  sandboxAuthToken: string;
  provider: string;
  model: string;
  userEnvVars?: Record<string, string>;
  timeoutSeconds?: number;
  branch?: string;
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings;
}

export interface DaytonaCreateSandboxResponse {
  sandboxId: string;
  providerObjectId: string;
  status: string;
  createdAt: number;
  codeServerUrl?: string;
  codeServerPassword?: string;
  tunnelUrls?: Record<string, string>;
}

export interface DaytonaResumeSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  sandboxId: string;
  timeoutSeconds?: number;
  codeServerEnabled?: boolean;
  sandboxSettings?: SandboxSettings;
}

export interface DaytonaResumeSandboxResponse {
  success: boolean;
  providerObjectId?: string;
  error?: string;
  shouldSpawnFresh?: boolean;
  codeServerUrl?: string;
  codeServerPassword?: string;
  tunnelUrls?: Record<string, string>;
}

export interface DaytonaStopSandboxRequest {
  providerObjectId: string;
  sessionId: string;
  reason: string;
}

export interface DaytonaStopSandboxResponse {
  success: boolean;
  error?: string;
}

interface ServiceEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class DaytonaServiceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "DaytonaServiceApiError";
  }
}

/**
 * Minimal HTTP client for the Daytona shim service.
 */
export class DaytonaServiceClient {
  private readonly healthUrl: string;
  private readonly createSandboxUrl: string;
  private readonly resumeSandboxUrl: string;
  private readonly stopSandboxUrl: string;

  constructor(
    private readonly serviceUrl: string,
    private readonly secret: string
  ) {
    if (!serviceUrl) {
      throw new Error("DaytonaServiceClient requires DAYTONA_SERVICE_URL");
    }

    if (!secret) {
      throw new Error("DaytonaServiceClient requires DAYTONA_SERVICE_SECRET");
    }

    const baseUrl = serviceUrl.replace(/\/+$/, "");
    this.healthUrl = `${baseUrl}/health`;
    this.createSandboxUrl = `${baseUrl}/api/create-sandbox`;
    this.resumeSandboxUrl = `${baseUrl}/api/resume-sandbox`;
    this.stopSandboxUrl = `${baseUrl}/api/stop-sandbox`;
  }

  private async buildHeaders(correlation?: CorrelationContext): Promise<Record<string, string>> {
    const token = await generateInternalToken(this.secret);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    if (correlation?.trace_id) headers["x-trace-id"] = correlation.trace_id;
    if (correlation?.request_id) headers["x-request-id"] = correlation.request_id;
    if (correlation?.session_id) headers["x-session-id"] = correlation.session_id;
    if (correlation?.sandbox_id) headers["x-sandbox-id"] = correlation.sandbox_id;

    return headers;
  }

  private async post<TRequest, TResponse>(
    url: string,
    request: TRequest,
    correlation?: CorrelationContext
  ): Promise<TResponse> {
    const headers = await this.buildHeaders(correlation);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new DaytonaServiceApiError(bodyText || response.statusText, response.status);
    }

    const payload = (await response.json()) as ServiceEnvelope<TResponse>;
    if (!payload.success || !payload.data) {
      throw new DaytonaServiceApiError(payload.error || "Daytona service request failed", 502);
    }

    return payload.data;
  }

  async health(correlation?: CorrelationContext): Promise<Response> {
    const response = await fetch(this.healthUrl, {
      headers: await this.buildHeaders(correlation),
    });
    return response;
  }

  async createSandbox(
    request: DaytonaCreateSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<DaytonaCreateSandboxResponse> {
    const startTime = Date.now();

    try {
      return await this.post(this.createSandboxUrl, request, correlation);
    } finally {
      log.info("daytona_service.create_sandbox", {
        duration_ms: Date.now() - startTime,
        session_id: correlation?.session_id,
        sandbox_id: request.sandboxId,
      });
    }
  }

  async resumeSandbox(
    request: DaytonaResumeSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<DaytonaResumeSandboxResponse> {
    return this.post(this.resumeSandboxUrl, request, correlation);
  }

  async stopSandbox(
    request: DaytonaStopSandboxRequest,
    correlation?: CorrelationContext
  ): Promise<DaytonaStopSandboxResponse> {
    return this.post(this.stopSandboxUrl, request, correlation);
  }
}

export function createDaytonaServiceClient(
  serviceUrl: string,
  secret: string
): DaytonaServiceClient {
  return new DaytonaServiceClient(serviceUrl, secret);
}
