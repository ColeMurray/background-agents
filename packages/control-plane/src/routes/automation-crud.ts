/**
 * Automation create, read, update, and delete routes.
 */

import { isValidCron, nextCronOccurrence, cronIntervalMinutes } from "@open-inspect/shared/cron";
import { triggerConfigSchema } from "@open-inspect/shared/triggers";
import type { AutomationTriggerType } from "@open-inspect/shared/triggers";
import { updateAutomationRequestSchema } from "@open-inspect/shared/types/automations";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { getValidModelOrDefault, isValidModel } from "@open-inspect/shared/models";
import {
  AutomationStore,
  type AutomationRow,
  type AutomationRepositoryInsert,
} from "../db/automation-store";
import { SlackChannelStore } from "../db/slack-channel-store";
import { AutomationModelProviderAuthStore } from "../db/automation-model-provider-auth";
import {
  AutomationProviderSelectionError,
  parseAndValidateAutomationProviderSelections,
} from "../model-provider-accounts/automation-provider-selection";
import { generateId } from "../auth/crypto";
import {
  applyIdentityEnforcement,
  requireAdmittedCanonicalUserId,
} from "../routing/identity-enforcement";
import { generateWebhookApiKey, hashApiKey, encryptSentrySecret } from "../auth/webhook-key";
import { hydrateAutomation } from "../automation/hydrate";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  error,
  parseJsonBody,
  requirePermission,
} from "./shared";
import type { Env } from "../types";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";
import { createLogger } from "../logger";
import { AUTOMATIONS_READ, AUTOMATION_MANAGE, admittedAutomation } from "./automation-shared";
import {
  type CreateAutomationBody,
  FAR_FUTURE_THRESHOLD_MS,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NAME_LENGTH,
  MIN_CRON_INTERVAL_MINUTES,
  TargetSelectionError,
  consumeCondition,
  createAutomationBodySchema,
  extractSlackChannels,
  formatAutomationRequestError,
  getEnvironmentSelection,
  getRepositorySelection,
  getTriggerConditionErrors,
  getTriggerEventTypeError,
  isValidTimezone,
  requireTargetPermissions,
  resolveEnvironmentSelection,
  resolveReasoningEffort,
  resolveRepositorySelection,
  validateSlackTriggerConfig,
  validateTargetCounts,
} from "./automation-validation";

const logger = createLogger("router:automations");

async function handleCreateAutomation(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;

  // Automation attribution comes from the verified principal. The stored
  // values are replayed by the scheduler as session identity at fire time,
  // so this is where they become trustworthy.
  const enforcement = applyIdentityEnforcement(ctx, "automation-create", rawBody);
  if (enforcement.rejection) return enforcement.rejection;
  const enforced = enforcement.enforced;

  const parsedBody = createAutomationBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return error(formatAutomationRequestError(parsedBody.error, rawBody), 400);
  }
  const body: CreateAutomationBody = parsedBody.data;

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

  const selection = getRepositorySelection(body);
  const requestedRepositories = selection.kind === "replace" ? selection.repositories : [];

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
  let requestedEnvironmentIds: string[];
  try {
    const environmentSelection = getEnvironmentSelection(body);
    requestedEnvironmentIds =
      environmentSelection.kind === "replace" ? environmentSelection.environmentIds : [];
    validateTargetCounts(triggerType, requestedRepositories.length, requestedEnvironmentIds.length);
  } catch (e) {
    if (e instanceof TargetSelectionError) return error(e.message, 400);
    throw e;
  }
  if (ctx.principal?.kind === "user") {
    const targetAuthorizationError = requireTargetPermissions(ctx, [
      ...(requestedRepositories.length > 0 ? (["repositories.use"] as const) : []),
      ...(requestedEnvironmentIds.length > 0 ? (["environments.use"] as const) : []),
    ]);
    if (targetAuthorizationError) return targetAuthorizationError;
  }
  try {
    await resolveEnvironmentSelection(ctx.db, requestedEnvironmentIds);
  } catch (e) {
    if (e instanceof TargetSelectionError) return error(e.message, 400);
    throw e;
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

  const eventTypeError = getTriggerEventTypeError(triggerType, body.eventType);
  if (eventTypeError) return error(eventTypeError, 400);

  // Validate conditions
  if (body.triggerConfig) {
    const conditionErrors = getTriggerConditionErrors(
      triggerType,
      body.triggerConfig,
      body.eventType
    );
    if (conditionErrors.length > 0) {
      return error(conditionErrors.map(({ message }) => message).join("; "), 400);
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

  const newRepositories = await resolveRepositorySelection(env, requestedRepositories, ctx);

  let providerSelections: ModelProviderSelections;
  try {
    providerSelections = await parseAndValidateAutomationProviderSelections(
      ctx.db,
      body.providerSelections ?? {}
    );
  } catch (e) {
    if (e instanceof AutomationProviderSelectionError) return error(e.message, 400);
    if (e instanceof ProviderAccountSelectionPolicyError) return error(e.message, e.status);
    throw e;
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

  // The scheduler replays user_id as session identity at fire time, so the
  // handler may consume only the canonical subject admitted before RBAC.
  const resolution = requireAdmittedCanonicalUserId(ctx, enforced);
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution;

  const db: SqlDatabase = ctx.db;
  const store = new AutomationStore(db);
  const providerAuthStore = new AutomationModelProviderAuthStore(db);
  const row: AutomationRow = {
    id,
    name: body.name.trim(),
    instructions: body.instructions,
    trigger_type: triggerType,
    schedule_cron: body.scheduleCron ?? null,
    schedule_tz: body.scheduleTz ?? "UTC",
    model,
    reasoning_effort: reasoningEffort,
    enabled: 1,
    next_run_at: nextRunAt,
    consecutive_failures: 0,
    created_by: enforced.participantUserId,
    user_id: resolvedUserId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    event_type: body.eventType ?? null,
    trigger_config: body.triggerConfig ? JSON.stringify(body.triggerConfig) : null,
    trigger_auth_data: triggerAuthData,
  };

  // Persist the automation, its repository selection, and (for slack_event)
  // its watched-channel index in a single atomic write, so none of the three
  // can drift apart on a partial failure. The batch composes the single-table
  // stores' prepared statements.
  const createStatements = [
    store.bindAutomationInsert(row),
    ...store.bindRepositoryInserts(id, newRepositories, now),
    ...store.bindEnvironmentInserts(id, requestedEnvironmentIds, now),
    ...providerAuthStore.bindInserts(id, providerSelections, now),
  ];
  if (triggerType === "slack_event") {
    const slackStore = new SlackChannelStore(db);
    createStatements.push(
      ...slackStore.bindChannelStatements(row.id, extractSlackChannels(body.triggerConfig))
    );
  }
  await ctx.db.batch(createStatements);

  const automation = await hydrateAutomation(db, (await store.getById(id))!);

  logger.info("automation.created", {
    event: "automation.created",
    automation_id: id,
    repo: newRepositories.map((repo) => `${repo.repo_owner}/${repo.repo_name}`).join(",") || null,
    environments: requestedEnvironmentIds.join(",") || null,
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new AutomationStore(ctx.db);
  const row = await store.getById(id);
  if (!row) return error("Automation not found", 404);

  return json({ automation: await hydrateAutomation(ctx.db, row) });
}

async function handleUpdateAutomation(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const db: SqlDatabase = ctx.db;
  const store = new AutomationStore(db);
  const providerAuthStore = new AutomationModelProviderAuthStore(db);
  const admission = admittedAutomation(ctx);
  const { automation: existing } = admission;

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  const parsedBody = updateAutomationRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return error(formatAutomationRequestError(parsedBody.error, rawBody), 400);
  }
  const body = parsedBody.data;

  if (body.triggerConfig !== undefined && existing.trigger_type === "schedule") {
    return error("Cannot set triggerConfig on schedule automations", 400);
  }

  let replacementProviderSelections: ModelProviderSelections | null = null;
  if (body.providerSelections !== undefined) {
    try {
      replacementProviderSelections = await parseAndValidateAutomationProviderSelections(
        ctx.db,
        body.providerSelections
      );
    } catch (e) {
      if (e instanceof AutomationProviderSelectionError) return error(e.message, 400);
      if (e instanceof ProviderAccountSelectionPolicyError) return error(e.message, e.status);
      throw e;
    }
  }

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

  // Repository-set edits are UNCONDITIONAL — no cardinality freeze and no
  // active-invocation guard. In-flight invocations already materialized their
  // children from their firing-time snapshot, so an edit cannot corrupt them;
  // it simply applies from the next invocation.
  const selection = getRepositorySelection(body);
  const environmentSelection = getEnvironmentSelection(body);
  const requiredTargetPermissions: PermissionId[] = [
    ...(selection.kind === "replace" && selection.repositories.length > 0
      ? (["repositories.use"] as const)
      : []),
    ...(environmentSelection.kind === "replace" && environmentSelection.environmentIds.length > 0
      ? (["environments.use"] as const)
      : []),
  ];
  if (requiredTargetPermissions.length > 0) {
    const targetAuthorizationError = requireTargetPermissions(ctx, requiredTargetPermissions);
    if (targetAuthorizationError) return targetAuthorizationError;
  }

  // The count rules span both selections, so when EITHER is replaced they are
  // validated against the automation's FINAL state (the replacement plus the
  // other side's existing rows). Edits that touch neither selection skip this
  // — count rules stay write-time so a stored selection predating a rule can
  // never brick unrelated edits.
  let replacementRepositories: AutomationRepositoryInsert[] | null = null;
  const replacementEnvironmentIds: string[] | null =
    environmentSelection.kind === "replace" ? environmentSelection.environmentIds : null;
  if (selection.kind === "replace" || replacementEnvironmentIds !== null) {
    try {
      const finalRepositoryCount =
        selection.kind === "replace"
          ? selection.repositories.length
          : (await store.getRepositoriesForAutomation(id)).length;
      const finalEnvironmentCount =
        replacementEnvironmentIds !== null
          ? replacementEnvironmentIds.length
          : (await store.getEnvironmentsForAutomation(id)).length;
      validateTargetCounts(
        existing.trigger_type as AutomationTriggerType,
        finalRepositoryCount,
        finalEnvironmentCount
      );
      if (replacementEnvironmentIds !== null) {
        await resolveEnvironmentSelection(ctx.db, replacementEnvironmentIds);
      }
    } catch (e) {
      if (e instanceof TargetSelectionError) return error(e.message, 400);
      throw e;
    }
    if (selection.kind === "replace") {
      replacementRepositories = await resolveRepositorySelection(env, selection.repositories, ctx);
    }
  }

  // Update event type — only for non-schedule types
  if (body.eventType !== undefined) {
    if (existing.trigger_type === "schedule") {
      return error("Cannot set eventType on schedule automations", 400);
    }
    updateFields.event_type = body.eventType;
  }

  const effectiveEventType =
    body.eventType !== undefined ? body.eventType : (existing.event_type ?? undefined);
  const eventTypeError = getTriggerEventTypeError(
    existing.trigger_type as AutomationTriggerType,
    effectiveEventType
  );
  if (eventTypeError) return error(eventTypeError, 400);

  let triggerConfigToValidate = body.triggerConfig;
  if (
    body.eventType !== undefined &&
    triggerConfigToValidate === undefined &&
    existing.trigger_config
  ) {
    // This column was written through parseTriggerConfig, so a failure here is a
    // corrupt row, not user input — parseTriggerConfig's per-condition messages
    // would have no one to help.
    try {
      triggerConfigToValidate = triggerConfigSchema.parse(JSON.parse(existing.trigger_config));
    } catch {
      return error("Stored triggerConfig is invalid", 500);
    }
  }

  // A slack_event's trigger_config holds its required channel scope. Clearing it
  // would leave the automation enabled but untriggerable.
  if (body.triggerConfig === null && existing.trigger_type === "slack_event") {
    return error(
      "Cannot clear triggerConfig on slack_event automations; pause or delete instead",
      400
    );
  }
  if (body.triggerConfig && existing.trigger_type === "slack_event") {
    const slackError = validateSlackTriggerConfig(body.triggerConfig);
    if (slackError) return error(slackError, 400);
  }

  if (triggerConfigToValidate) {
    let conditionErrors = getTriggerConditionErrors(
      existing.trigger_type as AutomationTriggerType,
      triggerConfigToValidate,
      effectiveEventType
    );

    // Existing source-wide GitHub conditions predate event-scoped validation.
    // Preserve an unchanged condition on unrelated edits, but validate strictly
    // when its value or the selected event changes.
    const eventTypeChanged = body.eventType !== undefined && body.eventType !== existing.event_type;
    if (existing.trigger_type === "github_event" && !eventTypeChanged && existing.trigger_config) {
      try {
        const parsedExisting = triggerConfigSchema.safeParse(JSON.parse(existing.trigger_config));
        if (parsedExisting.success) {
          const consumedIndexes = new Set<number>();
          conditionErrors = conditionErrors.filter(({ code, condition }) => {
            if (code !== "event_incompatible") return true;
            return !consumeCondition(parsedExisting.data, condition, consumedIndexes);
          });
        }
      } catch {
        // A valid replacement should be able to repair malformed stored JSON.
      }
    }

    if (conditionErrors.length > 0) {
      return error(conditionErrors.map(({ message }) => message).join("; "), 400);
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

  // Apply the field update, the repository-selection replacement (which
  // carries the transitional scalar-mirror dual-write), and any slack
  // watched-channel re-sync in ONE atomic batch so none of them can drift
  // apart on a partial failure. Tolerates a null update statement (e.g. a
  // repositories-only edit).
  const resyncSlackChannels =
    existing.trigger_type === "slack_event" && body.triggerConfig !== undefined;
  const statements: SqlStatement[] = [];
  const updateStatement = store.bindAutomationUpdate(id, updateFields);
  if (updateStatement) statements.push(updateStatement);
  if (replacementRepositories !== null) {
    statements.push(...store.bindReplaceRepositories(id, replacementRepositories, Date.now()));
  }
  if (replacementEnvironmentIds !== null) {
    statements.push(...store.bindReplaceEnvironments(id, replacementEnvironmentIds, Date.now()));
  }
  if (replacementProviderSelections !== null) {
    statements.push(
      ...providerAuthStore.bindReplace(id, replacementProviderSelections, Date.now())
    );
  }
  if (resyncSlackChannels) {
    const slackStore = new SlackChannelStore(db);
    statements.push(
      ...slackStore.bindChannelStatements(id, extractSlackChannels(body.triggerConfig))
    );
  }
  if (statements.length > 0) {
    await ctx.db.batch(statements);
  }
  const updated = await store.getById(id);
  if (!updated) return error("Automation not found", 404);

  logger.info("automation.updated", {
    event: "automation.updated",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ automation: await hydrateAutomation(db, updated) });
}

async function handleDeleteAutomation(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = params.id;

  const store = new AutomationStore(ctx.db);
  admittedAutomation(ctx);
  const result = await ctx.db.batch([store.bindSoftDelete(id)]);
  const deleted = result[0]?.meta.changes === 1;
  if (!deleted) return error("Automation not found", 404);

  logger.info("automation.deleted", {
    event: "automation.deleted",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ status: "deleted", automationId: id });
}

export const automationCrudRoutes = new Hono<ControlPlaneHonoEnv>();

automationCrudRoutes.post(
  "/automations",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("automations.create"),
  }),
  (c) => handleCreateAutomation(c.var.admitted.request, c.env, c.var.admitted.ctx)
);
automationCrudRoutes.get("/automations/:id", AUTOMATIONS_READ, (c) =>
  dispatch(c, handleGetAutomation)
);
automationCrudRoutes.put("/automations/:id", AUTOMATION_MANAGE, (c) =>
  dispatch(c, handleUpdateAutomation)
);
automationCrudRoutes.delete("/automations/:id", AUTOMATION_MANAGE, (c) =>
  dispatch(c, handleDeleteAutomation)
);
