/** Sandbox-token authentication: the session's Durable Object verifies the bearer it issued. */

import type { RequestContext } from "../http/request-context";
import { error } from "../http/responses";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";

const logger = createLogger("router");

export function parseVerifiedSandboxId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("sandboxId" in value)) return null;
  const sandboxId = value.sandboxId;
  return typeof sandboxId === "string" && sandboxId ? sandboxId : null;
}

async function verifySandboxAuth(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return error("Unauthorized: Missing sandbox token", 401);
  }

  const token = authHeader.slice(7);
  const verifyResponse = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.verifySandboxToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }
  );

  if (!verifyResponse.ok) {
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    logger.warn("Auth failed: sandbox", {
      event: "auth.sandbox_failed",
      http_path: new URL(request.url).pathname,
      client_ip: clientIP,
      session_id: sessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized: Invalid sandbox token", 401);
  }

  let sandboxId: string | null = null;
  try {
    sandboxId = parseVerifiedSandboxId(await verifyResponse.json());
  } catch {
    sandboxId = null;
  }
  ctx.principal = { kind: "sandbox", sessionId, sandboxId };
  return null;
}

/**
 * Verify the request's sandbox token for `sessionId`, setting the sandbox principal on success.
 * Returns the refusal to answer with, or null once verified; an unreachable verifier is a 503.
 */
export async function verifySandboxAuthSafely(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: RequestContext
): Promise<Response | null> {
  try {
    return await verifySandboxAuth(request, env, sessionId, ctx);
  } catch (cause) {
    logger.error("Sandbox authentication unavailable", {
      event: "auth.sandbox_unavailable",
      session_id: sessionId,
      error: cause instanceof Error ? cause : String(cause),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Sandbox authentication unavailable", 503);
  }
}
