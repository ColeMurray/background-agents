/**
 * Automation CRUD routes.
 */

import { isValidCron, nextCronOccurrence, cronIntervalMinutes } from "@open-inspect/shared/cron";
import {
  triggerConfigSchema,
  validateConditions,
  conditionRegistry,
  isGitHubConditionSupported,
  triggerSources,
  TRIGGER_TYPE_TO_SOURCE,
} from "@open-inspect/shared/triggers";
import type { AutomationTriggerType, TriggerConfig } from "@open-inspect/shared/triggers";
import {
  createAutomationRequestSchema,
  sentryClientSecretSchema,
  updateAutomationRequestSchema,
} from "@open-inspect/shared/types/automations";
import type { ModelProviderSelections } from "@open-inspect/shared/types/provider-accounts";
import { listChannels } from "@open-inspect/shared/slack";
import {
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
} from "@open-inspect/shared/models";
import {
  AutomationStore,
  toAutomation,
  toAutomationRun,
  type AutomationRow,
  type AutomationRepositoryInsert,
} from "../db/automation-store";
import {
  encodeAutomationListCursor,
  parseAutomationListCursor,
  type AutomationListCursor,
} from "../db/automation-list-cursor";
import { EnvironmentStore } from "../db/environments";
import { SlackChannelStore } from "../db/slack-channel-store";
import { UserStore } from "../db/user-store";
import { AutomationModelProviderAuthStore } from "../db/automation-model-provider-auth";
import {
  AutomationProviderSelectionError,
  parseAndValidateAutomationProviderSelections,
} from "../model-provider-accounts/automation-provider-selection";
import { generateId } from "../auth/crypto";
import { applyIdentityEnforcement, resolveCanonicalUserId } from "../auth/identity-enforcement";
import { generateWebhookApiKey, hashApiKey, encryptSentrySecret } from "../auth/webhook-key";
import { createLogger } from "../logger";
import { AutomationTriggerBlockedError, Scheduler } from "../scheduler/scheduler";
import { hydrateAutomation } from "../automation/hydrate";
import { MAX_AUTOMATION_REPOSITORIES } from "@open-inspect/shared/types/automations";
import {
  type Route,
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  parsePattern,
  json,
  error,
  parseJsonBody,
  resolveRepoOrError,
} from "./shared";
import type { Env } from "../types";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { z } from "zod";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";

const logger = createLogger("router:automations");

/** Minimum cron interval in minutes. */
const MIN_CRON_INTERVAL_MINUTES = 15;

/** Maximum name length. */
const MAX_NAME_LENGTH = 200;

/** Maximum instructions length. Keep in sync with INSTRUCTIONS_MAX_LENGTH in packages/web/src/components/automations/automation-form.tsx. */
const MAX_INSTRUCTIONS_LENGTH = 15_000;

const RECENT_EXECUTION_COUNT = 10;

const createAutomationBodySchema = createAutomationRequestSchema.extend({
  // Bot-asserted actor display fields are cosmetic only; identity enforcement
  // still runs against the raw pre-Zod body before these parsed values are used.
  actorDisplayName: z.string().optional(),
  actorEmail: z.string().optional(),
  actorAvatarUrl: z.string().optional(),
});

type CreateAutomationBody = z.infer<typeof createAutomationBodySchema>;

const regenerateSentrySecretBodySchema = z.object({
  sentryClientSecret: sentryClientSecretSchema,
});

function formatAutomationRequestError(parseError: z.ZodError, rawBody: unknown): string {
  const issue = parseError.issues[0];
  const field = issue?.path[0];

  if (field === "environmentIds") {
    return issue.message === "must not contain duplicates"
      ? "environmentIds must not contain duplicates"
      : "environmentIds must be an array of environment ids (env_…)";
  }

  if (field === "repositories") {
    const index = typeof issue.path[1] === "number" ? `[${String(issue.path[1])}]` : "";
    return `repositories${index}: ${issue.message}`;
  }

  if (field === "eventType") return "eventType must be a non-empty string";

  if (field === "triggerConfig") {
    if (issue.path.length === 2 && issue.path[1] === "conditions") {
      return "triggerConfig.conditions must be an array";
    }

    const path = issue.path.map(String).join(".");
    const conditionIndex = issue.path[1] === "conditions" ? issue.path[2] : undefined;
    const conditions =
      rawBody &&
      typeof rawBody === "object" &&
      "triggerConfig" in rawBody &&
      rawBody.triggerConfig &&
      typeof rawBody.triggerConfig === "object" &&
      "conditions" in rawBody.triggerConfig &&
      Array.isArray(rawBody.triggerConfig.conditions)
        ? rawBody.triggerConfig.conditions
        : undefined;
    const condition = typeof conditionIndex === "number" ? conditions?.[conditionIndex] : undefined;
    const conditionType =
      condition &&
      typeof condition === "object" &&
      "type" in condition &&
      typeof condition.type === "string"
        ? `${condition.type}: `
        : "";
    return `${path}: ${conditionType}${issue.message}`;
  }

  return "Invalid automation request";
}

interface TriggerConditionError {
  condition: TriggerConfig["conditions"][number];
  code: "event_incompatible" | "invalid";
  message: string;
}

function getTriggerConditionErrors(
  triggerType: AutomationTriggerType,
  triggerConfig: TriggerConfig,
  eventType?: string
): TriggerConditionError[] {
  const source = TRIGGER_TYPE_TO_SOURCE[triggerType];
  if (!source) return [];
  return triggerConfig.conditions.flatMap((condition) => {
    const code =
      source === "github" &&
      eventType !== undefined &&
      !isGitHubConditionSupported(eventType, condition.type)
        ? "event_incompatible"
        : "invalid";
    return validateConditions([condition], source, conditionRegistry, eventType).map((message) => ({
      condition,
      code,
      message,
    }));
  });
}

function consumeCondition(
  triggerConfig: TriggerConfig,
  condition: TriggerConditionError["condition"],
  consumedIndexes: Set<number>
): boolean {
  const serialized = JSON.stringify(condition);
  const index = triggerConfig.conditions.findIndex(
    (existing, candidateIndex) =>
      !consumedIndexes.has(candidateIndex) && JSON.stringify(existing) === serialized
  );
  if (index === -1) return false;
  consumedIndexes.add(index);
  return true;
}

function getTriggerEventTypeError(
  triggerType: AutomationTriggerType,
  eventType: unknown
): string | null {
  if (eventType !== undefined && (typeof eventType !== "string" || eventType.trim().length === 0)) {
    return "eventType must be a non-empty string";
  }

  const source = triggerSources.find((candidate) => candidate.triggerType === triggerType);
  if (!source?.supportsEventTypes) return null;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return `eventType is required for ${triggerType} triggers`;
  }
  if (!source.eventTypes.some((candidate) => candidate.eventType === eventType)) {
    return `Unsupported eventType for ${triggerType}: ${eventType}`;
  }
  return null;
}

/** Warn if next run is more than 31 days away. */
const FAR_FUTURE_THRESHOLD_MS = 31 * 24 * 60 * 60 * 1000;

function resolveReasoningEffort(
  model: string,
  reasoningEffort: string | null | undefined
): string | null {
  if (reasoningEffort === undefined || reasoningEffort === null) return null;
  return isValidReasoningEffort(model, reasoningEffort) ? reasoningEffort : null;
}

type NormalizedRepositoryInput = NonNullable<CreateAutomationBody["repositories"]>[number];

type RepositorySelectionRequest =
  | { kind: "unchanged" }
  | { kind: "replace"; repositories: NormalizedRepositoryInput[] };

/**
 * Thrown when selection semantics cannot be satisfied. Route handlers catch it
 * and answer 400 while request shape validation remains in the shared schemas.
 */
class TargetSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetSelectionError";
  }
}

/**
 * Select the repositories from an already-parsed create/update body. `unchanged`
 * means the body did not touch the selection (create treats that as empty).
 */
function getRepositorySelection(body: {
  repositories?: NormalizedRepositoryInput[];
}): RepositorySelectionRequest {
  if (body.repositories === undefined) return { kind: "unchanged" };
  return { kind: "replace", repositories: body.repositories };
}

/**
 * Target-count rules across BOTH selections (repositories + environments):
 * repo-scoped event triggers need exactly one repository and no environments;
 * fan-out over several targets is a schedule/manual-only product scope (event
 * fan-out semantics are undefined, not technically prevented). Repositories
 * and environments share one combined cap.
 */
function validateTargetCounts(
  triggerType: AutomationTriggerType,
  repositoryCount: number,
  environmentCount: number
): void {
  if (triggerType === "github_event" || triggerType === "linear_event") {
    if (repositoryCount === 0) {
      throw new TargetSelectionError("Repository-scoped triggers require exactly one repository");
    }
    if (environmentCount > 0) {
      throw new TargetSelectionError("Repository-scoped triggers cannot target environments");
    }
  }
  if (repositoryCount + environmentCount > 1 && triggerType !== "schedule") {
    throw new TargetSelectionError("Multi-target selections require a schedule trigger");
  }
  if (repositoryCount + environmentCount > MAX_AUTOMATION_REPOSITORIES) {
    throw new TargetSelectionError(
      `At most ${MAX_AUTOMATION_REPOSITORIES} repositories and environments combined`
    );
  }
}

type EnvironmentSelectionRequest =
  | { kind: "unchanged" }
  | { kind: "replace"; environmentIds: string[] };

/**
 * Select the environments from an already-parsed create/update body (design
 * §13.3). `unchanged` means the body did not touch the selection (create treats
 * that as empty); an array replaces it wholesale (empty clears).
 */
function getEnvironmentSelection(body: { environmentIds?: string[] }): EnvironmentSelectionRequest {
  if (body.environmentIds === undefined) return { kind: "unchanged" };
  return { kind: "replace", environmentIds: body.environmentIds };
}

/**
 * Verify every selected environment exists — a selection must not silently
 * point at deleted environments.
 *
 * @throws TargetSelectionError naming every missing environment.
 */
async function resolveEnvironmentSelection(
  db: SqlDatabase,
  environmentIds: string[]
): Promise<void> {
  if (environmentIds.length === 0) return;
  const store = new EnvironmentStore(db);
  const found = await Promise.all(environmentIds.map((id) => store.getById(id)));
  const missing = environmentIds.filter((_, index) => !found[index]);
  if (missing.length > 0) {
    throw new TargetSelectionError(`Environment not found: ${missing.join(", ")}`);
  }
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
): Promise<AutomationRepositoryInsert[]> {
  const settled = await Promise.allSettled(
    repositories.map((repository) =>
      resolveRepoOrError(env, repository.repoOwner, repository.repoName, ctx, logger)
    )
  );
  const resolved = settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });

  return repositories.map((repository, index) => {
    const access = resolved[index];
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
  const conditions = triggerConfig?.conditions ?? [];
  if (!conditions.some((c) => c.type === "slack_channel")) {
    return "slack_event triggers require a slack_channel condition";
  }
  return null;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

const DEFAULT_AUTOMATION_LIST_PAGE_SIZE = 25;
const MAX_AUTOMATION_LIST_PAGE_SIZE = 100;

const automationListLimitSchema = z
  .string()
  .regex(/^\d+$/, { message: "Invalid limit" })
  .transform(Number)
  .refine((limit) => limit >= 1 && limit <= MAX_AUTOMATION_LIST_PAGE_SIZE, {
    message: "Invalid limit",
  });

const automationListQuerySchema = z.object({
  limit: automationListLimitSchema.optional(),
  cursor: z.string().optional(),
  search: z.string().trim().max(MAX_NAME_LENGTH, { message: "Search is too long" }).optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
});

type AutomationListQueryParamName = keyof z.input<typeof automationListQuerySchema>;

const AUTOMATION_LIST_QUERY_PARAM_NAMES = Object.keys(
  automationListQuerySchema.shape
) as AutomationListQueryParamName[];

type ReadAutomationListQueryResult =
  | { ok: true; query: Partial<Record<AutomationListQueryParamName, string>> }
  | { ok: false; error: string };

function readAutomationListQuery(searchParams: URLSearchParams): ReadAutomationListQueryResult {
  const query: Partial<Record<AutomationListQueryParamName, string>> = {};
  for (const name of AUTOMATION_LIST_QUERY_PARAM_NAMES) {
    const values = searchParams.getAll(name);
    if (values.length > 1) return { ok: false, error: `Invalid ${name}` };
    if (values.length === 1) query[name] = values[0];
  }
  return { ok: true, query };
}

type ParseAutomationListParamsResult =
  | {
      ok: true;
      options: {
        limit: number;
        cursor: AutomationListCursor | null;
        nameSearch?: string;
        repoOwner?: string;
        repoName?: string;
      };
    }
  | { ok: false; error: string };

function parseAutomationListParams(request: Request): ParseAutomationListParamsResult {
  const url = new URL(request.url);
  const rawQuery = readAutomationListQuery(url.searchParams);
  if (!rawQuery.ok) return rawQuery;

  const parsedQuery = automationListQuerySchema.safeParse(rawQuery.query);
  if (!parsedQuery.success) {
    return {
      ok: false,
      error: parsedQuery.error.issues[0]?.message ?? "Invalid automation list query",
    };
  }
  const parsedCursor = parseAutomationListCursor(parsedQuery.data.cursor ?? null);
  if (!parsedCursor.ok) return parsedCursor;

  const { repoOwner, repoName } = parsedQuery.data;
  const nameSearch = parsedQuery.data.search;

  return {
    ok: true,
    options: {
      limit: parsedQuery.data.limit ?? DEFAULT_AUTOMATION_LIST_PAGE_SIZE,
      cursor: parsedCursor.cursor,
      ...(nameSearch ? { nameSearch } : {}),
      ...(repoOwner ? { repoOwner } : {}),
      ...(repoName ? { repoName } : {}),
    },
  };
}

async function handleListAutomations(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const parsed = parseAutomationListParams(request);
  if (!parsed.ok) return error(parsed.error, 400);

  const store = new AutomationStore(ctx.db);
  const providerAuthStore = new AutomationModelProviderAuthStore(ctx.db);
  const result = await store.list(parsed.options);
  const automationIds = result.automations.map((row) => row.id);
  const [
    repositoriesByAutomation,
    environmentsByAutomation,
    providerAuthByAutomation,
    recentExecutionsByAutomation,
  ] = await Promise.all([
    store.getRepositoriesForAutomationIds(automationIds),
    store.getEnvironmentsForAutomationIds(automationIds),
    providerAuthStore.listForAutomationIds(automationIds),
    store.listRecentExecutionsForAutomationIds(automationIds, RECENT_EXECUTION_COUNT),
  ]);

  const automations = result.automations.map((row) => ({
    ...toAutomation(
      row,
      repositoriesByAutomation.get(row.id) ?? [],
      environmentsByAutomation.get(row.id) ?? [],
      providerAuthByAutomation.get(row.id) ?? []
    ),
    recentExecutions: recentExecutionsByAutomation.get(row.id) ?? [],
  }));
  return json({
    automations,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeAutomationListCursor(result.nextCursor) : null,
  });
}

async function handleCreateAutomation(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
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

  // Resolve the canonical user model ID fail-closed from the verified
  // principal — the scheduler replays user_id as session identity at fire
  // time, so an automation must never be created with lost attribution.
  const resolution = await resolveCanonicalUserId(new UserStore(ctx.db), ctx, enforced, {
    displayName: body.actorDisplayName,
    email: body.actorEmail,
    avatarUrl: body.actorAvatarUrl,
  });
  if (resolution instanceof Response) return resolution;
  const resolvedUserId = resolution.userId;

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
  await db.batch(createStatements);

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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(ctx.db);
  const row = await store.getById(id);
  if (!row) return error("Automation not found", 404);

  return json({ automation: await hydrateAutomation(ctx.db, row) });
}

async function handleUpdateAutomation(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const db: SqlDatabase = ctx.db;
  const store = new AutomationStore(db);
  const providerAuthStore = new AutomationModelProviderAuthStore(db);
  const existing = await store.getById(id);
  if (!existing) return error("Automation not found", 404);

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
    await db.batch(statements);
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
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Automation ID required", 400);

  const store = new AutomationStore(ctx.db);
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

  const store = new AutomationStore(ctx.db);
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
    automation: row ? await hydrateAutomation(ctx.db, row) : null,
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

  const store = new AutomationStore(ctx.db);
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
    automation: row ? await hydrateAutomation(ctx.db, row) : null,
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

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(id);
  if (!automation) return error("Automation not found", 404);

  // The scheduler performs the authoritative D1-backed concurrency check.
  let triggerResult;
  try {
    triggerResult = await new Scheduler(ctx.db, env, ctx.executionCtx).trigger(id);
  } catch (triggerError) {
    logger.error("automation.trigger_failed", {
      event: "automation.trigger_failed",
      automation_id: id,
      error: triggerError instanceof Error ? triggerError : new Error(String(triggerError)),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    if (triggerError instanceof AutomationTriggerBlockedError) {
      return error("A run is already active for this automation", 409);
    }
    return error("Failed to trigger automation", 500);
  }

  logger.info("automation.triggered", {
    event: "automation.triggered",
    automation_id: id,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ invocationId: triggerResult.invocationId, runs: triggerResult.runs }, 201);
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
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  if (!automationId) return error("Automation ID required", 400);

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation) return error("Automation not found", 404);

  const { limit, offset } = parseRunListParams(request);
  const result = await store.listInvocations(automationId, { limit, offset });

  return json({
    invocations: result.invocations,
    total: result.total,
  });
}

async function handleGetRun(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const automationId = match.groups?.id;
  const runId = match.groups?.runId;
  if (!automationId || !runId) return error("Automation ID and Run ID required", 400);

  const store = new AutomationStore(ctx.db);
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

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(id);
  if (!automation) return error("Automation not found", 404);

  const workerUrl = env.WORKER_URL || "";

  if (automation.trigger_type === "sentry") {
    // Sentry: user provides a new client secret
    const rawBody = await parseJsonBody<unknown>(request);
    if (rawBody instanceof Response) return rawBody;
    const parsedBody = regenerateSentrySecretBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return error("sentryClientSecret is required", 400);
    }
    if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
      return error("Encryption key not configured", 503);
    }
    const encrypted = await encryptSentrySecret(
      parsedBody.data.sentryClientSecret,
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
  ctx: RequestContext
): Promise<Response> {
  const channels = await new SlackChannelStore(ctx.db).getWatchedSlackChannels();
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
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.SLACK_BOT_TOKEN) {
    return json({ channels: [], error: "not_configured" });
  }
  const result = await listChannels(env.SLACK_BOT_TOKEN, { signal: request.signal });
  if (!result.ok) {
    logger.warn("slack.channels.list_failed", { slack_error: result.error });
    return json({ channels: [], error: result.error });
  }
  return json({ channels: result.channels });
}

// ─── Route exports ───────────────────────────────────────────────────────────

export const automationRoutes: Route[] = defineRoutes(GITHUB_USER_OR_SERVICE_ROUTE, [
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
    method: "GET",
    pattern: parsePattern("/automations/:id/runs/:runId"),
    handler: handleGetRun,
  },
  {
    method: "POST",
    pattern: parsePattern("/automations/:id/regenerate-key"),
    handler: handleRegenerateKey,
  },
]);
