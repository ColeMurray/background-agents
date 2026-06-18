/**
 * SCM (source-control) settings routes.
 *
 * SCM settings are a top-level setting, separate from the integration-settings
 * framework. They control how sessions open pull/merge requests (e.g. always as
 * drafts) for both GitHub and GitLab.
 */

import type { ScmGlobalConfig, ScmSettings } from "@open-inspect/shared";
import { ScmSettingsStore, ScmSettingsValidationError } from "../db/scm-settings";
import type { Env } from "../types";
import { createLogger } from "../logger";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  extractRepoParams,
} from "./shared";

const logger = createLogger("router:scm-settings");

async function handleGetGlobal(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return json({ settings: null });
  }
  const store = new ScmSettingsStore(env.DB);
  const settings = await store.getGlobal();
  return json({ settings });
}

async function handleSetGlobal(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("SCM settings storage is not configured", 503);
  }

  const body = await parseJsonBody<{ settings?: ScmGlobalConfig }>(request);
  if (body instanceof Response) return body;

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new ScmSettingsStore(env.DB);

  try {
    await store.setGlobal(body.settings);
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
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("SCM settings storage is not configured", 503);
  }

  const store = new ScmSettingsStore(env.DB);

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
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return json({ repos: [] });
  }
  const store = new ScmSettingsStore(env.DB);
  const repos = await store.listRepoSettings();
  return json({ repos });
}

async function handleSetRepoSettings(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;
  const repo = `${owner}/${name}`;

  if (!env.DB) {
    return error("SCM settings storage is not configured", 503);
  }

  const body = await parseJsonBody<{ settings?: ScmSettings }>(request);
  if (body instanceof Response) return body;

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new ScmSettingsStore(env.DB);

  try {
    await store.setRepoSettings(repo, body.settings);
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
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;
  const repo = `${owner}/${name}`;

  if (!env.DB) {
    return error("SCM settings storage is not configured", 503);
  }

  const store = new ScmSettingsStore(env.DB);

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

export const scmSettingsRoutes: Route[] = [
  { method: "GET", pattern: parsePattern("/scm-settings"), handler: handleGetGlobal },
  { method: "PUT", pattern: parsePattern("/scm-settings"), handler: handleSetGlobal },
  { method: "DELETE", pattern: parsePattern("/scm-settings"), handler: handleDeleteGlobal },
  { method: "GET", pattern: parsePattern("/scm-settings/repos"), handler: handleListRepoSettings },
  {
    method: "PUT",
    pattern: parsePattern("/scm-settings/repos/:owner/:name"),
    handler: handleSetRepoSettings,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/scm-settings/repos/:owner/:name"),
    handler: handleDeleteRepoSettings,
  },
];
