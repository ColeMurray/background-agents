import {
  SESSION_DIFF_MAX_PATCH_BYTES,
  diffCaptureCompleteRequestSchema,
  diffCaptureFailureRequestSchema,
} from "@open-inspect/shared";
import { SessionInternalPaths } from "../session/contracts";
import { createMediaObjectStorage } from "../storage/object-storage";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import type { Env } from "../types";

const DIFF_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function routeId(match: RegExpMatchArray, name: string): string | null {
  const value = match.groups?.[name];
  return value && DIFF_ID_PATTERN.test(value) ? value : null;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
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

async function runtimeJson(
  ctx: SessionRouteContext,
  sessionId: string,
  path: (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths],
  body: unknown,
  search?: string
): Promise<Response> {
  return ctx.sessionRuntime.fetch(
    sessionId,
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    search
  );
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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

async function handleDiffPatchUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const captureId = routeId(match, "captureId");
  const fileId = routeId(match, "fileId");
  if (!sessionId || !captureId || !fileId) return error("Invalid diff object identity", 400);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("text/x-diff")) {
    return error("Diff patches must use text/x-diff", 415);
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > SESSION_DIFF_MAX_PATCH_BYTES) {
    return error(`Diff patches must be ${SESSION_DIFF_MAX_PATCH_BYTES} bytes or smaller`, 413);
  }
  const bytes = await readBoundedBody(request, SESSION_DIFF_MAX_PATCH_BYTES);
  if (!bytes || bytes.byteLength === 0) {
    return error(
      bytes
        ? "Diff patch is empty"
        : `Diff patches must be ${SESSION_DIFF_MAX_PATCH_BYTES} bytes or smaller`,
      bytes ? 400 : 413
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const staged = await runtimeJson(ctx, sessionId, SessionInternalPaths.diffStageObject, {
    captureId,
    fileId,
    sizeBytes: bytes.byteLength,
    sha256,
  });
  if (!staged.ok)
    return new Response(staged.body, { status: staged.status, headers: staged.headers });
  const { objectKey } = await staged.json<{ objectKey: string }>();
  const storage = createMediaObjectStorage(env);
  try {
    await storage.put(objectKey, bytes, { contentType: "text/x-diff; charset=utf-8" });
  } catch {
    await runtimeJson(ctx, sessionId, SessionInternalPaths.diffAbandonObject, {
      captureId,
      fileId,
    });
    return error("Failed to persist diff patch", 500);
  }
  const committed = await runtimeJson(ctx, sessionId, SessionInternalPaths.diffCommitObject, {
    captureId,
    fileId,
  });
  if (!committed.ok) {
    await storage.delete(objectKey);
    await runtimeJson(ctx, sessionId, SessionInternalPaths.diffAbandonObject, {
      captureId,
      fileId,
    });
    return error("Diff capture is no longer active", committed.status);
  }
  return new Response(null, { status: 201 });
}

async function handleDiffComplete(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const captureId = routeId(match, "captureId");
  if (!sessionId || !captureId) return error("Invalid diff capture identity", 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = diffCaptureCompleteRequestSchema.safeParse(body);
  if (!parsed.success) return error("Invalid diff capture manifest", 400);
  const response = await runtimeJson(
    ctx,
    sessionId,
    SessionInternalPaths.diffComplete,
    parsed.data,
    `?captureId=${encodeURIComponent(captureId)}`
  );
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function handleDiffFailed(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const captureId = routeId(match, "captureId");
  if (!sessionId || !captureId) return error("Invalid diff capture identity", 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = diffCaptureFailureRequestSchema.safeParse(body);
  if (!parsed.success) return error("Invalid diff capture failure", 400);
  const response = await runtimeJson(
    ctx,
    sessionId,
    SessionInternalPaths.diffFailed,
    parsed.data,
    `?captureId=${encodeURIComponent(captureId)}`
  );
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function handleDiffFile(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const revisionId = routeId(match, "revisionId");
  const fileId = routeId(match, "fileId");
  if (!sessionId || !revisionId || !fileId) return error("Invalid diff file identity", 400);
  const resolved = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.diffResolveFile,
    undefined,
    `?revisionId=${encodeURIComponent(revisionId)}&fileId=${encodeURIComponent(fileId)}`
  );
  if (!resolved.ok) {
    return new Response(resolved.body, {
      status: resolved.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }
  const { objectKey, patchBytes } = await resolved.json<{
    objectKey: string;
    patchBytes: number;
  }>();
  const object = await createMediaObjectStorage(env).get(objectKey);
  if (!object) return error("Diff patch not found", 404);
  const headers = new Headers({
    "Content-Type": "text/x-diff; charset=utf-8",
    "Content-Length": String(patchBytes),
    "Cache-Control": "private, no-store",
    ETag: object.httpEtag,
  });
  return new Response(object.body, { headers });
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
    pattern: parsePattern("/sessions/:id/diff-captures/:captureId/files/:fileId"),
    handler: handleDiffPatchUpload,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/diff-captures/:captureId/complete"),
    handler: handleDiffComplete,
  }),
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/diff-captures/:captureId/failed"),
    handler: handleDiffFailed,
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
