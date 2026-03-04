/**
 * Automation CRUD routes.
 */

import {
  isValidCron,
  nextCronOccurrence,
  cronIntervalMinutes,
  isValidModel,
  getValidModelOrDefault,
  type CreateAutomationRequest,
  type UpdateAutomationRequest,
} from "@open-inspect/shared";
import { AutomationStore, toAutomation, toAutomationRun } from "../db/automation-store";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  createRouteSourceControlProvider,
  resolveInstalledRepo,
} from "./shared";
import type { Env } from "../types";

const logger = createLogger("router:automations");

/** Minimum cron interval in minutes. */
const MIN_CRON_INTERVAL_MINUTES = 15;

/** Maximum name length. */
const MAX_NAME_LENGTH = 200;

/** Maximum instructions length. */
const MAX_INSTRUCTIONS_LENGTH = 10_000;

/** Warn if next run is more than 31 days away. */
const FAR_FUTURE_THRESHOLD_MS = 31 * 24 * 60 * 60 * 1000;

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
  let body: CreateAutomationRequest & { userId?: string };
  try {
    body = (await request.json()) as CreateAutomationRequest & { userId?: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

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
  if (!body.repoOwner || !body.repoName) {
    return error("repoOwner and repoName are required", 400);
  }

  // Validate trigger type
  if (body.triggerType && body.triggerType !== "schedule") {
    return error("triggerType must be 'schedule'", 400);
  }

  // Validate cron
  if (!body.scheduleCron || !isValidCron(body.scheduleCron)) {
    return error("scheduleCron must be a valid 5-field cron expression", 400);
  }
  const interval = cronIntervalMinutes(body.scheduleCron);
  if (interval !== null && interval < MIN_CRON_INTERVAL_MINUTES) {
    return error(`Schedule interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes`, 400);
  }

  // Validate timezone
  if (!body.scheduleTz || !isValidTimezone(body.scheduleTz)) {
    return error("scheduleTz must be a valid IANA timezone", 400);
  }

  // Validate model
  const model = getValidModelOrDefault(body.model);

  // Resolve repository
  const repoOwner = body.repoOwner.toLowerCase();
  const repoName = body.repoName.toLowerCase();

  let repoId: number;
  let defaultBranch: string;
  try {
    const provider = createRouteSourceControlProvider(env);
    const resolved = await resolveInstalledRepo(provider, repoOwner, repoName);
    if (!resolved) {
      return error("Repository is not installed for the GitHub App", 404);
    }
    repoId = resolved.repoId;
    defaultBranch = resolved.defaultBranch;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error("Failed to resolve repository", {
      error: message,
      repo_owner: repoOwner,
      repo_name: repoName,
    });
    return error("Failed to resolve repository", 500);
  }

  const baseBranch = body.baseBranch || defaultBranch;

  // Compute next run
  const nextRunAt = nextCronOccurrence(body.scheduleCron, body.scheduleTz).getTime();

  const id = generateId();
  const now = Date.now();

  const store = new AutomationStore(env.DB);
  await store.create({
    id,
    name: body.name.trim(),
    repo_owner: repoOwner,
    repo_name: repoName,
    base_branch: baseBranch,
    repo_id: repoId,
    instructions: body.instructions,
    trigger_type: body.triggerType || "schedule",
    schedule_cron: body.scheduleCron,
    schedule_tz: body.scheduleTz,
    model,
    enabled: 1,
    next_run_at: nextRunAt,
    consecutive_failures: 0,
    created_by: body.userId || "anonymous",
    created_at: now,
    updated_at: now,
    deleted_at: null,
  });

  const automation = toAutomation((await store.getById(id))!);

  logger.info("automation.created", {
    event: "automation.created",
    automation_id: id,
    repo: `${repoOwner}/${repoName}`,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  const result: { automation: typeof automation; warning?: string } = { automation };

  if (nextRunAt - now > FAR_FUTURE_THRESHOLD_MS) {
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

  let body: UpdateAutomationRequest;
  try {
    body = (await request.json()) as UpdateAutomationRequest;
  } catch {
    return error("Invalid JSON body", 400);
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

  // Build update fields
  const updateFields: Record<string, unknown> = {};
  if (body.name !== undefined) updateFields.name = body.name.trim();
  if (body.instructions !== undefined) updateFields.instructions = body.instructions;
  if (body.scheduleCron !== undefined) updateFields.schedule_cron = body.scheduleCron;
  if (body.scheduleTz !== undefined) updateFields.schedule_tz = body.scheduleTz;
  if (body.model !== undefined) updateFields.model = getValidModelOrDefault(body.model);
  if (body.baseBranch !== undefined) updateFields.base_branch = body.baseBranch;

  // Recompute next_run_at if schedule changed
  if (body.scheduleCron !== undefined || body.scheduleTz !== undefined) {
    const cron = body.scheduleCron ?? existing.schedule_cron;
    const tz = body.scheduleTz ?? existing.schedule_tz;
    if (!cron) {
      return error("Cannot compute schedule: no cron expression", 400);
    }
    updateFields.next_run_at = nextCronOccurrence(cron, tz).getTime();
  }

  const updated = await store.update(id, updateFields);
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

  if (!existing.schedule_cron) {
    return error("Cannot resume: automation has no cron schedule", 400);
  }

  const nextRunAt = nextCronOccurrence(existing.schedule_cron, existing.schedule_tz).getTime();

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

// ─── Route exports ───────────────────────────────────────────────────────────

export const automationRoutes: Route[] = [
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
];
