/**
 * Automation CRUD routes.
 */

import { listChannels } from "@open-inspect/shared/slack";
import { nextCronOccurrence } from "@open-inspect/shared/cron";
import { AutomationStore, toAutomation, toAutomationRun } from "../db/automation-store";
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
import { Scheduler } from "../scheduler/scheduler";
import { hydrateAutomation } from "../automation/hydrate";
import {
  AutomationMutationInputError,
  parseCreateAutomationMutation,
  parseUpdateAutomationMutation,
} from "../automation/automation-mutation";
import { D1AutomationAggregateWriter } from "../db/automation-aggregate-writer";
import {
  AutomationCommandResolver,
  AutomationMutationResolutionError,
} from "../automation/automation-command-resolver";
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
import type { SqlDatabase } from "../db/sql-database";
import { z } from "zod";
import { ProviderAccountSelectionPolicyError } from "../model-provider-accounts/selection-policy";

const logger = createLogger("router:automations");

const MAX_NAME_LENGTH = 200;
const RECENT_EXECUTION_COUNT = 10;

/** Warn if next run is more than 31 days away. */
const FAR_FUTURE_THRESHOLD_MS = 31 * 24 * 60 * 60 * 1000;

function createAutomationCommandResolver(
  env: Env,
  ctx: RequestContext,
  resolveUserId: (metadata: {
    displayName?: string;
    email?: string;
    avatarUrl?: string;
  }) => Promise<string> = async () => {
    throw new Error("Canonical user resolution is unavailable for updates");
  }
): AutomationCommandResolver {
  const store = new AutomationStore(ctx.db);
  const environments = new EnvironmentStore(ctx.db);
  return new AutomationCommandResolver({
    now: () => Date.now(),
    generateId,
    resolveRepository: async (repository) => {
      const access = await resolveRepoOrError(
        env,
        repository.repoOwner,
        repository.repoName,
        ctx,
        logger
      );
      return { repoId: access.repoId, defaultBranch: access.defaultBranch };
    },
    environmentExists: async (id) => (await environments.getById(id)) !== null,
    getRepositoryCount: async (automationId) =>
      (await store.getRepositoriesForAutomation(automationId)).length,
    getEnvironmentCount: async (automationId) =>
      (await store.getEnvironmentsForAutomation(automationId)).length,
    resolveProviderSelections: async (value) => {
      try {
        return await parseAndValidateAutomationProviderSelections(ctx.db, value);
      } catch (e) {
        if (e instanceof AutomationProviderSelectionError) {
          throw new AutomationMutationResolutionError(e.message, 400);
        }
        if (e instanceof ProviderAccountSelectionPolicyError) {
          throw new AutomationMutationResolutionError(e.message, e.status);
        }
        throw e;
      }
    },
    resolveCanonicalUserId: resolveUserId,
    generateWebhookApiKey,
    hashWebhookApiKey: hashApiKey,
    encryptSentrySecret: (secret) => encryptSentrySecret(secret, env.REPO_SECRETS_ENCRYPTION_KEY!),
    hasSentryEncryptionKey: Boolean(env.REPO_SECRETS_ENCRYPTION_KEY),
  });
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

  let body;
  try {
    body = parseCreateAutomationMutation(rawBody);
  } catch (e) {
    if (e instanceof AutomationMutationInputError) return error(e.message, 400);
    throw e;
  }

  let command;
  let webhookApiKey: string | undefined;
  try {
    const resolver = createAutomationCommandResolver(env, ctx, async (metadata) => {
      const resolution = await resolveCanonicalUserId(
        new UserStore(ctx.db),
        ctx,
        enforced,
        metadata
      );
      if (resolution instanceof Response) {
        throw new AutomationMutationResolutionError("Failed to resolve session identity", 500);
      }
      return resolution.userId;
    });
    const resolved = await resolver.resolveCreate(body, {
      createdBy: enforced.participantUserId,
    });
    command = resolved.command;
    webhookApiKey = resolved.webhookApiKey;
  } catch (e) {
    if (e instanceof AutomationMutationResolutionError) return error(e.message, e.status);
    throw e;
  }
  const db: SqlDatabase = ctx.db;
  const store = new AutomationStore(db);
  await new D1AutomationAggregateWriter(db).create(command);

  const automation = await hydrateAutomation(db, (await store.getById(command.id))!);

  logger.info("automation.created", {
    event: "automation.created",
    automation_id: command.id,
    repo:
      command.repositories.map((repo) => `${repo.repo_owner}/${repo.repo_name}`).join(",") || null,
    environments: command.environmentIds.join(",") || null,
    trigger_type: command.triggerType,
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
    result.webhookUrl = `${workerUrl}/webhooks/automation/${command.id}`;
  }

  if (command.triggerType === "sentry") {
    result.sentryWebhookUrl = `${workerUrl}/webhooks/sentry/${command.id}`;
  }

  if (command.nextRunAt && command.nextRunAt - command.now > FAR_FUTURE_THRESHOLD_MS) {
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
  const existing = await store.getById(id);
  if (!existing) return error("Automation not found", 404);

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;
  let body;
  try {
    body = parseUpdateAutomationMutation(rawBody, existing.trigger_type);
  } catch (e) {
    if (e instanceof AutomationMutationInputError) return error(e.message, 400);
    throw e;
  }
  let command;
  try {
    command = await createAutomationCommandResolver(env, ctx).resolveUpdate(body, existing);
  } catch (e) {
    if (e instanceof AutomationMutationResolutionError) return error(e.message, e.status);
    throw e;
  }
  await new D1AutomationAggregateWriter(db).update(command);
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
  const triggerResponse = await new Scheduler(ctx.db, env, ctx.executionCtx).trigger({
    automationId: id,
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
