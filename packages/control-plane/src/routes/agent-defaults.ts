/**
 * Agent defaults routes: per-user, per-repo default OpenCode agent.
 */

import { AgentDefaultsStore } from "../db/agent-defaults";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:agent-defaults");

async function handleGetAgentDefaults(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Agent defaults storage is not configured", 503);
  }

  const url = new URL(_request.url);
  const userId = url.searchParams.get("userId");
  if (!userId) {
    return error("userId is required", 400);
  }

  const repoOwner = url.searchParams.get("repoOwner");
  const repoName = url.searchParams.get("repoName");

  const store = new AgentDefaultsStore(env.DB);

  try {
    if (repoOwner != null && repoName != null) {
      const defaultAgent = await store.get(userId, repoOwner, repoName);
      return json({ defaultAgent });
    }
    const all = await store.getAllForUser(userId);
    return json({ defaults: all });
  } catch (e) {
    logger.error("Failed to get agent defaults", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get agent defaults", 500);
  }
}

async function handleSetAgentDefaults(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) {
    return error("Agent defaults storage is not configured", 503);
  }

  let body: {
    userId?: string;
    repoOwner?: string;
    repoName?: string;
    defaultAgent?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  const { userId, repoOwner, repoName, defaultAgent } = body;
  if (!userId || !repoOwner || !repoName) {
    return error("userId, repoOwner, and repoName are required", 400);
  }

  const store = new AgentDefaultsStore(env.DB);

  try {
    await store.set(userId, repoOwner, repoName, defaultAgent ?? null);

    logger.info("agent_defaults.updated", {
      event: "agent_defaults.updated",
      user_id: userId,
      repo_owner: repoOwner,
      repo_name: repoName,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ status: "updated", defaultAgent: defaultAgent ?? null });
  } catch (e) {
    logger.error("Failed to update agent defaults", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to update agent defaults", 500);
  }
}

export const agentDefaultsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/agent-defaults"),
    handler: handleGetAgentDefaults,
  },
  {
    method: "PUT",
    pattern: parsePattern("/agent-defaults"),
    handler: handleSetAgentDefaults,
  },
];
