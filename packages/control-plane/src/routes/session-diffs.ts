import {
  SESSION_DIFF_MAX_BUNDLE_BYTES,
  sessionDiffFailureSchema,
  sessionDiffUploadSchema,
} from "@open-inspect/shared";
import { SessionInternalPaths } from "../session/contracts";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import type { Env } from "../types";

const DIFF_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
export const SESSION_DIFF_UPLOAD_BODY_MAX_BYTES = SESSION_DIFF_MAX_BUNDLE_BYTES;
export const SESSION_DIFF_FAILURE_BODY_MAX_BYTES = 16 * 1_024;

function routeId(match: RegExpMatchArray, name: string): string | null {
  const value = match.groups?.[name];
  return value && DIFF_ID_PATTERN.test(value) ? value : null;
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

async function handleDiffState(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
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

async function handleDiffUpload(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
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

async function handleDiffFailure(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
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

async function handleDiffFile(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const revisionId = routeId(match, "revisionId");
  const fileId = routeId(match, "fileId");
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
    },
  });
}

async function handleDiffRetry(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.diffRetry, {
    method: "POST",
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

export const sessionDiffRoutes: Route[] = [
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/diff"),
    handler: handleDiffState,
  }),
  sessionRoute({
    method: "PUT",
    pattern: parsePattern("/sessions/:id/diff"),
    handler: handleDiffUpload,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/diff/failure"),
    handler: handleDiffFailure,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/diff/:revisionId/files/:fileId"),
    handler: handleDiffFile,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/diff/retry"),
    handler: handleDiffRetry,
  }),
];
