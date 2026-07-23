import type { CorrelationContext } from "../logger";
import type { Env } from "../types";
import { buildSessionInternalUrl, type SessionInternalPath } from "./contracts";

export interface SessionRuntimeClient {
  fetch(
    sessionId: string,
    path: SessionInternalPath,
    init?: RequestInit,
    search?: string
  ): Promise<Response>;
}

export class CloudflareSessionRuntimeClient implements SessionRuntimeClient {
  constructor(
    private readonly env: Env,
    private readonly ctx: CorrelationContext
  ) {}

  fetch(
    sessionId: string,
    path: SessionInternalPath,
    init?: RequestInit,
    search?: string
  ): Promise<Response> {
    const doId = this.env.SESSION.idFromName(sessionId);
    const stub = this.env.SESSION.get(doId);
    return stub.fetch(this.internalRequest(buildSessionInternalUrl(path, search), init));
  }

  private internalRequest(url: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("x-trace-id", this.ctx.trace_id);
    headers.set("x-request-id", this.ctx.request_id);
    return new Request(url, { ...init, headers });
  }
}

export function createSessionRuntimeClient(
  env: Env,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return new CloudflareSessionRuntimeClient(env, ctx);
}
