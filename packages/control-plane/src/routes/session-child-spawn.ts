import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  VALID_MODELS,
  type SpawnChildSessionRequest,
  type SpawnContext,
} from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
} from "../session/integration-settings-resolution";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-child-spawn");
const MAX_SPAWN_DEPTH = 2;

async function handleSpawnChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const body = (await request.json()) as SpawnChildSessionRequest;

  if (!body.title || !body.prompt) {
    return error("title and prompt are required");
  }

  const sessionStore = new SessionIndexStore(env.DB);

  const parentSession = await sessionStore.get(parentId);
  const parentUserId = parentSession?.userId ?? null;
  const childSandboxSettings = parentSession
    ? await resolveSandboxSettings(env.DB, parentSession.repoOwner, parentSession.repoName)
    : {};
  const maxConcurrentChildren =
    childSandboxSettings.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
  const maxTotalChildren =
    childSandboxSettings.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS;

  const parentDepth = await sessionStore.getSpawnDepth(parentId);
  if (parentDepth >= MAX_SPAWN_DEPTH) {
    return error(`Maximum spawn depth (${MAX_SPAWN_DEPTH}) exceeded`, 403);
  }

  const activeCount = await sessionStore.countActiveChildren(parentId);
  if (activeCount >= maxConcurrentChildren) {
    return error(`Maximum concurrent children (${maxConcurrentChildren}) reached`, 429);
  }

  const totalCount = await sessionStore.countTotalChildren(parentId);
  if (totalCount >= maxTotalChildren) {
    return error(`Maximum total children (${maxTotalChildren}) reached`, 429);
  }

  const spawnContextRes = await ctx.sessionRuntime.fetch(
    parentId,
    SessionInternalPaths.spawnContext
  );

  if (!spawnContextRes.ok) {
    let message = "Failed to get parent session context";
    try {
      const body = (await spawnContextRes.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Keep the generic fallback when the session runtime did not return JSON.
    }
    return error(message, spawnContextRes.status);
  }

  const spawnContext = (await spawnContextRes.json()) as SpawnContext;

  const requestedRepoOwner = body.repoOwner?.trim().toLowerCase() || null;
  const requestedRepoName = body.repoName?.trim().toLowerCase() || null;
  if ((requestedRepoOwner === null) !== (requestedRepoName === null)) {
    return error("repoOwner and repoName must be provided together", 400);
  }

  const parentRepoOwner = spawnContext.repoOwner?.toLowerCase() ?? null;
  const parentRepoName = spawnContext.repoName?.toLowerCase() ?? null;
  if (requestedRepoOwner || requestedRepoName) {
    if (!parentRepoOwner || !parentRepoName) {
      return error("Cannot add repository context to a repo-less child session", 403);
    }
    if (requestedRepoOwner !== parentRepoOwner || requestedRepoName !== parentRepoName) {
      return error("Child sessions must use the same repository as the parent", 403);
    }
  }

  const rawModel = body.model ?? spawnContext.model;
  if (body.model !== undefined && !isValidModel(body.model)) {
    return error(`Invalid model "${body.model}". Valid models: ${VALID_MODELS.join(", ")}`, 400);
  }
  const model = getValidModelOrDefault(rawModel);
  const reasoningEffort =
    body.reasoningEffort && isValidReasoningEffort(model, body.reasoningEffort)
      ? body.reasoningEffort
      : spawnContext.reasoningEffort;

  const childDepth = parentDepth + 1;
  const childId = generateId();

  logger.info("Spawning child session", {
    event: "session.spawn_child",
    parent_id: parentId,
    child_id: childId,
    child_depth: childDepth,
    model,
  });

  const childCodeServerEnabled = await resolveCodeServerEnabled(
    env.DB,
    spawnContext.repoOwner,
    spawnContext.repoName
  );

  const input: SessionInitInput = {
    sessionId: childId,
    repoOwner: spawnContext.repoOwner,
    repoName: spawnContext.repoName,
    repoId: spawnContext.repoId,
    branch:
      spawnContext.repoOwner && spawnContext.repoName ? (spawnContext.baseBranch ?? "main") : null,
    title: body.title,
    model,
    reasoningEffort,
    participantUserId: spawnContext.owner.userId,
    platformUserId: parentUserId,
    scmLogin: spawnContext.owner.scmLogin,
    scmName: spawnContext.owner.scmName,
    scmEmail: spawnContext.owner.scmEmail,
    scmUserId: spawnContext.owner.scmUserId,
    scmTokenEncrypted: spawnContext.owner.scmAccessTokenEncrypted,
    scmRefreshTokenEncrypted: spawnContext.owner.scmRefreshTokenEncrypted,
    scmTokenExpiresAt: spawnContext.owner.scmTokenExpiresAt,
    codeServerEnabled: childCodeServerEnabled,
    sandboxSettings: childSandboxSettings,
    parentSessionId: parentId,
    spawnSource: "agent",
    spawnDepth: childDepth,
  };

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    logger.error("Failed to initialize child session", {
      error: e instanceof Error ? e.message : String(e),
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create child session", 500);
  }

  let promptResponse: Response;
  try {
    promptResponse = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.prompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: body.prompt,
        authorId: spawnContext.owner.userId,
        source: "agent",
      }),
    });
  } catch (enqueueError) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
      error: enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  if (!promptResponse.ok) {
    logger.error("Failed to enqueue initial prompt for child session", {
      event: "session.spawn_child_prompt_enqueue_failed",
      parent_id: parentId,
      child_id: childId,
      prompt_status: promptResponse.status,
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    await sessionStore.updateStatus(childId, "failed");
    return error("Failed to enqueue child session prompt", 500);
  }

  ctx.executionCtx?.waitUntil(
    ctx.sessionRuntime
      .fetch(parentId, SessionInternalPaths.childSessionUpdate, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          childSessionId: childId,
          status: "created",
          title: body.title,
        }),
      })
      .catch((err: unknown) => {
        logger.error("session.notify_parent_spawn.failed", { error: err });
      })
  );

  return json({ sessionId: childId, status: "created" }, 201);
}

export const sessionChildSpawnRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/children"),
    handler: handleSpawnChild,
  }),
];
