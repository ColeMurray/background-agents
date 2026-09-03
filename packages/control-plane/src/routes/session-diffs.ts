import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  SESSION_DIFF_FAILURE_BODY_MAX_BYTES,
  SESSION_DIFF_ID_PATTERN,
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  sessionDiffFailureSchema,
  sessionDiffUploadSchema,
} from "@open-inspect/shared/types/session-diffs";
import { SessionInternalPaths } from "../session/contracts";
import {
  error,
  SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  requirePermission,
} from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";
import type { Env } from "../types";

export const SESSION_DIFF_UPLOAD_BODY_MAX_BYTES = SESSION_DIFF_MAX_BUNDLE_BYTES;

function routeId(params: Record<string, string>, name: string): string | null {
  const value = params[name];
  return value && SESSION_DIFF_ID_PATTERN.test(value) ? value : null;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body limit exceeded");
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
  bodyName: string
): Promise<unknown | Response> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (!bytes) return error(`${bodyName} must be ${maxBytes} bytes or smaller`, 413);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return error("Invalid JSON body", 400);
  }
}

async function runtimeJson(
  ctx: SessionRouteContext,
  sessionId: string,
  path: (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths],
  body: unknown
): Promise<Response> {
  return ctx.sessionRuntime.fetch(sessionId, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function handleDiffState(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.diffState);
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to load session changes", response.status);
  }
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

export async function handleDiffUpload(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const body = await readBoundedJson(
    request,
    SESSION_DIFF_UPLOAD_BODY_MAX_BYTES,
    "Session diff bundles"
  );
  if (body instanceof Response) return body;
  const parsed = sessionDiffUploadSchema.safeParse(body);
  if (!parsed.success) return error("Invalid session diff bundle", 400);
  const response = await runtimeJson(ctx, sessionId, SessionInternalPaths.diffStore, parsed.data);
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export async function handleDiffFailure(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const body = await readBoundedJson(
    request,
    SESSION_DIFF_FAILURE_BODY_MAX_BYTES,
    "Session diff failure bodies"
  );
  if (body instanceof Response) return body;
  const parsed = sessionDiffFailureSchema.safeParse(body);
  if (!parsed.success) return error("Invalid session diff failure", 400);
  const response = await runtimeJson(ctx, sessionId, SessionInternalPaths.diffFailure, parsed.data);
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export async function handleDiffFile(
  _request: Request,
  _env: Env,
  params: { id: string; revisionId: string; fileId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const revisionId = routeId(params, "revisionId");
  const fileId = routeId(params, "fileId");
  if (!sessionId || !revisionId || !fileId) return error("Invalid diff file identity", 400);
  const response = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.diffResolveFile,
    undefined,
    `?revisionId=${encodeURIComponent(revisionId)}&fileId=${encodeURIComponent(fileId)}`
  );
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleDiffRetry(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  if (!sessionId) return error("Session ID required", 400);
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.diffRetry, {
    method: "POST",
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

/**
 * Session-diff HTTP routes exposed by the control-plane worker.
 *
 * The central router requires internal HMAC authentication for reads and retry.
 * Only bundle upload and failure reporting additionally accept the per-session
 * sandbox token; the Session DO validates that token before these handlers run.
 */
export const sessionDiffRoutes = new Hono<ControlPlaneHonoEnv>();

const DIFF_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("sessions.read"),
});
const DIFF_WRITE = admit({
  ...SCM_AGNOSTIC_SANDBOX_FALLBACK_ROUTE,
  authorization: requirePermission("sessions.collaborate"),
});

sessionDiffRoutes.get("/sessions/:id/diff", DIFF_READ, (c) => dispatchSession(c, handleDiffState));
sessionDiffRoutes.put("/sessions/:id/diff", DIFF_WRITE, (c) =>
  dispatchSession(c, handleDiffUpload)
);
sessionDiffRoutes.post("/sessions/:id/diff/failure", DIFF_WRITE, (c) =>
  dispatchSession(c, handleDiffFailure)
);
sessionDiffRoutes.get("/sessions/:id/diff/:revisionId/files/:fileId", DIFF_READ, (c) =>
  dispatchSession(c, handleDiffFile)
);
sessionDiffRoutes.post(
  "/sessions/:id/diff/retry",
  admit({
    ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.lifecycle"),
  }),
  (c) => dispatchSession(c, handleDiffRetry)
);
