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
  type NewAutomationRepository,
  repositoryScalarMirror,
} from "../db/automation-store";
import { SlackChannelStore } from "../db/slack-channel-store";
import { UserStore } from "../db/user-store";
import { resolveProviderIdentity, type SessionIdentityFields } from "../session/identity";
import { generateId } from "../auth/crypto";
import { generateWebhookApiKey, hashApiKey, encryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
import {
  automationRepositoriesInputSchema,
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
  type RepositoryPair,
} from "@open-inspect/shared";
import type { RepositoryAccessResult } from "../source-control";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  resolveRepoOrError,
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

function parseRepositoryContext(
  input: { repoOwner?: string | null; repoName?: string | null },
  partialMessage?: string
): RepositoryPair | null | Response {
  try {
    return normalizeOptionalRepositoryPair(input, partialMessage);
  } catch (e) {
    if (e instanceof RepositoryPairValidationError) {
      return error(e.message, 400);
    }
    throw e;
  }
}

interface NormalizedRepositoryInput {
  repoOwner: string;
  repoName: string;
  baseBranch: string | null;
}

type RepositorySelectionRequest =
  | { kind: "unchanged" }
  | { kind: "replace"; repositories: NormalizedRepositoryInput[] };

/**
 * Parse the repository selection from a create/update body. Accepts the
 * canonical `repositories` list or the deprecated scalar repoOwner/repoName
 * sugar (normalized into a 0/1-element list; explicit nulls clear — the
 * null-clears update contract); sending both forms is a 400. `unchanged`
 * means the body did not touch the selection (create treats that as empty).
 */
function parseRepositorySelection(body: {
  repositories?: unknown;
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
}): RepositorySelectionRequest | Response {
  const scalarPresent = "repoOwner" in body || "repoName" in body;

  if (body.repositories !== undefined) {
    if (scalarPresent || "baseBranch" in body) {
      return error("Provide either repositories or the repoOwner/repoName fields, not both", 400);
    }
    const parsed = automationRepositoriesInputSchema.safeParse(body.repositories);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `[${String(issue.path[0])}]` : "";
      return error(`repositories${path}: ${issue?.message ?? "invalid"}`, 400);
    }
    return { kind: "replace", repositories: parsed.data };
  }

  if (!scalarPresent) return { kind: "unchanged" };

  if ("repoOwner" in body !== "repoName" in body) {
    return error("repoOwner and repoName must be provided together", 400);
  }
  const pair = parseRepositoryContext(body);
  if (pair instanceof Response) return pair;
  if (!pair) return { kind: "replace", repositories: [] };
  return {
    kind: "replace",
    repositories: [
      {
        repoOwner: pair.repoOwner,
        repoName: pair.repoName,
        baseBranch: body.baseBranch?.trim() || null,
      },
    ],
  };
}

/**
 * Repository-count rules: repo-scoped event triggers need exactly one
 * repository; fan-out over several is a schedule/manual-only product scope
 * (event fan-out semantics are undefined, not technically prevented).
 */
function validateRepositoryCount(
  triggerType: AutomationTriggerType,
  count: number
): Response | null {
  if (count === 0 && (triggerType === "github_event" || triggerType === "linear_event")) {
    return error("repoOwner and repoName are required for repo-scoped triggers", 400);
  }
  if (count > 1 && triggerType !== "schedule") {
    return error("Multi-repository selections require a schedule trigger", 400);
  }
  return null;
}

/**
 * Resolve every requested repository through the SCM provider concurrently.
 * The first failure IN INPUT ORDER wins. A repo change always takes the body
 * branch or the freshly resolved default — never a previous row's branch.
 */
async function resolveRepositorySelection(
  env: Env,
  repositories: NormalizedRepositoryInput[],
  ctx: RequestContext
): Promise<NewAutomationRepository[] | Response> {
  const resolved = await Promise.all(
    repositories.map((repository) =>
      resolveRepoOrError(env, repository.repoOwner, repository.repoName, ctx, logger)
    )
  );
  for (const result of resolved) {
    if (result instanceof Response) return result;
  }
  return repositories.map((repository, index) => {
    const access = resolved[index] as RepositoryAccessResult;
    return {
      repo_owner: repository.repoOwner,
      repo_name: repository.repoName,
      repo_id: access.repoId,
      base_branch: repository.baseBranch ?? access.defaultBranch,
    };
  });
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
  const repositoriesByAutomation = await store.getRepositoriesForAutomationIds(
    result.automations.map((row) => row.id)
  );

  return json({
    automations: result.automations.map((row) =>
      toAutomation(row, repositoriesByAutomation.get(row.id) ?? [])
    ),
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

  const selection = parseRepositorySelection(body);
  if (selection instanceof Response) return selection;
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
  const countError = validateRepositoryCount(triggerType, requestedRepositories.length);
  if (countError) return countError;
  if (
    requestedRepositories.length === 0 &&
    typeof body.baseBranch === "string" &&
    body.baseBranch.trim()
  ) {
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

  const newRepositories = await resolveRepositorySelection(env, requestedRepositories, ctx);
  if (newRepositories instanceof Response) return newRepositories;

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
  // Scalar columns hold the transitional single-repository mirror only; the
  // repository rows in the same batch below are the source of truth.
  const mirror = repositoryScalarMirror(newRepositories);
  const row: AutomationRow = {
    id,
    name: body.name.trim(),
    repo_owner: mirror.repo_owner,
    repo_name: mirror.repo_name,
    base_branch: mirror.base_branch,
    repo_id: mirror.repo_id,
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

  // Persist the automation, its repository selection, and (for slack_event)
  // its watched-channel index in a single atomic write, so none of the three
  // can drift apart on a partial failure. The batch composes the single-table
  // stores' prepared statements.
  const createStatements = [
    store.bindAutomationInsert(row),
    ...store.bindRepositoryInserts(id, newRepositories, now),
  ];
  if (triggerType === "slack_event") {
    const slackStore = new SlackChannelStore(env.DB);
    createStatements.push(
      ...slackStore.bindChannelStatements(row.id, extractSlackChannels(body.triggerConfig))
    );
  }
  await env.DB.batch(createStatements);

  const automation = toAutomation(
    (await store.getById(id))!,
    await store.getRepositoriesForAutomation(id)
  );

  logger.info("automation.created", {
    event: "automation.created",
    automation_id: id,
    repo: newRepositories.map((repo) => `${repo.repo_owner}/${repo.repo_name}`).join(",") || null,
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

  return json({
    automation: toAutomation(row, await store.getRepositoriesForAutomation(id)),
  });
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

  // Repository-set edits are UNCONDITIONAL — no cardinality freeze and no
  // active-invocation guard. In-flight invocations already materialized their
  // children from their firing-time snapshot, so an edit cannot corrupt them;
  // it simply applies from the next invocation.
  const selection = parseRepositorySelection(body);
  if (selection instanceof Response) return selection;

  let replacementRepositories: NewAutomationRepository[] | null = null;
  if (selection.kind === "replace") {
    const countError = validateRepositoryCount(
      existing.trigger_type as AutomationTriggerType,
      selection.repositories.length
    );
    if (countError) return countError;
    if (
      selection.repositories.length === 0 &&
      typeof body.baseBranch === "string" &&
      body.baseBranch.trim()
    ) {
      return error("baseBranch requires repoOwner and repoName", 400);
    }
    const resolved = await resolveRepositorySelection(env, selection.repositories, ctx);
    if (resolved instanceof Response) return resolved;
    replacementRepositories = resolved;
  } else if (body.baseBranch !== undefined) {
    const current = await store.getRepositoriesForAutomation(id);
    if (current.length === 0) {
      return error("baseBranch requires repoOwner and repoName", 400);
    }
    if (current.length > 1) {
      return error(
        "baseBranch applies per repository on multi-repository automations; resend repositories",
        400
      );
    }
    replacementRepositories = [
      {
        repo_owner: current[0].repo_owner,
        repo_name: current[0].repo_name,
        repo_id: current[0].repo_id,
        base_branch: body.baseBranch?.trim() || null,
      },
    ];
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

  // Apply the field update, the repository-selection replacement (which
  // carries the transitional scalar-mirror dual-write), and any slack
  // watched-channel re-sync in ONE atomic batch so none of them can drift
  // apart on a partial failure. Tolerates a null update statement (e.g. a
  // repositories-only edit).
  const resyncSlackChannels =
    existing.trigger_type === "slack_event" && body.triggerConfig !== undefined;
  const statements: D1PreparedStatement[] = [];
  const updateStatement = store.bindAutomationUpdate(id, updateFields);
  if (updateStatement) statements.push(updateStatement);
  if (replacementRepositories !== null) {
    statements.push(...store.bindReplaceRepositories(id, replacementRepositories, Date.now()));
  }
  if (resyncSlackChannels) {
    const slackStore = new SlackChannelStore(env.DB);
    statements.push(
      ...slackStore.bindChannelStatements(id, extractSlackChannels(body.triggerConfig))
    );
  }
  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  const updated = await store.getById(id);
  if (!updated) return error("Automation not found", 404);

  logger.info("automation.updated", {
    event: "automation.updated",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({
    automation: toAutomation(updated, await store.getRepositoriesForAutomation(id)),
  });
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
  return json({
    automation: row ? toAutomation(row, await store.getRepositoriesForAutomation(id)) : null,
  });
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
  return json({
    automation: row ? toAutomation(row, await store.getRepositoriesForAutomation(id)) : null,
  });
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

function parseRunListParams(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);
  return { limit, offset };
}

/** GET /automations/:id/invocations — one row per firing; `total` counts invocations. */
async function handleListInvocations(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  const store = new AutomationStore(env.DB);
  const automation = await store.getById(automationId);
  if (!automation) return error("Automation not found", 404);

  const { limit, offset } = parseRunListParams(request);
  const result = await store.listInvocations(automationId, { limit, offset });

  return json({
    invocations: result.invocations,
    total: result.total,
  });
}

/**
 * DEPRECATED alias serving the pre-invocations list shape ({runs, total},
 * flattened child runs plus virtual rows for childless skipped invocations) so
 * web bundles deployed before the invocations endpoint keep rendering and
 * paginating correctly. Removed together with the Automation scalar mirrors
 * after one release.
 */
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

  const { limit, offset } = parseRunListParams(request);
  const result = await store.listRunsFlattenedForAutomation(automationId, { limit, offset });

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
    pattern: parsePattern("/automations/:id/invocations"),
    handler: handleListInvocations,
  },
  {
    // Deprecated alias — see handleListRuns.
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
