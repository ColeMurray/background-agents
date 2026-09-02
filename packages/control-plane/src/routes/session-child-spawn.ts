import { spawnChildSessionRequestSchema } from "@open-inspect/shared/types/session-api";
import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import {
  getReasoningConfig,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  resolveEnabledModel,
  type ValidModel,
  VALID_MODELS,
} from "@open-inspect/shared/models";
import { generateId } from "../auth/crypto";
import { getEffectiveEnabledModels } from "../db/model-preferences";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { initializeSession, type SessionInitInput } from "../session/initialize";
import {
  resolveCodeServerEnabled,
  resolveSandboxSettings,
  resolveVncEnabled,
} from "../session/integration-settings-resolution";
import { spawnContextSchema } from "../session/spawn-context";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  json,
  permissionRequirement,
  requireAll,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { DEFAULT_BASE_BRANCH } from "../repos/default-branch";
import { authorizeSessionTarget } from "./session-target-authorization";

const logger = createLogger("router:session-child-spawn");
const MAX_SPAWN_DEPTH = 2;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handleSpawnChild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const parentId = match.groups?.id;
  if (!parentId) return error("Parent session ID required");

  const parsedBody = spawnChildSessionRequestSchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return error("title and prompt are required");
  }
  const body = parsedBody.data;

  if (!body.title || !body.prompt) {
    return error("title and prompt are required");
  }

  const sessionStore = new SessionIndexStore(ctx.db);

  const parentSession = await sessionStore.get(parentId);
  const parentEnvironmentId = parentSession?.environmentId ?? null;
  // Children inherit the parent's settings scope: its primary repo plus, for
  // environment-launched parents, that environment's overrides (design §13.5).
  const resolvedChildSandboxSettings = parentSession
    ? await resolveSandboxSettings(
        ctx.db,
        parentSession.repoOwner,
        parentSession.repoName,
        parentEnvironmentId
      )
    : {};
  const maxConcurrentChildren =
    resolvedChildSandboxSettings.maxConcurrentChildSessions ??
    DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
  const maxTotalChildren =
    resolvedChildSandboxSettings.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS;

  const parentDepth = await sessionStore.getSpawnDepth(parentId);
  if (parentDepth >= MAX_SPAWN_DEPTH) {
    return error(`Maximum spawn depth (${MAX_SPAWN_DEPTH}) exceeded`, 403);
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
      const body = await spawnContextRes.json();
      if (isJsonRecord(body) && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Keep the generic fallback when the session runtime did not return JSON.
    }
    return error(message, spawnContextRes.status);
  }

  const parsedSpawnContext = spawnContextSchema.safeParse(await spawnContextRes.json());
  if (!parsedSpawnContext.success) {
    return error("Failed to get parent session context", 500);
  }
  const spawnContext = parsedSpawnContext.data;
  const { sandboxTimeoutMs: _currentTimeoutMs, ...resolvedChildSettingsWithoutTimeout } =
    resolvedChildSandboxSettings;
  const childSandboxSettings: SandboxSettings = resolvedChildSettingsWithoutTimeout;
  if (spawnContext.sandboxTimeoutMs !== undefined) {
    childSandboxSettings.sandboxTimeoutMs = spawnContext.sandboxTimeoutMs;
  }

  const requestedRepoOwner = body.repoOwner?.trim().toLowerCase() || null;
  const requestedRepoName = body.repoName?.trim().toLowerCase() || null;
  if ((requestedRepoOwner === null) !== (requestedRepoName === null)) {
    return error("repoOwner and repoName must be provided together", 400);
  }

  // Children pin to the parent's scalar repository, which for a multi-repo
  // parent is its primary member — child sessions are single-repo by design.
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

  const targetAuthorizationError = authorizeSessionTarget(ctx, {
    environmentId: parentEnvironmentId,
    hasRepository: Boolean(parentRepoOwner && parentRepoName),
  });
  if (targetAuthorizationError) return targetAuthorizationError;

  let enabledModels: ValidModel[];
  try {
    enabledModels = await getEffectiveEnabledModels(ctx.db);
  } catch (e) {
    logger.error("Failed to resolve enabled models for child session", {
      event: "session.spawn_child_model_preferences_failed",
      parent_id: parentId,
      error: e instanceof Error ? e.message : String(e),
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    return error("Model preferences unavailable", 503);
  }
  if (body.model !== undefined && !isValidModel(body.model)) {
    return error(`Invalid model "${body.model}". Valid models: ${VALID_MODELS.join(", ")}`, 400);
  }
  const requestedModel = getValidModelOrDefault(body.model ?? spawnContext.model);
  if (body.model !== undefined && !enabledModels.includes(requestedModel)) {
    return error(`Model "${body.model}" is not enabled`, 400);
  }
  const model = resolveEnabledModel({ model: requestedModel, enabledModels });
  if (body.reasoningEffort !== undefined && !isValidReasoningEffort(model, body.reasoningEffort)) {
    const validEfforts = getReasoningConfig(model)?.efforts;
    const suffix = validEfforts?.length
      ? ` Valid efforts: ${validEfforts.join(", ")}`
      : " This model does not support reasoning effort overrides.";
    return error(
      `Invalid reasoning effort "${body.reasoningEffort}" for model "${model}".${suffix}`,
      400
    );
  }
  const requestedReasoningEffort = body.reasoningEffort ?? spawnContext.reasoningEffort;
  const reasoningEffort =
    requestedReasoningEffort && isValidReasoningEffort(model, requestedReasoningEffort)
      ? requestedReasoningEffort
      : null;

  let providerAuth;
  try {
    providerAuth = await sessionStore.getCompleteProviderAuth(parentId);
  } catch (cause) {
    logger.error("Failed to load parent provider auth", {
      event: "session.spawn_child_provider_auth_failed",
      parent_id: parentId,
      error: cause instanceof Error ? cause.message : String(cause),
      trace_id: ctx.trace_id,
      request_id: ctx.request_id,
    });
    return error("Parent provider auth unavailable", 503);
  }

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
    ctx.db,
    spawnContext.repoOwner,
    spawnContext.repoName,
    parentEnvironmentId
  );
  const childVncEnabled = await resolveVncEnabled(
    ctx.db,
    spawnContext.repoOwner,
    spawnContext.repoName,
    parentEnvironmentId
  );

  const input: SessionInitInput = {
    sessionId: childId,
    repoOwner: spawnContext.repoOwner,
    repoName: spawnContext.repoName,
    repoId: spawnContext.repoId,
    environmentId: parentEnvironmentId,
    branch:
      spawnContext.repoOwner && spawnContext.repoName
        ? (spawnContext.baseBranch ?? DEFAULT_BASE_BRANCH)
        : null,
    title: body.title,
    model,
    reasoningEffort,
    participantUserId: spawnContext.promptAuthor.userId,
    platformUserId: spawnContext.promptAuthor.canonicalUserId ?? null,
    scmLogin: spawnContext.promptAuthor.scmLogin,
    scmName: spawnContext.promptAuthor.scmName,
    scmEmail: spawnContext.promptAuthor.scmEmail,
    scmUserId: spawnContext.promptAuthor.scmUserId,
    scmTokenEncrypted: spawnContext.promptAuthor.scmAccessTokenEncrypted,
    scmRefreshTokenEncrypted: spawnContext.promptAuthor.scmRefreshTokenEncrypted,
    scmTokenExpiresAt: spawnContext.promptAuthor.scmTokenExpiresAt,
    codeServerEnabled: childCodeServerEnabled,
    vncEnabled: childVncEnabled,
    sandboxSettings: childSandboxSettings,
    parentSessionId: parentId,
    spawnSource: "agent",
    spawnDepth: childDepth,
    automationId: parentSession?.automationId ?? null,
    automationRunId: parentSession?.automationRunId ?? null,
    managedSkillsSourceSessionId: parentId,
    providerAuth: providerAuth.map((auth) => ({
      ...auth,
      inheritedFromSessionId: parentId,
    })),
  };

  const admissionLease = await sessionStore.acquireChildAdmissionLease(
    parentId,
    childId,
    maxConcurrentChildren
  );
  if (!admissionLease) {
    return error(`Maximum concurrent children (${maxConcurrentChildren}) reached`, 429);
  }

  try {
    await initializeSession(env, input, ctx);
  } catch (e) {
    await sessionStore.releaseChildAdmissionLease(admissionLease);
    logger.error("Failed to initialize child session", {
      error: e instanceof Error ? e.message : String(e),
      parent_id: parentId,
      child_id: childId,
      trace_id: ctx.trace_id,
    });
    return error("Failed to create child session", 500);
  }
  await sessionStore.releaseChildAdmissionLease(admissionLease);

  let promptResponse: Response;
  try {
    const promptRequest = {
      content: body.prompt,
      authorId: spawnContext.promptAuthor.userId,
      canonicalUserId: spawnContext.promptAuthor.canonicalUserId ?? undefined,
      source: "agent",
    } satisfies EnqueuePromptRequest;

    promptResponse = await ctx.sessionRuntime.fetch(childId, SessionInternalPaths.prompt, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(promptRequest),
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

  ctx.executionCtx.submit(
    () =>
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
        }),
    {
      name: "session.notify_parent_spawn",
      context: { parent_id: parentId, child_id: childId, trace_id: ctx.trace_id },
    }
  );

  return json({ sessionId: childId, status: "created" }, 201);
}

export const sessionChildSpawnRoutes: Route[] = defineRoutes(GITHUB_SANDBOX_FALLBACK_ROUTE, [
  sessionRoute({
    method: "POST",
    path: "/sessions/:id/children",
    authorization: requireAll(
      permissionRequirement("sessions.create"),
      permissionRequirement("sessions.collaborate")
    ),
    handler: handleSpawnChild,
  }),
]);
