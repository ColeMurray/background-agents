import { listArtifactsResponseSchema } from "@open-inspect/shared/types/artifacts";
import { externalChildPromptRequestSchema } from "@open-inspect/shared/types/external-resources-api";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import {
  SESSION_DIFF_ID_PATTERN,
  sessionDiffStateSchema,
} from "@open-inspect/shared/types/session-diffs";
import { messageSourceSchema } from "@open-inspect/shared/types/sessions";
import { resolvedSessionAttachmentsSchema } from "@open-inspect/shared/types/session-attachments";
import { z } from "zod";
import { SessionIndexStore, type SessionEntry } from "../db/session-index";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "../db/session-pull-request-store";
import { adaptExternalRuntimeFailure } from "../external-api/runtime-response";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import {
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parsePattern,
  requirePermission,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext, type SessionRouteHandler } from "./session-route";
import { handleAttachmentGet, handleAttachmentPost } from "./session-attachments";
import { handleMediaGet } from "./session-media-stream";
import { dispatchSessionPrompt } from "./session-prompt";
import { enforceExternalRateLimit } from "./external-sessions";

const EXTERNAL_SESSION_PATH = "/external/v1/sessions/:id";
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;
const DEFAULT_DIFF_CONTENT_LIMIT_BYTES = 256 * 1024;
const MAX_DIFF_CONTENT_LIMIT_BYTES = 512 * 1024;
const messageStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

const messagePageSchema = z
  .object({
    messages: z.array(
      z.object({
        id: z.string(),
        authorId: z.string(),
        content: z.string(),
        source: messageSourceSchema,
        attachments: resolvedSessionAttachmentsSchema.nullable(),
        status: messageStatusSchema,
        createdAt: z.number(),
        startedAt: z.number().nullable(),
        completedAt: z.number().nullable(),
      })
    ),
    cursor: z.string().min(1).optional(),
    hasMore: z.boolean(),
  })
  .refine((page) => !page.hasMore || page.cursor !== undefined, {
    message: "cursor is required when hasMore is true",
    path: ["cursor"],
  });

const artifactPageSchema = z.object({
  artifacts: listArtifactsResponseSchema.shape.artifacts,
  cursor: z.string().min(1).optional(),
  hasMore: z.boolean(),
});

function offsetPage(request: Request): { limit: number; offset: number } | Response {
  const search = new URL(request.url).searchParams;
  const limit = search.has("limit") ? Number(search.get("limit")) : 50;
  const offset = search.has("offset") ? Number(search.get("offset")) : 0;
  return Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= 100 &&
    Number.isSafeInteger(offset) &&
    offset >= 0
    ? { limit, offset }
    : error("Invalid list pagination", 400);
}

function withStrictQuery(
  handler: SessionRouteHandler,
  allowedNames: readonly string[] = []
): SessionRouteHandler {
  const allowed = new Set(allowedNames);
  return async (request, env, match, ctx) => {
    const seen = new Set<string>();
    for (const name of new URL(request.url).searchParams.keys()) {
      if (!allowed.has(name) || seen.has(name)) return error("Invalid query parameters", 400);
      seen.add(name);
    }
    return handler(request, env, match, ctx);
  };
}

function slicePage<T>(items: T[], options: { limit: number; offset: number }) {
  const values = items.slice(options.offset, options.offset + options.limit);
  const hasMore = options.offset + values.length < items.length;
  return {
    values,
    hasMore,
    ...(hasMore ? { continuationOffset: options.offset + values.length } : {}),
  };
}

function routeId(match: RegExpMatchArray, name: string): string | null {
  const value = match.groups?.[name];
  return value?.trim() ? value : null;
}

async function requireSession(
  ctx: SessionRouteContext,
  sessionId: string
): Promise<SessionEntry | Response> {
  return (await new SessionIndexStore(ctx.db).get(sessionId)) ?? error("Session not found", 404);
}

async function runtimeJson(
  ctx: SessionRouteContext,
  sessionId: string,
  path: (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths],
  search?: string
): Promise<unknown | Response> {
  const response = await ctx.sessionRuntime.fetch(sessionId, path, undefined, search);
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;
  return response.json().catch(() => error("Invalid session runtime response", 502));
}

function pickMetadata(
  metadata: Record<string, unknown> | null,
  keys: readonly string[]
): Record<string, unknown> | null {
  if (!metadata) return null;
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in metadata) projected[key] = metadata[key];
  }
  return projected;
}

function projectArtifactMetadata(
  type: "pr" | "screenshot" | "video" | "preview" | "branch",
  metadata: Record<string, unknown> | null
): Record<string, unknown> | null {
  switch (type) {
    case "pr":
      return pickMetadata(metadata, [
        "number",
        "lifecycleState",
        "isDraft",
        "head",
        "base",
        "headSha",
        "repoOwner",
        "repoName",
        "repositoryExternalId",
        "providerUpdatedAt",
      ]);
    case "screenshot":
      return pickMetadata(metadata, [
        "mimeType",
        "sizeBytes",
        "viewport",
        "sourceUrl",
        "fullPage",
        "annotated",
        "caption",
      ]);
    case "video":
      return pickMetadata(metadata, [
        "mimeType",
        "sizeBytes",
        "caption",
        "durationMs",
        "createdAt",
        "recordingStartedAt",
        "recordingEndedAt",
        "dimensions",
        "truncated",
        "hasAudio",
        "captureSurface",
        "source",
        "sourceUrl",
        "endUrl",
      ]);
    case "branch":
      return pickMetadata(metadata, ["mode", "head", "base", "createPrUrl", "provider"]);
    case "preview":
      return null;
  }
}

function projectSession(session: SessionEntry) {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    repoOwner: session.repoOwner,
    repoName: session.repoName,
    repositories:
      session.repositories ??
      (session.repoOwner && session.repoName
        ? [
            {
              repoOwner: session.repoOwner,
              repoName: session.repoName,
              repoId: null,
              baseBranch: session.baseBranch ?? "",
            },
          ]
        : []),
    environmentId: session.environmentId ?? null,
    parentSessionId: session.parentSessionId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function projectPullRequest(record: SessionPullRequestRecord, provider: string) {
  return {
    id: record.artifactId,
    provider,
    repositoryExternalId: record.repositoryExternalId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    number: record.prNumber,
    url: record.url,
    state: record.isDraft ? "draft" : record.lifecycleState,
    lifecycleState: record.lifecycleState,
    isDraft: record.isDraft,
    headBranch: record.headBranch,
    baseBranch: record.baseBranch,
    headSha: record.headSha,
    providerCreatedAt: record.providerCreatedAt,
    providerUpdatedAt: record.providerUpdatedAt,
    mergedAt: record.mergedAt,
    closedAt: record.closedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function listMessages(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  if (!sessionId) return error("Session ID required", 400);
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_MESSAGE_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_LIMIT) {
    return error(`limit must be an integer between 1 and ${MAX_MESSAGE_LIMIT}`, 400);
  }
  const search = new URLSearchParams({ limit: String(limit) });
  for (const name of ["cursor", "status"] as const) {
    const value = url.searchParams.get(name);
    if (value !== null) search.set(name, value);
  }
  const body = await runtimeJson(ctx, sessionId, SessionInternalPaths.messages, `?${search}`);
  if (body instanceof Response) return body;
  const parsed = messagePageSchema.safeParse(body);
  return parsed.success ? json(parsed.data) : error("Invalid session message response", 502);
}

async function listArtifacts(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  if (!sessionId) return error("Session ID required", 400);
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return error("limit must be an integer between 1 and 100", 400);
  }
  const cursor = url.searchParams.get("cursor");
  const search = `?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`;
  const body = await runtimeJson(ctx, sessionId, SessionInternalPaths.artifacts, search);
  if (body instanceof Response) return body;
  const parsed = artifactPageSchema.safeParse(body);
  if (!parsed.success) return error("Invalid session artifact response", 502);
  return json({
    artifacts: parsed.data.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      url:
        artifact.type === "screenshot" || artifact.type === "video"
          ? `/external/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.id)}/content`
          : artifact.url,
      metadata: projectArtifactMetadata(artifact.type, artifact.metadata),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt ?? artifact.createdAt,
    })),
    hasMore: parsed.data.hasMore,
    ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
  });
}

async function getDiffState(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  if (!sessionId) return error("Session ID required", 400);
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);
  const body = await runtimeJson(ctx, sessionId, SessionInternalPaths.diffState);
  if (body instanceof Response) return body;
  const parsed = sessionDiffStateSchema.safeParse(body);
  if (!parsed.success) return error("Invalid session diff response", 502);
  const url = new URL(request.url);
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  const continuationRevisionId = url.searchParams.get("revisionId");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return error("Invalid diff pagination", 400);
  }
  if (!parsed.data.current) return json({ ...parsed.data, hasMore: false });
  if (offset > 0 && continuationRevisionId === null) {
    return error("revisionId is required for diff continuation", 400);
  }
  if (
    continuationRevisionId !== null &&
    continuationRevisionId !== parsed.data.current.revisionId
  ) {
    return json(
      {
        error: "Diff revision is stale",
        code: "diff_revision_stale",
        currentRevisionId: parsed.data.current.revisionId,
      },
      409
    );
  }
  let remainingOffset = offset;
  let remainingLimit = limit;
  let totalFiles = 0;
  const repositories = parsed.data.current.repositories.map((repository) => {
    if (repository.status !== "ready") return repository;
    totalFiles += repository.files.length;
    const start = Math.min(remainingOffset, repository.files.length);
    remainingOffset -= start;
    const files = repository.files.slice(start, start + remainingLimit);
    remainingLimit -= files.length;
    return { ...repository, files };
  });
  const returned = limit - remainingLimit;
  const hasMore = offset + returned < totalFiles;
  return json({
    ...parsed.data,
    current: { ...parsed.data.current, repositories },
    hasMore,
    ...(hasMore ? { continuationOffset: offset + returned } : {}),
    ...(hasMore ? { continuationRevisionId: parsed.data.current.revisionId } : {}),
  });
}

async function getDiffFile(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  const revisionId = routeId(match, "revisionId");
  const fileId = routeId(match, "fileId");
  if (
    !sessionId ||
    !revisionId ||
    !fileId ||
    !SESSION_DIFF_ID_PATTERN.test(revisionId) ||
    !SESSION_DIFF_ID_PATTERN.test(fileId)
  ) {
    return error("Invalid diff file identity", 400);
  }
  const search = new URL(request.url).searchParams;
  const limit = search.has("limit")
    ? Number(search.get("limit"))
    : DEFAULT_DIFF_CONTENT_LIMIT_BYTES;
  const offset = search.has("offset") ? Number(search.get("offset")) : 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DIFF_CONTENT_LIMIT_BYTES ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return error("Invalid diff content pagination", 400);
  }
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);
  const response = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.diffResolveFile,
    undefined,
    `?revisionId=${encodeURIComponent(revisionId)}&fileId=${encodeURIComponent(fileId)}`
  );
  const runtimeError = adaptExternalRuntimeFailure(response);
  if (runtimeError) return runtimeError;

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (offset > bytes.byteLength) return error("Invalid diff content offset", 400);

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    decoder.decode(bytes);
  } catch {
    return error("Invalid session diff content", 502);
  }
  try {
    decoder.decode(bytes.subarray(0, offset));
  } catch {
    return error("Invalid diff content offset", 400);
  }

  let end = Math.min(offset + limit, bytes.byteLength);
  let content: string | null = null;
  while (content === null && end >= offset) {
    try {
      content = decoder.decode(bytes.subarray(offset, end));
    } catch {
      end -= 1;
    }
  }
  if (content === null) return error("Invalid session diff content", 502);

  const hasMore = end < bytes.byteLength;
  return json({
    content,
    truncated: hasMore,
    hasMore,
    ...(hasMore ? { continuationOffset: end } : {}),
  });
}

async function listPullRequests(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  if (!sessionId) return error("Session ID required", 400);
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);
  const records = await new SessionPullRequestStore(ctx.db).listBySession(sessionId);
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  const pagination = offsetPage(request);
  if (pagination instanceof Response) return pagination;
  const page = slicePage(records, pagination);
  return json({
    pullRequests: page.values.map((record) => projectPullRequest(record, provider)),
    hasMore: page.hasMore,
    ...(page.continuationOffset === undefined
      ? {}
      : { continuationOffset: page.continuationOffset }),
  });
}

async function getPullRequest(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = routeId(match, "id");
  const pullRequestId = routeId(match, "pullRequestId");
  if (!sessionId || !pullRequestId) return error("Session and pull request IDs required", 400);
  if ((await requireSession(ctx, sessionId)) instanceof Response)
    return error("Session not found", 404);
  const record = await new SessionPullRequestStore(ctx.db).getByArtifactId(pullRequestId);
  if (!record || record.sessionId !== sessionId) return error("Pull request not found", 404);
  return json(projectPullRequest(record, resolveScmProviderFromEnv(env.SCM_PROVIDER)));
}

async function listChildren(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = routeId(match, "id");
  if (!parentId) return error("Parent session ID required", 400);
  if ((await requireSession(ctx, parentId)) instanceof Response)
    return error("Parent session not found", 404);
  const children = await new SessionIndexStore(ctx.db).listByParent(parentId);
  const pagination = offsetPage(request);
  if (pagination instanceof Response) return pagination;
  const page = slicePage(children, pagination);
  return json({
    children: page.values.map(projectSession),
    hasMore: page.hasMore,
    ...(page.continuationOffset === undefined
      ? {}
      : { continuationOffset: page.continuationOffset }),
  });
}

async function getChild(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = routeId(match, "id");
  const childId = routeId(match, "childId");
  if (!parentId || !childId) return error("Parent and child session IDs required", 400);
  if ((await requireSession(ctx, parentId)) instanceof Response)
    return error("Parent session not found", 404);
  const child = (await new SessionIndexStore(ctx.db).listByParent(parentId)).find(
    (candidate) => candidate.id === childId
  );
  return child ? json(projectSession(child)) : error("Child session not found", 404);
}

async function promptChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const rateLimit = await enforceExternalRateLimit(request, ctx, "mutation");
  if (rateLimit) return rateLimit;
  const parentId = routeId(match, "id");
  const childId = routeId(match, "childId");
  if (!parentId || !childId) return error("Parent and child session IDs required", 400);
  const child = (await new SessionIndexStore(ctx.db).listByParent(parentId)).find(
    (candidate) => candidate.id === childId
  );
  if (!child) return error("Child session not found", 404);
  const body = await request.json().catch(() => null);
  const parsed = externalChildPromptRequestSchema.safeParse(body);
  if (!parsed.success) return error("Invalid child prompt request", 400);
  const response = await dispatchSessionPrompt(
    { ...ctx, sessionRuntime: createSessionRuntimeClient(env, ctx) },
    childId,
    {
      content: parsed.data.content,
      authorId: ctx.principal?.kind === "user" ? ctx.principal.userId : "anonymous",
      canonicalUserId: ctx.principal?.kind === "user" ? ctx.principal.userId : undefined,
      source: "extension",
      clientRequestId: parsed.data.clientRequestId,
    }
  );
  if (!response.ok) return response;
  return json(sendPromptResponseSchema.parse(await response.json()));
}

const readAuthorization = requirePermission("sessions.read", { service: "deny" });
const resources: Array<{
  suffix: string;
  handler: SessionRouteHandler;
  query?: readonly string[];
}> = [
  { suffix: "/messages", handler: listMessages, query: ["limit", "cursor", "status"] },
  { suffix: "/artifacts", handler: listArtifacts, query: ["limit", "cursor"] },
  { suffix: "/diff", handler: getDiffState, query: ["limit", "offset", "revisionId"] },
  {
    suffix: "/diff/:revisionId/files/:fileId",
    handler: getDiffFile,
    query: ["limit", "offset"],
  },
  { suffix: "/pull-requests", handler: listPullRequests, query: ["limit", "offset"] },
  { suffix: "/pull-requests/:pullRequestId", handler: getPullRequest },
  { suffix: "/children", handler: listChildren, query: ["limit", "offset"] },
  { suffix: "/children/:childId", handler: getChild },
];

export const externalSessionResourceRoutes: Route[] = defineRoutes(
  SCM_AGNOSTIC_EXTERNAL_USER_ROUTE,
  resources.map(({ suffix, handler, query }) =>
    sessionRoute({
      method: "GET",
      pattern: parsePattern(`${EXTERNAL_SESSION_PATH}${suffix}`),
      authorization: readAuthorization,
      cacheControl: "private, no-store",
      handler: withStrictQuery(handler, query),
    })
  )
);

externalSessionResourceRoutes.push(
  ...defineRoutes(SCM_AGNOSTIC_EXTERNAL_USER_ROUTE, [
    sessionRoute({
      method: "POST",
      pattern: parsePattern(`${EXTERNAL_SESSION_PATH}/attachments`),
      authorization: requirePermission("sessions.collaborate", { service: "deny" }),
      cacheControl: "private, no-store",
      handler: withStrictQuery(async (request, env, match, ctx) => {
        const rateLimit = await enforceExternalRateLimit(request, ctx, "mutation");
        return rateLimit ?? handleAttachmentPost(request, env, match, ctx);
      }),
    }),
    sessionRoute({
      method: "GET",
      pattern: parsePattern(`${EXTERNAL_SESSION_PATH}/attachments/:attachmentId`),
      authorization: readAuthorization,
      cacheControl: "private, no-store",
      handler: withStrictQuery(handleAttachmentGet),
    }),
    sessionRoute({
      method: "POST",
      pattern: parsePattern(`${EXTERNAL_SESSION_PATH}/children/:childId/messages`),
      authorization: requirePermission("sessions.collaborate", { service: "deny" }),
      cacheControl: "private, no-store",
      handler: withStrictQuery(promptChild),
    }),
    sessionRoute({
      method: "GET",
      pattern: parsePattern(`${EXTERNAL_SESSION_PATH}/artifacts/:artifactId/content`),
      authorization: readAuthorization,
      cacheControl: "private, no-store",
      handler: withStrictQuery(handleMediaGet),
    }),
  ])
);
