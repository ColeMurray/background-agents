/**
 * Integration-settings routes and handlers.
 */

import { isValidReasoningEffort, type IntegrationId } from "@open-inspect/shared";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
} from "../db/integration-settings";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:integration-settings");

function extractIntegrationId(match: RegExpMatchArray): IntegrationId | null {
  const id = match.groups?.id;
  if (!id || !isValidIntegrationId(id)) return null;
  return id;
}

async function handleGetIntegrationSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, settings: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const settings = await store.getGlobal(id);
  return json({ integrationId: id, settings });
}

async function handleSetIntegrationSettings(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  let body: { settings?: Record<string, unknown> };
  try {
    body = (await request.json()) as { settings?: Record<string, unknown> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(env.DB);

  try {
    await store.setGlobal(id, body.settings);

    logger.info("integration_settings.updated", {
      event: "integration_settings.updated",
      integration_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", integrationId: id });
  } catch (e) {
    if (e instanceof IntegrationSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleDeleteIntegrationSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  const store = new IntegrationSettingsStore(env.DB);

  try {
    await store.deleteGlobal(id);

    logger.info("integration_settings.deleted", {
      event: "integration_settings.deleted",
      integration_id: id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", integrationId: id });
  } catch (e) {
    logger.error("Failed to delete integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleListRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  if (!env.DB) {
    return json({ integrationId: id, repos: [] });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repos = await store.listRepoSettings(id);
  return json({ integrationId: id, repos });
}

async function handleGetRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  const repo = `${owner}/${name}`;

  if (!env.DB) {
    return json({ integrationId: id, repo, settings: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const settings = await store.getRepoSettings(id, repo);
  return json({ integrationId: id, repo, settings });
}

async function handleSetRepoSettings(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  let body: { settings?: Record<string, unknown> };
  try {
    body = (await request.json()) as { settings?: Record<string, unknown> };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;

  try {
    await store.setRepoSettings(id, repo, body.settings);

    logger.info("integration_repo_settings.updated", {
      event: "integration_repo_settings.updated",
      integration_id: id,
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", integrationId: id, repo });
  } catch (e) {
    if (e instanceof IntegrationSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update repo integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleDeleteRepoSettings(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return error("Integration settings storage is not configured", 503);
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;

  try {
    await store.deleteRepoSettings(id, repo);

    logger.info("integration_repo_settings.deleted", {
      event: "integration_repo_settings.deleted",
      integration_id: id,
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", integrationId: id, repo });
  } catch (e) {
    logger.error("Failed to delete repo integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleGetResolvedConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const owner = match.groups?.owner;
  const name = match.groups?.name;
  if (!owner || !name) return error("Owner and name are required", 400);

  if (!env.DB) {
    return json({ integrationId: id, repo: `${owner}/${name}`, config: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
  const repo = `${owner}/${name}`;
  const { enabledRepos, settings } = await store.getResolvedConfig(id, repo);

  // GitHub-specific: drop stale reasoning effort after merge
  const reasoningEffort =
    settings.model &&
    settings.reasoningEffort &&
    !isValidReasoningEffort(settings.model, settings.reasoningEffort)
      ? null
      : (settings.reasoningEffort ?? null);

  return json({
    integrationId: id,
    repo,
    config: {
      model: settings.model ?? null,
      reasoningEffort,
      autoReviewOnOpen: settings.autoReviewOnOpen ?? true,
      enabledRepos,
    },
  });
}

export const integrationSettingsRoutes: Route[] = [
  // Integration settings — global
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleGetIntegrationSettings,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleSetIntegrationSettings,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id"),
    handler: handleDeleteIntegrationSettings,
  },
  // Integration settings — per-repo
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repos"),
    handler: handleListRepoSettings,
  },
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleGetRepoSettings,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleSetRepoSettings,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: handleDeleteRepoSettings,
  },
  // Resolved config — used by bots at runtime
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/resolved/:owner/:name"),
    handler: handleGetResolvedConfig,
  },
];
