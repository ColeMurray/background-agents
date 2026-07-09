/**
 * Integration-settings routes and handlers.
 */

import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
  isValidReasoningEffort,
  type CodeServerSettings,
  type GitHubBotSettings,
  type IntegrationId,
  type LinearBotSettings,
  type SandboxSettings,
} from "@open-inspect/shared";
import {
  IntegrationSettingsStore,
  IntegrationSettingsValidationError,
  isValidIntegrationId,
  supportsEnvironmentSettings,
} from "../db/integration-settings";
import { EnvironmentStore } from "../db/environments";
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

const logger = createLogger("router:integration-settings");

function extractIntegrationId(match: RegExpMatchArray): IntegrationId | null {
  const id = match.groups?.id;
  if (!id || !isValidIntegrationId(id)) return null;
  return id;
}

type SettingsLevel = "global" | "repo" | "environment";

/**
 * A resolved read/write target for one settings level. The three levels —
 * global defaults, per-repo overrides, per-environment overrides (design
 * §13.5) — share identical GET/PUT/DELETE plumbing (body parsing, storage
 * guards, validation-error translation, logging), so a level only describes
 * how to address its rows: the identifying fields echoed in responses and
 * logs, plus the store operations.
 */
interface SettingsScopeTarget {
  /** Identifying fields echoed in every response body. */
  fields: Record<string, string>;
  /** The same identity in snake_case for structured logs. */
  logFields: Record<string, string>;
  /** Log event prefix, e.g. "integration_repo_settings". */
  event: string;
  get(store: IntegrationSettingsStore): Promise<unknown>;
  set(store: IntegrationSettingsStore, settings: Record<string, unknown>): Promise<void>;
  remove(store: IntegrationSettingsStore): Promise<void>;
}

async function resolveScopeTarget(
  env: Env,
  match: RegExpMatchArray,
  level: SettingsLevel
): Promise<SettingsScopeTarget | Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  switch (level) {
    case "global":
      return {
        fields: { integrationId: id },
        logFields: { integration_id: id },
        event: "integration_settings",
        get: (store) => store.getGlobal(id),
        set: (store, settings) => store.setGlobal(id, settings),
        remove: (store) => store.deleteGlobal(id),
      };
    case "repo": {
      const params = extractRepoParams(match);
      if (params instanceof Response) return params;
      const repo = `${params.owner}/${params.name}`;
      return {
        fields: { integrationId: id, repo },
        logFields: { integration_id: id, repo },
        event: "integration_repo_settings",
        get: (store) => store.getRepoSettings(id, repo),
        set: (store, settings) => store.setRepoSettings(id, repo, settings),
        remove: (store) => store.deleteRepoSettings(id, repo),
      };
    }
    case "environment": {
      // Environment-level overrides exist only for the session-scoped
      // integrations, and — because the settings table is an owned child of
      // `environments` — only for environments that exist. The existence
      // check needs storage, so it is skipped when D1 is unbound and the
      // handlers' own storage guards answer instead.
      if (!supportsEnvironmentSettings(id)) {
        return error(`Integration ${id} does not support environment-level settings`, 400);
      }
      const environmentId = match.groups?.environmentId;
      if (!environmentId) return error("Environment ID required", 400);
      if (env.DB && !(await new EnvironmentStore(env.DB).getById(environmentId))) {
        return error("Environment not found", 404);
      }
      return {
        fields: { integrationId: id, environmentId },
        logFields: { integration_id: id, environment_id: environmentId },
        event: "integration_environment_settings",
        get: (store) => store.getEnvironmentSettings(id, environmentId),
        set: (store, settings) => store.setEnvironmentSettings(id, environmentId, settings),
        remove: (store) => store.deleteEnvironmentSettings(id, environmentId),
      };
    }
  }
}

/** The GET/PUT/DELETE handler trio for one settings level. */
function settingsHandlers(level: SettingsLevel): {
  get: Route["handler"];
  set: Route["handler"];
  remove: Route["handler"];
} {
  return {
    get: async (_request, env, match, _ctx) => {
      const target = await resolveScopeTarget(env, match, level);
      if (target instanceof Response) return target;

      if (!env.DB) {
        return json({ ...target.fields, settings: null });
      }

      const settings = await target.get(new IntegrationSettingsStore(env.DB));
      return json({ ...target.fields, settings });
    },

    set: async (request, env, match, ctx) => {
      const target = await resolveScopeTarget(env, match, level);
      if (target instanceof Response) return target;

      if (!env.DB) {
        return error("Integration settings storage is not configured", 503);
      }

      const body = await parseJsonBody<{ settings?: Record<string, unknown> }>(request);
      if (body instanceof Response) return body;

      if (!body?.settings || typeof body.settings !== "object") {
        return error("Request body must include settings object", 400);
      }

      try {
        await target.set(new IntegrationSettingsStore(env.DB), body.settings);

        logger.info(`${target.event}.updated`, {
          event: `${target.event}.updated`,
          ...target.logFields,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });

        return json({ status: "updated", ...target.fields });
      } catch (e) {
        if (e instanceof IntegrationSettingsValidationError) {
          return error(e.message, 400);
        }
        logger.error(`Failed to update ${level} integration settings`, {
          error: e instanceof Error ? e.message : String(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        return error("Integration settings storage unavailable", 503);
      }
    },

    remove: async (_request, env, match, ctx) => {
      const target = await resolveScopeTarget(env, match, level);
      if (target instanceof Response) return target;

      if (!env.DB) {
        return error("Integration settings storage is not configured", 503);
      }

      try {
        await target.remove(new IntegrationSettingsStore(env.DB));

        logger.info(`${target.event}.deleted`, {
          event: `${target.event}.deleted`,
          ...target.logFields,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });

        return json({ status: "deleted", ...target.fields });
      } catch (e) {
        logger.error(`Failed to delete ${level} integration settings`, {
          error: e instanceof Error ? e.message : String(e),
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        });
        return error("Integration settings storage unavailable", 503);
      }
    },
  };
}

const globalSettings = settingsHandlers("global");
const repoSettings = settingsHandlers("repo");
const environmentSettings = settingsHandlers("environment");

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

async function handleGetResolvedConfig(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const id = extractIntegrationId(match);
  if (!id) return error(`Unknown integration: ${match.groups?.id}`, 404);

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  if (!env.DB) {
    return json({ integrationId: id, repo: `${owner}/${name}`, config: null });
  }

  const store = new IntegrationSettingsStore(env.DB);
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
        enabledRepos,
      },
    });
  }

  return error(`Unsupported integration: ${id}`, 400);
}

export const integrationSettingsRoutes: Route[] = [
  // Integration settings — global
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id"),
    handler: globalSettings.get,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id"),
    handler: globalSettings.set,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id"),
    handler: globalSettings.remove,
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
    handler: repoSettings.get,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: repoSettings.set,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id/repos/:owner/:name"),
    handler: repoSettings.remove,
  },
  // Integration settings — per-environment (design §13.5; sandbox and
  // code-server only)
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/environments/:environmentId"),
    handler: environmentSettings.get,
  },
  {
    method: "PUT",
    pattern: parsePattern("/integration-settings/:id/environments/:environmentId"),
    handler: environmentSettings.set,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/integration-settings/:id/environments/:environmentId"),
    handler: environmentSettings.remove,
  },
  // Resolved config — used by bots at runtime
  {
    method: "GET",
    pattern: parsePattern("/integration-settings/:id/resolved/:owner/:name"),
    handler: handleGetResolvedConfig,
  },
];
