/**
 * SCM (source-control) settings routes.
 *
 * SCM settings are a top-level setting, separate from the integration-settings
 * framework. They control how sessions open pull/merge requests (e.g. always as
 * drafts) for both GitHub and GitLab.
 */

import {
  scmGlobalConfigSchema,
  scmSettingsSchema,
  type ScmGlobalConfig,
  type ScmRepoSettings,
} from "@open-inspect/shared/types/integrations";
import { ScmSettingsStore, ScmSettingsValidationError } from "../db/scm-settings";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  json,
  error,
  parseJsonBody,
  extractRepoParams,
  requirePermission,
} from "./shared";

const logger = createLogger("router:scm-settings");

function parseScmGlobalSettingsBody(body: unknown): ScmGlobalConfig | Response {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("settings" in body)) {
    return error("Request body must include settings object", 400);
  }

  const parsed = scmGlobalConfigSchema.safeParse(body.settings);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid settings", 400);
  return parsed.data;
}

function parseScmRepoSettingsBody(body: unknown): ScmRepoSettings | Response {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("settings" in body)) {
    return error("Request body must include settings object", 400);
  }

  const parsed = scmSettingsSchema.safeParse(body.settings);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid settings", 400);
  return parsed.data;
}

async function handleGetGlobal(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = new ScmSettingsStore(ctx.db);
  try {
    const settings = await store.getGlobal();
    return json({ settings });
  } catch (e) {
    logger.error("Failed to fetch SCM settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

async function handleSetGlobal(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const settings = parseScmGlobalSettingsBody(body);
  if (settings instanceof Response) return settings;

  const store = new ScmSettingsStore(ctx.db);

  try {
    await store.setGlobal(settings);
    logger.info("scm_settings.updated", {
      event: "scm_settings.updated",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ status: "updated" });
  } catch (e) {
    if (e instanceof ScmSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update SCM settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

async function handleDeleteGlobal(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = new ScmSettingsStore(ctx.db);

  try {
    await store.deleteGlobal();
    logger.info("scm_settings.deleted", {
      event: "scm_settings.deleted",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ status: "deleted" });
  } catch (e) {
    logger.error("Failed to delete SCM settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

async function handleListRepoSettings(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const store = new ScmSettingsStore(ctx.db);
  try {
    const repos = await store.listRepoSettings();
    return json({ repos });
  } catch (e) {
    logger.error("Failed to list SCM repo settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

async function handleSetRepoSettings(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;
  const repo = `${owner}/${name}`;

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const settings = parseScmRepoSettingsBody(body);
  if (settings instanceof Response) return settings;

  const store = new ScmSettingsStore(ctx.db);

  try {
    await store.setRepoSettings(repo, settings);
    logger.info("scm_repo_settings.updated", {
      event: "scm_repo_settings.updated",
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ status: "updated", repo });
  } catch (e) {
    if (e instanceof ScmSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update SCM repo settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

async function handleDeleteRepoSettings(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;
  const repo = `${owner}/${name}`;

  const store = new ScmSettingsStore(ctx.db);

  try {
    await store.deleteRepoSettings(repo);
    logger.info("scm_repo_settings.deleted", {
      event: "scm_repo_settings.deleted",
      repo,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({ status: "deleted", repo });
  } catch (e) {
    logger.error("Failed to delete SCM repo settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("SCM settings storage unavailable", 503);
  }
}

export const scmSettingsRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "GET",
    path: "/scm-settings",
    authorization: requirePermission("integrations.read"),
    handler: handleGetGlobal,
  },
  {
    method: "PUT",
    path: "/scm-settings",
    authorization: requirePermission("scm_settings.manage"),
    handler: handleSetGlobal,
  },
  {
    method: "DELETE",
    path: "/scm-settings",
    authorization: requirePermission("scm_settings.manage"),
    handler: handleDeleteGlobal,
  },
  {
    method: "GET",
    path: "/scm-settings/repos",
    authorization: requirePermission("integrations.read"),
    handler: handleListRepoSettings,
  },
  {
    method: "PUT",
    path: "/scm-settings/repos/:owner/:name",
    authorization: requirePermission("scm_settings.manage"),
    handler: handleSetRepoSettings,
  },
  {
    method: "DELETE",
    path: "/scm-settings/repos/:owner/:name",
    authorization: requirePermission("scm_settings.manage"),
    handler: handleDeleteRepoSettings,
  },
]);
