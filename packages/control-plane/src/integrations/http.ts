import githubApp from "@open-inspect/github-bot/app";
import type { Env as GitHubEnv } from "@open-inspect/github-bot/types";
import linearApp from "@open-inspect/linear-bot/app";
import type { Env as LinearEnv } from "@open-inspect/linear-bot/types";
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import slackApp from "@open-inspect/slack-bot/app";
import type { Env as SlackEnv } from "@open-inspect/slack-bot/types";
import type { ExecutionContext } from "hono";
import type { Env } from "../types";

export const INTEGRATION_PREFIXES = {
  slack: "/integrations/slack",
  linear: "/integrations/linear",
  github: "/integrations/github",
} as const;

type Integration = keyof typeof INTEGRATION_PREFIXES;

function integrationFor(pathname: string): Integration | null {
  for (const [integration, prefix] of Object.entries(INTEGRATION_PREFIXES) as Array<
    [Integration, string]
  >) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return integration;
  }
  return null;
}

function withoutPrefix(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(prefix.length) || "/";
  return new Request(url, request);
}

function unavailable(integration: Integration): Response {
  return Response.json({ error: `${integration} integration is not configured` }, { status: 503 });
}

export function buildSlackEnv(env: Env, controlPlane: ControlPlaneFetcher): SlackEnv | null {
  if (
    !env.SLACK_KV ||
    !env.SLACK_BOT_TOKEN ||
    !env.SLACK_SIGNING_SECRET ||
    !env.SLACK_BOT_DEFAULT_MODEL ||
    !env.CLASSIFICATION_MODEL ||
    !env.WEB_APP_URL ||
    !env.SERVICE_AUTH_SECRET_SLACK_BOT
  ) {
    return null;
  }
  return {
    SLACK_KV: env.SLACK_KV,
    SLACK_COMPLETION_QUEUE: {
      send: (payload) => env.JOBS.send({ kind: "slack.completion", payload }),
    },
    CONTROL_PLANE: controlPlane,
    DEPLOYMENT_NAME: env.DEPLOYMENT_NAME,
    CONTROL_PLANE_URL: env.WORKER_URL ?? "https://internal",
    WEB_APP_URL: env.WEB_APP_URL,
    DEFAULT_MODEL: env.SLACK_BOT_DEFAULT_MODEL,
    CLASSIFICATION_MODEL: env.CLASSIFICATION_MODEL,
    APP_NAME: env.APP_NAME,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    SERVICE_AUTH_SECRET: env.SERVICE_AUTH_SECRET_SLACK_BOT,
    LOG_LEVEL: env.LOG_LEVEL,
  };
}

export function buildLinearEnv(
  env: Env,
  controlPlane: ControlPlaneFetcher,
  origin: string
): LinearEnv | null {
  if (
    !env.LINEAR_KV ||
    !env.LINEAR_CLIENT_ID ||
    !env.LINEAR_CLIENT_SECRET ||
    !env.LINEAR_WEBHOOK_SECRET ||
    !env.LINEAR_BOT_DEFAULT_MODEL ||
    !env.WEB_APP_URL ||
    !env.SERVICE_AUTH_SECRET_LINEAR_BOT
  ) {
    return null;
  }
  return {
    LINEAR_KV: env.LINEAR_KV,
    LINEAR_COMPLETION_QUEUE: {
      send: (payload) => env.JOBS.send({ kind: "linear.completion", payload }),
    },
    CONTROL_PLANE: controlPlane,
    DEPLOYMENT_NAME: env.DEPLOYMENT_NAME,
    CONTROL_PLANE_URL: env.WORKER_URL ?? "https://internal",
    WEB_APP_URL: env.WEB_APP_URL,
    DEFAULT_MODEL: env.LINEAR_BOT_DEFAULT_MODEL,
    APP_NAME: env.APP_NAME,
    LINEAR_CLIENT_ID: env.LINEAR_CLIENT_ID,
    LINEAR_CLIENT_SECRET: env.LINEAR_CLIENT_SECRET,
    WORKER_URL: new URL(INTEGRATION_PREFIXES.linear, origin).toString(),
    LINEAR_WEBHOOK_SECRET: env.LINEAR_WEBHOOK_SECRET,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    CLASSIFICATION_MODEL: env.CLASSIFICATION_MODEL,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    SERVICE_AUTH_SECRET: env.SERVICE_AUTH_SECRET_LINEAR_BOT,
    LOG_LEVEL: env.LOG_LEVEL,
  };
}

export function buildGitHubEnv(env: Env, controlPlane: ControlPlaneFetcher): GitHubEnv | null {
  if (
    !env.GITHUB_KV ||
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_APP_INSTALLATION_ID ||
    !env.GITHUB_WEBHOOK_SECRET ||
    !env.GITHUB_BOT_DEFAULT_MODEL ||
    !env.SERVICE_AUTH_SECRET_GITHUB_BOT
  ) {
    return null;
  }
  return {
    GITHUB_KV: env.GITHUB_KV,
    AUTOFIX_QUEUE: {
      send: (payload) => env.JOBS.send({ kind: "github.autofix", payload }),
    },
    CONTROL_PLANE: controlPlane,
    DEPLOYMENT_NAME: env.DEPLOYMENT_NAME,
    APP_NAME: env.APP_NAME,
    DEFAULT_MODEL: env.GITHUB_BOT_DEFAULT_MODEL,
    GITHUB_BOT_USERNAME: env.GITHUB_BOT_USERNAME,
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
    SERVICE_AUTH_SECRET: env.SERVICE_AUTH_SECRET_GITHUB_BOT,
    LOG_LEVEL: env.LOG_LEVEL,
  };
}

async function fetchIntegration(
  integration: Integration,
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  controlPlane: ControlPlaneFetcher
): Promise<Response> {
  switch (integration) {
    case "slack": {
      const bindings = buildSlackEnv(env, controlPlane);
      return bindings ? slackApp.fetch(request, bindings, executionCtx) : unavailable(integration);
    }
    case "linear": {
      const bindings = buildLinearEnv(env, controlPlane, new URL(request.url).origin);
      return bindings ? linearApp.fetch(request, bindings, executionCtx) : unavailable(integration);
    }
    case "github": {
      const bindings = buildGitHubEnv(env, controlPlane);
      return bindings ? githubApp.fetch(request, bindings, executionCtx) : unavailable(integration);
    }
  }
}

/** In-process FetchClient used by session callbacks after bot consolidation. */
export function createIntegrationFetchClient(
  integration: Integration,
  env: Env,
  executionCtx: ExecutionContext,
  controlPlane: ControlPlaneFetcher
): ControlPlaneFetcher {
  return {
    fetch: (input, init) =>
      fetchIntegration(integration, new Request(input, init), env, executionCtx, controlPlane),
  };
}

/** Route the control plane's internal Slack and Linear calls to its co-located apps. */
export function attachIntegrationClients(
  env: Env,
  executionCtx: ExecutionContext,
  controlPlane: ControlPlaneFetcher
): void {
  env.SLACK_BOT = createIntegrationFetchClient("slack", env, executionCtx, controlPlane);
  env.LINEAR_BOT = createIntegrationFetchClient("linear", env, executionCtx, controlPlane);
}

/** Serve a co-located integration, or return null for an ordinary control-plane request. */
export async function handleIntegrationHttp(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  controlPlane: ControlPlaneFetcher
): Promise<Response | null> {
  const url = new URL(request.url);
  const integration = integrationFor(url.pathname);
  if (!integration) return null;

  return fetchIntegration(
    integration,
    withoutPrefix(request, INTEGRATION_PREFIXES[integration]),
    env,
    executionCtx,
    controlPlane
  );
}
