/**
 * Automation CRUD routes.
 */

import {
  isValidCron,
  nextCronOccurrence,
  cronIntervalMinutes,
  isValidModel,
  isValidReasoningEffort,
  getValidModelOrDefault,
  validateConditions,
  conditionRegistry,
  listChannels,
  TRIGGER_TYPE_TO_SOURCE,
  type CreateAutomationRequest,
  type UpdateAutomationRequest,
  type AutomationTriggerType,
  type TriggerConfig,
} from "@open-inspect/shared";
import {
  AutomationStore,
  toAutomation,
  toAutomationRun,
  type AutomationRow,
} from "../db/automation-store";
import { SlackChannelStore } from "../db/slack-channel-store";
import { UserStore } from "../db/user-store";
import { resolveProviderIdentity, type SessionIdentityFields } from "../session/identity";
import { generateId } from "../auth/crypto";
import { generateWebhookApiKey, hashApiKey, encryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  resolveRepoOrError,
  normalizeOptionalRepositoryContext,
} from "./shared";
import type { Env } from "../types";

const logger = createLogger("router:automations");

/** Minimum cron interval in minutes. */
const MIN_CRON_INTERVAL_MINUTES = 15;

/** Maximum name length. */
const MAX_NAME_LENGTH = 200;

/** Maximum instructions length. Keep in sync with INSTRUCTIONS_MAX_LENGTH in packages/web/src/components/automations/automation-form.tsx. */
const MAX_INSTRUCTIONS_LENGTH = 15_000;

/** Warn if next run is more than 31 days away. */
const FAR_FUTURE_THRESHOLD_MS = 31 * 24 * 60 * 60 * 1000;

function resolveReasoningEffort(
  model: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (reasoningEffort === undefined || reasoningEffort === null) return null;
  return isValidReasoningEffort(model, reasoningEffort) ? reasoningEffort : null;
}

/**
 * Validate an IANA timezone string.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Extract the watched channel IDs from a slack automation's `slack_channel` condition. */
function extractSlackChannels(triggerConfig: TriggerConfig | null | undefined): string[] {
  for (const condition of triggerConfig?.conditions ?? []) {
    if (condition.type === "slack_channel") return condition.value;
  }
  return [];
}

/**
 * Validate a slack_event trigger config before persistence. It must be scoped to
 * an explicit channel set (net-new validation; the engine otherwise skips
 * condition validation entirely when none are present). A text_match is optional
 * — without one the automation fires on every message in the watched channel.
 * Returns an error message, or null when valid.
 */
function validateSlackTriggerConfig(
  triggerConfig: TriggerConfig | null | undefined
): string | null {
  // Guard the shape here too: this runs before the generic array-shape check in
  // the update path, so a non-array `conditions` would otherwise throw on
  // `.some()` and surface as a 500 instead of a 400.
  const rawConditions = triggerConfig?.conditions;
  if (rawConditions !== undefined && !Array.isArray(rawConditions)) {
    return "triggerConfig.conditions must be an array";
  }
  const conditions = rawConditions ?? [];
  if (!conditions.some((c) => c.type === "slack_channel")) {
    return "slack_event triggers require a slack_channel condition";
  }
  return null;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleListAutomations(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const repoOwner = url.searchParams.get("repoOwner") ?? undefined;
  const repoName = url.searchParams.get("repoName") ?? undefined;

  const store = new AutomationStore(env.DB);
  const result = await store.list({ repoOwner, repoName });

  return json({
    automations: result.automations.map(toAutomation),
    total: result.total,
  });
}

async function handleCreateAutomation(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<CreateAutomationRequest & SessionIdentityFields>(request);
  if (body instanceof Response) return body;

  // Validate required fields
  if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return error("name is required", 400);
  }
  if (body.name.length > MAX_NAME_LENGTH) {
    return error(`name must be at most ${MAX_NAME_LENGTH} characters`, 400);
  }
  if (
    !body.instructions ||
    typeof body.instructions !== "string" ||
    body.instructions.trim().length === 0
  ) {
    return error("instructions is required", 400);
  }
  if (body.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return error(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`, 400);
  }

  const repositoryContext = normalizeOptionalRepositoryContext(body);
  if (!repositoryContext.ok) return error(repositoryContext.message, 400);

  // Validate trigger type
  const triggerType: AutomationTriggerType = body.triggerType || "schedule";
  const validTriggerTypes: AutomationTriggerType[] = [
    "schedule",
    "sentry",
    "webhook",
    "github_event",
    "linear_event",
    "slack_event",
  ];
  if (!validTriggerTypes.includes(triggerType)) {
    return error(`triggerType must be one of: ${validTriggerTypes.join(", ")}`, 400);
  }
  if (
    !repositoryContext.repository &&
    (triggerType === "github_event" || triggerType === "linear_event")
  ) {
    return error("repoOwner and repoName are required for repo-scoped triggers", 400);
  }
  if (!repositoryContext.repository && body.baseBranch?.trim()) {
    return error("baseBranch requires repoOwner and repoName", 400);
  }

  const isSchedule = triggerType === "schedule";

  // Schedule-specific validation
  if (isSchedule) {
    if (!body.scheduleCron || !isValidCron(body.scheduleCron)) {
      return error("scheduleCron must be a valid 5-field cron expression", 400);
    }
    const interval = cronIntervalMinutes(body.scheduleCron);
    if (interval !== null && interval < MIN_CRON_INTERVAL_MINUTES) {
      return error(`Schedule interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes`, 400);
    }
    if (!body.scheduleTz || !isValidTimezone(body.scheduleTz)) {
      return error("scheduleTz must be a valid IANA timezone", 400);
    }
  } else {
    // Reject schedule fields for non-schedule types
    if (body.scheduleCron || body.scheduleTz) {
      return error("scheduleCron and scheduleTz are only valid for schedule triggers", 400);
    }
  }

  // Event-type validation for sentry triggers
  if (triggerType === "sentry" && !body.eventType) {
    return error("eventType is required for sentry triggers", 400);
  }

  // Validate conditions
  if (body.triggerConfig?.conditions) {
    if (!Array.isArray(body.triggerConfig.conditions)) {
      return error("triggerConfig.conditions must be an array", 400);
    }
    const source = TRIGGER_TYPE_TO_SOURCE[triggerType];
    if (source) {
      const conditionErrors = validateConditions(
        body.triggerConfig.conditions,
        source,
        conditionRegistry
      );
      if (conditionErrors.length > 0) {
        return error(conditionErrors.join("; "), 400);
      }
    }
  }

  // Slack triggers require explicit scoping (at least one watched channel).
  if (triggerType === "slack_event") {
    const slackError = validateSlackTriggerConfig(body.triggerConfig);
    if (slackError) return error(slackError, 400);
  }

  // Validate model
  const model = getValidModelOrDefault(body.model);
  const reasoningEffort = resolveReasoningEffort(model, body.reasoningEffort);
  if (body.reasoningEffort !== undefined && body.reasoningEffort !== null && !reasoningEffort) {
    return error("Invalid reasoning effort for selected model", 400);
  }

  let repoOwner: string | null = null;
  let repoName: string | null = null;
  let repoId: number | null = null;
  let baseBranch: string | null = null;

  if (repositoryContext.repository) {
    repoOwner = repositoryContext.repository.repoOwner;
    repoName = repositoryContext.repository.repoName;

    const resolved = await resolveRepoOrError(env, repoOwner, repoName, ctx, logger);
    if (resolved instanceof Response) return resolved;

    repoId = resolved.repoId;
    baseBranch = body.baseBranch || resolved.defaultBranch;
  }

  // Compute next run (only for schedule triggers)
  const nextRunAt = isSchedule
    ? nextCronOccurrence(body.scheduleCron!, body.scheduleTz!).getTime()
    : null;

  const id = generateId();
  const now = Date.now();

  // Generate auth data for trigger types that need it
  let webhookApiKey: string | undefined;
  let triggerAuthData: string | null = null;
  if (triggerType === "webhook") {
    webhookApiKey = generateWebhookApiKey();
    triggerAuthData = await hashApiKey(webhookApiKey);
  } else if (triggerType === "sentry") {
    const sentrySecret = body.sentryClientSecret;
    if (!sentrySecret || typeof sentrySecret !== "string" || sentrySecret.trim().length === 0) {
      return error("sentryClientSecret is required for sentry triggers", 400);
    }
    if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
      return error("Encryption key not configured", 503);
    }
    triggerAuthData = await encryptSentrySecret(sentrySecret, env.REPO_SECRETS_ENCRYPTION_KEY);
  }

  // Resolve canonical user model ID (best-effort, same pattern as handleCreateSession).
  // Automations are created by web users, so resolve through the provider-agnostic
  // "user" path: this populates user_id for both GitHub (scm*) and Google (auth*)
  // users at creation time. Without it a Google automation would store user_id = NULL,
  // and the github-only scheduler fallback (createSessionForAutomation) could never
  // recover the canonical user — losing attribution, enrichment, and tokens at fire time.
  let resolvedUserId: string | null = null;
  const providerIdentity = resolveProviderIdentity("user", body);
  if (providerIdentity) {
    try {
      const userStore = new UserStore(env.DB);
      const resolvedUser = await userStore.resolveOrCreateUser(providerIdentity);
      resolvedUserId = resolvedUser.id;
    } catch (e) {
      logger.warn("Failed to resolve user identity for automation", {
        error: e instanceof Error ? e : String(e),
        provider: providerIdentity.provider,
        providerUserId: providerIdentity.providerUserId,
      });
    }
  }

  const store = new AutomationStore(env.DB);
  const row: AutomationRow = {
    id,
    name: body.name.trim(),
    repo_owner: repoOwner,
    repo_name: repoName,
    base_branch: baseBranch,
    repo_id: repoId,
    instructions: body.instructions,
    trigger_type: triggerType,
    schedule_cron: body.scheduleCron ?? null,
    schedule_tz: body.scheduleTz ?? "UTC",
    model,
    reasoning_effort: reasoningEffort,
    enabled: 1,
    next_run_at: nextRunAt,
    consecutive_failures: 0,
    created_by: body.userId || "anonymous",
    user_id: resolvedUserId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: body.eventType ?? null,
    trigger_config: body.triggerConfig ? JSON.stringify(body.triggerConfig) : null,
    trigger_auth_data: triggerAuthData,
  };

  // Persist the automation and (for slack_event) its watched-channel index in a
  // single atomic write, so the canonical trigger_config and the channel index
  // that drives scheduler candidate selection can never drift apart on a partial
  // failure. The batch composes the two single-table stores' prepared statements.
  if (triggerType === "slack_event") {
    const slackStore = new SlackChannelStore(env.DB);
    await env.DB.batch([
      store.bindAutomationInsert(row),
      ...slackStore.bindChannelStatements(row.id, extractSlackChannels(body.triggerConfig)),
    ]);
  } else {
    await store.create(row);
  }

  const automation = toAutomation((await store.getById(id))!);

  logger.info("automation.created", {
    event: "automation.created",
    automation_id: id,
    repo: repoOwner && repoName ? `${repoOwner}/${repoName}` : null,
    trigger_type: triggerType,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const workerUrl = env.WORKER_URL || "";
  const result: {
    automation: typeof automation;
    warning?: string;
    webhookApiKey?: string;
    webhookUrl?: string;
    sentryWebhookUrl?: string;
  } = { automation };

  if (webhookApiKey) {
    result.webhookApiKey = webhookApiKey;
    result.webhookUrl = `${workerUrl}/webhooks/automation/${id}`;
  }

  if (triggerType === "sentry") {
    result.sentryWebhookUrl = `${workerUrl}/webhooks/sentry/${id}`;
  }

  if (nextRunAt && nextRunAt - now > FAR_FUTURE_THRESHOLD_MS) {
    result.warning = "Next scheduled run is more than 31 days away";
  }

  return json(result, 201);
}

async function handleGetAutomation(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const row = await store.getById(id);
  if (!row) return error("Automation not found", 404);

  return json({ automation: toAutomation(row) });
}

async function handleUpdateAutomation(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const existing = await store.getById(id);
  if (!existing) return error("Automation not found", 404);

  const body = await parseJsonBody<UpdateAutomationRequest>(request);
  if (body instanceof Response) return body;

  // Validate fields if provided
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return error("name cannot be empty", 400);
    }
    if (body.name.length > MAX_NAME_LENGTH) {
      return error(`name must be at most ${MAX_NAME_LENGTH} characters`, 400);
    }
  }

  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string" || body.instructions.trim().length === 0) {
      return error("instructions cannot be empty", 400);
    }
    if (body.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      return error(`instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`, 400);
    }
  }

  if (body.scheduleCron !== undefined) {
    if (!isValidCron(body.scheduleCron)) {
      return error("scheduleCron must be a valid 5-field cron expression", 400);
    }
    const interval = cronIntervalMinutes(body.scheduleCron);
    if (interval !== null && interval < MIN_CRON_INTERVAL_MINUTES) {
      return error(`Schedule interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes`, 400);
    }
  }

  if (body.scheduleTz !== undefined && !isValidTimezone(body.scheduleTz)) {
    return error("scheduleTz must be a valid IANA timezone", 400);
  }

  if (body.model !== undefined && !isValidModel(body.model)) {
    return error("Invalid model", 400);
  }

  const nextModel = body.model !== undefined ? getValidModelOrDefault(body.model) : existing.model;
  const requestedReasoningEffort = body.reasoningEffort;
  const resolvedReasoningEffort =
    requestedReasoningEffort !== undefined
      ? resolveReasoningEffort(nextModel, requestedReasoningEffort)
      : body.model !== undefined && existing.reasoning_effort !== null
        ? resolveReasoningEffort(nextModel, existing.reasoning_effort)
        : existing.reasoning_effort;

  if (
    requestedReasoningEffort !== undefined &&
    requestedReasoningEffort !== null &&
    resolvedReasoningEffort === null
  ) {
    return error("Invalid reasoning effort for selected model", 400);
  }

  // Build update fields
  const updateFields: Record<string, unknown> = {};
  if (body.name !== undefined) updateFields.name = body.name.trim();
  if (body.instructions !== undefined) updateFields.instructions = body.instructions;
  if (body.scheduleCron !== undefined) updateFields.schedule_cron = body.scheduleCron;
  if (body.scheduleTz !== undefined) updateFields.schedule_tz = body.scheduleTz;
  if (body.model !== undefined) updateFields.model = nextModel;
  if (body.reasoningEffort !== undefined || body.model !== undefined) {
    updateFields.reasoning_effort = resolvedReasoningEffort;
  }

  const repoOwnerChanged = "repoOwner" in body;
  const repoNameChanged = "repoName" in body;
  const repositoryChanged = repoOwnerChanged || repoNameChanged;
  if (repositoryChanged) {
    if (repoOwnerChanged !== repoNameChanged) {
      return error("repoOwner and repoName must be provided together", 400);
    }

    const repositoryContext = normalizeOptionalRepositoryContext(body);
    if (!repositoryContext.ok) return error(repositoryContext.message, 400);

    if (!repositoryContext.repository) {
      if (existing.trigger_type === "github_event" || existing.trigger_type === "linear_event") {
        return error("repoOwner and repoName are required for repo-scoped triggers", 400);
      }
      if (body.baseBranch?.trim()) {
        return error("baseBranch requires repoOwner and repoName", 400);
      }
      updateFields.repo_owner = null;
      updateFields.repo_name = null;
      updateFields.repo_id = null;
      updateFields.base_branch = null;
    } else {
      const resolved = await resolveRepoOrError(
        env,
        repositoryContext.repository.repoOwner,
        repositoryContext.repository.repoName,
        ctx,
        logger
      );
      if (resolved instanceof Response) return resolved;

      updateFields.repo_owner = repositoryContext.repository.repoOwner;
      updateFields.repo_name = repositoryContext.repository.repoName;
      updateFields.repo_id = resolved.repoId;
      updateFields.base_branch = body.baseBranch || resolved.defaultBranch;
    }
  } else if (body.baseBranch !== undefined) {
    if (!existing.repo_owner || !existing.repo_name) {
      return error("baseBranch requires repoOwner and repoName", 400);
    }
    updateFields.base_branch = body.baseBranch;
  }

  // Update event type — only for non-schedule types
  if (body.eventType !== undefined) {
    if (existing.trigger_type === "schedule") {
      return error("Cannot set eventType on schedule automations", 400);
    }
    updateFields.event_type = body.eventType;
  }

  // Validate trigger config (conditions) — only for non-schedule types
  if (body.triggerConfig !== undefined) {
    if (existing.trigger_type === "schedule") {
      return error("Cannot set triggerConfig on schedule automations", 400);
    }
    if (body.triggerConfig === null) {
      // A slack_event's trigger_config holds its required scoping (channel +
      // text_match) and the watched-channel index is derived from it. Clearing
      // it would leave the automation enabled but untriggerable, so reject null
      // — pause or delete instead. (Other sources may clear conditions to a
      // match-all, so null stays allowed for them.)
      if (existing.trigger_type === "slack_event") {
        return error(
          "Cannot clear triggerConfig on slack_event automations; pause or delete instead",
          400
        );
      }
    } else {
      if (existing.trigger_type === "slack_event") {
        const slackError = validateSlackTriggerConfig(body.triggerConfig);
        if (slackError) return error(slackError, 400);
      }
      if (body.triggerConfig.conditions) {
        if (!Array.isArray(body.triggerConfig.conditions)) {
          return error("triggerConfig.conditions must be an array", 400);
        }
        const source = TRIGGER_TYPE_TO_SOURCE[existing.trigger_type as AutomationTriggerType];
        if (source) {
          const conditionErrors = validateConditions(
            body.triggerConfig.conditions,
            source,
            conditionRegistry
          );
          if (conditionErrors.length > 0) {
            return error(conditionErrors.join("; "), 400);
          }
        }
      }
    }
  }

  // trigger_config is a single source-interpreted JSON blob (the conditions),
  // so a PUT replaces it wholesale (null clears it). The caller owns the full
  // blob; the web form always re-submits the conditions within triggerConfig.
  if (body.triggerConfig === null) {
    updateFields.trigger_config = null;
  } else if (body.triggerConfig !== undefined) {
    updateFields.trigger_config = JSON.stringify(body.triggerConfig);
  }

  // Recompute next_run_at if schedule changed (only for schedule types)
  if (
    existing.trigger_type === "schedule" &&
    (body.scheduleCron !== undefined || body.scheduleTz !== undefined)
  ) {
    const cron = body.scheduleCron ?? existing.schedule_cron;
    const tz = body.scheduleTz ?? existing.schedule_tz;
    if (!cron) {
      return error("Cannot compute schedule: no cron expression", 400);
    }
    updateFields.next_run_at = nextCronOccurrence(cron, tz).getTime();
  }

  // Apply the update and, when a slack_event automation's conditions changed,
  // re-sync its watched-channel index in the same atomic write so trigger_config
  // and the channel index can never drift apart on a partial failure. The batch
  // composes the two single-table stores' prepared statements, tolerating a null
  // update statement (no automation fields changed, channels-only re-sync).
  const resyncSlackChannels =
    existing.trigger_type === "slack_event" && body.triggerConfig !== undefined;
  let updated: AutomationRow | null;
  if (resyncSlackChannels) {
    const slackStore = new SlackChannelStore(env.DB);
    const updateStatement = store.bindAutomationUpdate(id, updateFields);
    const channelStatements = slackStore.bindChannelStatements(
      id,
      extractSlackChannels(body.triggerConfig)
    );
    await env.DB.batch(
      updateStatement ? [updateStatement, ...channelStatements] : channelStatements
    );
    updated = await store.getById(id);
  } else {
    updated = await store.update(id, updateFields);
  }
  if (!updated) return error("Automation not found", 404);

  logger.info("automation.updated", {
    event: "automation.updated",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ automation: toAutomation(updated) });
}

async function handleDeleteAutomation(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const deleted = await store.softDelete(id);
  if (!deleted) return error("Automation not found", 404);

  logger.info("automation.deleted", {
    event: "automation.deleted",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted", automationId: id });
}

async function handlePauseAutomation(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const paused = await store.pause(id);
  if (!paused) return error("Automation not found", 404);

  logger.info("automation.paused", {
    event: "automation.paused",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const row = await store.getById(id);
  return json({ automation: row ? toAutomation(row) : null });
}

async function handleResumeAutomation(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const existing = await store.getById(id);
  if (!existing) return error("Automation not found", 404);

  // For schedule automations, compute the next run time.
  // For event-driven automations, resume with null next_run_at.
  let nextRunAt: number | null;
  if (existing.trigger_type === "schedule") {
    if (!existing.schedule_cron) {
      return error("Cannot resume: automation has no cron schedule", 400);
    }
    nextRunAt = nextCronOccurrence(existing.schedule_cron, existing.schedule_tz).getTime();
  } else {
    nextRunAt = null;
  }

  const resumed = await store.resume(id, nextRunAt);
  if (!resumed) return error("Automation not found", 404);

  logger.info("automation.resumed", {
    event: "automation.resumed",
    automation_id: id,
    next_run_at: nextRunAt,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const row = await store.getById(id);
  return json({ automation: row ? toAutomation(row) : null });
}

async function handleTriggerAutomation(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const automation = await store.getById(id);
  if (!automation) return error("Automation not found", 404);

  // Forward to SchedulerDO (it performs its own authoritative concurrency check)
  if (!env.SCHEDULER) {
    return error("Scheduler not configured", 503);
  }

  const doId = env.SCHEDULER.idFromName("global-scheduler");
  const stub = env.SCHEDULER.get(doId);

  const triggerResponse = await stub.fetch("http://internal/internal/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ automationId: id }),
  });

  if (!triggerResponse.ok) {
    const text = await triggerResponse.text().catch(() => "");
    logger.error("automation.trigger_failed", {
      event: "automation.trigger_failed",
      automation_id: id,
      status: triggerResponse.status,
      response: text.slice(0, 500),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    // Forward 409 (concurrent run) with descriptive message; wrap others as 500
    if (triggerResponse.status === 409) {
      return error("A run is already active for this automation", 409);
    }
    return error("Failed to trigger automation", 500);
  }

  const triggerResult = await triggerResponse.json();

  logger.info("automation.triggered", {
    event: "automation.triggered",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json(triggerResult, 201);
}

async function handleListRuns(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);

  // Verify automation exists
  const automation = await store.getById(automationId);
  if (!automation) return error("Automation not found", 404);

  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);

  const result = await store.listRunsForAutomation(automationId, { limit, offset });

  return json({
    runs: result.runs.map(toAutomationRun),
    total: result.total,
  });
}

async function handleGetRun(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  const runId = match.groups?.runId;
  if (!automationId || !runId) return error("Automation ID and Run ID required", 400);

  const store = new AutomationStore(env.DB);
  const run = await store.getRunById(automationId, runId);
  if (!run) return error("Run not found", 404);

  return json({ run: toAutomationRun(run) });
}

async function handleRegenerateKey(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const automation = await store.getById(id);
  if (!automation) return error("Automation not found", 404);

  const workerUrl = env.WORKER_URL || "";

  if (automation.trigger_type === "sentry") {
    // Sentry: user provides a new client secret
    const body = await parseJsonBody<{ sentryClientSecret?: string }>(request);
    if (body instanceof Response) return body;
    if (!body.sentryClientSecret || typeof body.sentryClientSecret !== "string") {
      return error("sentryClientSecret is required", 400);
    }
    if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
      return error("Encryption key not configured", 503);
    }
    const encrypted = await encryptSentrySecret(
      body.sentryClientSecret,
      env.REPO_SECRETS_ENCRYPTION_KEY
    );
    await store.update(id, { trigger_auth_data: encrypted } as Record<string, unknown>);

    logger.info("automation.secret_updated", {
      event: "automation.secret_updated",
      automation_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({
      sentryWebhookUrl: `${workerUrl}/webhooks/sentry/${id}`,
    });
  }

  if (automation.trigger_type !== "webhook") {
    return error("Only webhook and sentry automations support key regeneration", 400);
  }

  // Webhook: generate a new API key
  const apiKey = generateWebhookApiKey();
  const hash = await hashApiKey(apiKey);

  await store.update(id, { trigger_auth_data: hash } as Record<string, unknown>);

  logger.info("automation.key_regenerated", {
    event: "automation.key_regenerated",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({
    webhookApiKey: apiKey,
    webhookUrl: `${workerUrl}/webhooks/automation/${id}`,
  });
}

/**
 * GET /integration-settings/slack/watched-channels
 *
 * Returns the distinct set of Slack channel IDs referenced by enabled
 * `slack_event` automations. The slack-bot polls this (cached) to pre-filter
 * channel messages before normalizing and forwarding them — only messages in a
 * watched channel are worth forwarding to the scheduler.
 *
 * Grouped under the `/integration-settings/slack` prefix the bot already uses
 * for its runtime config (routing rules), even though the data is sourced from
 * the automations store. Internal-auth gated by the router (non-public route).
 */
async function handleGetWatchedSlackChannels(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const channels = await new SlackChannelStore(env.DB).getWatchedSlackChannels();
  return json({ channels });
}

/**
 * GET /integration-settings/slack/channels
 *
 * Lists the workspace's channels (public + private the bot can see) so the
 * automation form can offer a channel picker instead of a raw channel ID. Sourced
 * live from Slack via `conversations.list` using the bot token.
 *
 * Returns `{ channels }` on success, or `{ channels: [], error }` when the token
 * is unset or Slack rejects the call (e.g. missing `channels:read`/`groups:read`
 * scope) — the form then degrades to manual channel-ID entry. Internal-auth gated
 * by the router (non-public route).
 */
async function handleGetSlackChannels(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.SLACK_BOT_TOKEN) {
    return json({ channels: [], error: "not_configured" });
  }
  const result = await listChannels(env.SLACK_BOT_TOKEN);
  if (!result.ok) {
    logger.warn("slack.channels.list_failed", { slack_error: result.error });
    return json({ channels: [], error: result.error });
  }
  return json({ channels: result.channels });
}

// ─── Route exports ───────────────────────────────────────────────────────────

export const automationRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/slack/watched-channels"),
    handler: handleGetWatchedSlackChannels,
  },
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/slack/channels"),
    handler: handleGetSlackChannels,
  },
  {
    method: "GET",
    pattern: parsePattern("/automations"),
    handler: handleListAutomations,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations"),
    handler: handleCreateAutomation,
  },
  {
    method: "GET",
    pattern: parsePattern("/automations/:id"),
    handler: handleGetAutomation,
  },
  {
    method: "PUT",
    pattern: parsePattern("/automations/:id"),
    handler: handleUpdateAutomation,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/automations/:id"),
    handler: handleDeleteAutomation,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations/:id/pause"),
    handler: handlePauseAutomation,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations/:id/resume"),
    handler: handleResumeAutomation,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations/:id/trigger"),
    handler: handleTriggerAutomation,
  },
  {
    method: "GET",
    pattern: parsePattern("/automations/:id/runs"),
    handler: handleListRuns,
  },
  {
    method: "GET",
    pattern: parsePattern("/automations/:id/runs/:runId"),
    handler: handleGetRun,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations/:id/regenerate-key"),
    handler: handleRegenerateKey,
  },
];
