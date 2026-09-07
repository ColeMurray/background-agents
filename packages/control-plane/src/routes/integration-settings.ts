/**
 * Integration-settings routes and handlers.
 */

import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  type CodeServerSettings,
  type EnvironmentSettingsIntegrationId,
  type GitHubBotSettings,
  type IntegrationId,
  type LinearBotSettings,
  type SandboxSettings,
  type VncSettings,
} from "@open-inspect/shared/types/integrations";
import { isValidReasoningEffort } from "@open-inspect/shared/models";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
  supportsEnvironmentSettings,
} from "../db/integration-settings";
import { Hono } from "hono";
import { EnvironmentStore } from "../db/environments";
import type { Env } from "../types";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { repositoryParams } from "./repository-params";
import {
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  error,
  requirePermission,
} from "./shared";
import { parseJsonBody } from "./body";

const logger = createLogger("router:integration-settings");

function integrationId(id: string): IntegrationId | null {
  return isValidIntegrationId(id) ? id : null;
}

/**
 * Common validation for the environment-level settings handlers: a known
 * integration that supports the environment level (design §13.5), an
 * environment id, and — because the settings table is an owned child of
 * `environments` — an environment that actually exists.
 */
async function environmentSettingsParams(
  db: SqlDatabase,
  params: { id: string; environmentId: string }
): Promise<
  | {
      integrationId: EnvironmentSettingsIntegrationId;
      environmentId: string;
      store: IntegrationSettingsStore;
    }
  | Response
> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);
  if (!supportsEnvironmentSettings(id)) {
    return error(`Integration ${id} does not support environment-level settings`, 400);
  }

  const { environmentId } = params;

  const environmentStore = new EnvironmentStore(db);
  if (!(await environmentStore.getById(environmentId))) {
    return error("Environment not found", 404);
  }

  return { integrationId: id, environmentId, store: new IntegrationSettingsStore(db) };
}

async function handleGetIntegrationSettings(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const store = new IntegrationSettingsStore(ctx.db);
  const settings = await store.getGlobal(id);
  return json({ integrationId: id, settings });
}

async function handleSetIntegrationSettings(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const body = await parseJsonBody<{ settings?: Record<string, unknown> }>(request);
  if (body instanceof Response) return body;

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(ctx.db);

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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const store = new IntegrationSettingsStore(ctx.db);

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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const store = new IntegrationSettingsStore(ctx.db);
  const repos = await store.listRepoSettings(id);
  return json({ integrationId: id, repos });
}

async function handleGetRepoSettings(
  _request: Request,
  env: Env,
  params: { id: string; owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const repo = `${owner}/${name}`;

  const store = new IntegrationSettingsStore(ctx.db);
  const settings = await store.getRepoSettings(id, repo);
  return json({ integrationId: id, repo, settings });
}

async function handleSetRepoSettings(
  request: Request,
  env: Env,
  params: { id: string; owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const body = await parseJsonBody<{ settings?: Record<string, unknown> }>(request);
  if (body instanceof Response) return body;

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  const store = new IntegrationSettingsStore(ctx.db);
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
  params: { id: string; owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const store = new IntegrationSettingsStore(ctx.db);
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

async function handleGetEnvironmentSettings(
  _request: Request,
  env: Env,
  params: { id: string; environmentId: string },
  ctx: RequestContext
): Promise<Response> {
  const settingsParams = await environmentSettingsParams(ctx.db, params);
  if (settingsParams instanceof Response) return settingsParams;
  const { integrationId, environmentId, store } = settingsParams;

  const settings = await store.getEnvironmentSettings(integrationId, environmentId);
  return json({ integrationId, environmentId, settings });
}

async function handleSetEnvironmentSettings(
  request: Request,
  env: Env,
  params: { id: string; environmentId: string },
  ctx: RequestContext
): Promise<Response> {
  const settingsParams = await environmentSettingsParams(ctx.db, params);
  if (settingsParams instanceof Response) return settingsParams;
  const { integrationId, environmentId, store } = settingsParams;

  const body = await parseJsonBody<{ settings?: Record<string, unknown> }>(request);
  if (body instanceof Response) return body;

  if (!body?.settings || typeof body.settings !== "object") {
    return error("Request body must include settings object", 400);
  }

  try {
    await store.setEnvironmentSettings(integrationId, environmentId, body.settings);

    logger.info("integration_environment_settings.updated", {
      event: "integration_environment_settings.updated",
      integration_id: integrationId,
      environment_id: environmentId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", integrationId, environmentId });
  } catch (e) {
    if (e instanceof IntegrationSettingsValidationError) {
      return error(e.message, 400);
    }
    logger.error("Failed to update environment integration settings", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Integration settings storage unavailable", 503);
  }
}

async function handleDeleteEnvironmentSettings(
  _request: Request,
  env: Env,
  params: { id: string; environmentId: string },
  ctx: RequestContext
): Promise<Response> {
  const settingsParams = await environmentSettingsParams(ctx.db, params);
  if (settingsParams instanceof Response) return settingsParams;
  const { integrationId, environmentId, store } = settingsParams;

  try {
    await store.deleteEnvironmentSettings(integrationId, environmentId);

    logger.info("integration_environment_settings.deleted", {
      event: "integration_environment_settings.deleted",
      integration_id: integrationId,
      environment_id: environmentId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "deleted", integrationId, environmentId });
  } catch (e) {
    logger.error("Failed to delete environment integration settings", {
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
  params: { id: string; owner: string; name: string },
  ctx: RequestContext
): Promise<Response> {
  const id = integrationId(params.id);
  if (!id) return error(`Unknown integration: ${params.id}`, 404);

  const repository = repositoryParams(params);
  if (repository instanceof Response) return repository;
  const { owner, name } = repository;

  const store = new IntegrationSettingsStore(ctx.db);
  const repo = `${owner}/${name}`;
  const { enabledRepos, settings } = await store.getResolvedConfig(id, repo);

  if (id === "github") {
    const githubSettings = settings as GitHubBotSettings;
    const reasoningEffort =
      githubSettings.model &&
      githubSettings.reasoningEffort &&
      !isValidReasoningEffort(githubSettings.model, githubSettings.reasoningEffort)
        ? null
        : (githubSettings.reasoningEffort ?? null);

    return json({
      integrationId: id,
      repo,
      config: {
        model: githubSettings.model ?? null,
        reasoningEffort,
        autoReviewOnOpen: githubSettings.autoReviewOnOpen ?? true,
        enabledRepos,
        allowedTriggerUsers: githubSettings.allowedTriggerUsers ?? null,
        codeReviewInstructions: githubSettings.codeReviewInstructions ?? null,
        commentActionInstructions: githubSettings.commentActionInstructions ?? null,
      },
    });
  }

  if (id === "linear") {
    const linearSettings = settings as LinearBotSettings;
    const linearReasoningEffort =
      linearSettings.model &&
      linearSettings.reasoningEffort &&
      !isValidReasoningEffort(linearSettings.model, linearSettings.reasoningEffort)
        ? null
        : (linearSettings.reasoningEffort ?? null);

    return json({
      integrationId: id,
      repo,
      config: {
        model: linearSettings.model ?? null,
        reasoningEffort: linearReasoningEffort,
        allowUserPreferenceOverride: linearSettings.allowUserPreferenceOverride ?? true,
        allowLabelModelOverride: linearSettings.allowLabelModelOverride ?? true,
        emitToolProgressActivities: linearSettings.emitToolProgressActivities ?? true,
        issueSessionInstructions: linearSettings.issueSessionInstructions ?? null,
        enabledRepos,
      },
    });
  }

  if (id === "code-server") {
    const codeServerSettings = settings as CodeServerSettings;
    return json({
      integrationId: id,
      repo,
      config: {
        enabled: codeServerSettings.enabled ?? false,
        enabledRepos,
      },
    });
  }

  if (id === "vnc") {
    const vncSettings = settings as VncSettings;
    return json({
      integrationId: id,
      repo,
      config: {
        enabled: vncSettings.enabled ?? false,
        enabledRepos,
      },
    });
  }

  if (id === "sandbox") {
    const sandboxSettings = settings as SandboxSettings;
    return json({
      integrationId: id,
      repo,
      config: {
        tunnelPorts: sandboxSettings.tunnelPorts ?? [],
        terminalEnabled: sandboxSettings.terminalEnabled ?? false,
        maxConcurrentChildSessions:
          sandboxSettings.maxConcurrentChildSessions ?? DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
        maxTotalChildSessions:
          sandboxSettings.maxTotalChildSessions ?? DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
        // null → use the provider's default reservation (no override configured).
        cpuCores: sandboxSettings.cpuCores ?? null,
        memoryMib: sandboxSettings.memoryMib ?? null,
        sandboxTimeoutMs: sandboxSettings.sandboxTimeoutMs ?? null,
        enabledRepos,
      },
    });
  }

  return error(`Unsupported integration: ${id}`, 400);
}

const INTEGRATIONS_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("integrations.read"),
});
const INTEGRATIONS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("integrations.manage"),
});
const REPO_SETTINGS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("repositories.settings.manage"),
});
const ENVIRONMENT_SETTINGS_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("environments.settings.manage"),
});

export const integrationSettingsRoutes = new Hono<ControlPlaneHonoEnv>();

// Integration settings — global
integrationSettingsRoutes.get(
  "/integration-settings/:id",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("integrations.read", {
      actorlessGrants: [{ service: "slack-bot", pathParams: { id: "slack" } }],
    }),
  }),
  (c) => dispatch(c, handleGetIntegrationSettings)
);
integrationSettingsRoutes.put("/integration-settings/:id", INTEGRATIONS_MANAGE, (c) =>
  dispatch(c, handleSetIntegrationSettings)
);
integrationSettingsRoutes.delete("/integration-settings/:id", INTEGRATIONS_MANAGE, (c) =>
  dispatch(c, handleDeleteIntegrationSettings)
);
// Integration settings — per-repo
integrationSettingsRoutes.get("/integration-settings/:id/repos", INTEGRATIONS_READ, (c) =>
  dispatch(c, handleListRepoSettings)
);
integrationSettingsRoutes.get(
  "/integration-settings/:id/repos/:owner/:name",
  INTEGRATIONS_READ,
  (c) => dispatch(c, handleGetRepoSettings)
);
integrationSettingsRoutes.put(
  "/integration-settings/:id/repos/:owner/:name",
  REPO_SETTINGS_MANAGE,
  (c) => dispatch(c, handleSetRepoSettings)
);
integrationSettingsRoutes.delete(
  "/integration-settings/:id/repos/:owner/:name",
  REPO_SETTINGS_MANAGE,
  (c) => dispatch(c, handleDeleteRepoSettings)
);
// Integration settings — per-environment (design §13.5; sandbox and
// code-server, and VNC only)
integrationSettingsRoutes.get(
  "/integration-settings/:id/environments/:environmentId",
  INTEGRATIONS_READ,
  (c) => dispatch(c, handleGetEnvironmentSettings)
);
integrationSettingsRoutes.put(
  "/integration-settings/:id/environments/:environmentId",
  ENVIRONMENT_SETTINGS_MANAGE,
  (c) => dispatch(c, handleSetEnvironmentSettings)
);
integrationSettingsRoutes.delete(
  "/integration-settings/:id/environments/:environmentId",
  ENVIRONMENT_SETTINGS_MANAGE,
  (c) => dispatch(c, handleDeleteEnvironmentSettings)
);
// Resolved config — used by bots at runtime
integrationSettingsRoutes.get(
  "/integration-settings/:id/resolved/:owner/:name",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("integrations.read", {
      actorlessGrants: [
        { service: "github-bot", pathParams: { id: "github" } },
        { service: "linear-bot", pathParams: { id: "linear" } },
      ],
    }),
  }),
  (c) => dispatch(c, handleGetResolvedConfig)
);
