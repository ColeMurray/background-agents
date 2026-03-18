/**
 * MCP server configuration routes.
 */

import type { McpServerConfig } from "@open-inspect/shared";
import { McpServerStore, McpServerValidationError } from "../db/mcp-servers";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:mcp-servers");

async function handleListMcpServers(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("Database not configured", 503);

  const url = new URL(request.url);
  const repo = url.searchParams.get("repo") ?? undefined;

  const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
  const servers = await store.list(repo);
  logger.info("MCP servers listed", {
    event: "mcp_server.list",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    count: servers.length,
  });
  return json(servers);
}

async function handleGetMcpServer(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing server ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
  const server = await store.get(id);
  if (!server) return error("MCP server not found", 404);
  logger.info("MCP server retrieved", {
    event: "mcp_server.get",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json(server);
}

async function handleCreateMcpServer(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  if (!env.DB) return error("Database not configured", 503);

  let body: Partial<McpServerConfig>;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.name || typeof body.name !== "string") {
    return error("name is required", 400);
  }
  if (body.type !== "stdio" && body.type !== "remote") {
    return error("type must be 'stdio' or 'remote'", 400);
  }

  try {
    const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    const server = await store.create({
      name: body.name,
      type: body.type,
      command: body.command,
      url: body.url,
      env: body.env,
      repoScopes: body.repoScopes ?? null,
      enabled: body.enabled !== false,
    });
    logger.info("MCP server created", {
      event: "mcp_server.created",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id: server.id,
      name: server.name,
    });
    return json(server, 201);
  } catch (err) {
    if (err instanceof McpServerValidationError) {
      return error(err.message, 400);
    }
    return error("Failed to create MCP server", 503);
  }
}

async function handleUpdateMcpServer(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing server ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  let body: Partial<McpServerConfig>;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  try {
    const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    const updated = await store.update(id, body);
    if (!updated) return error("MCP server not found", 404);

    logger.info("MCP server updated", {
      event: "mcp_server.updated",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
    });
    return json(updated);
  } catch (err) {
    if (err instanceof McpServerValidationError) {
      return error(err.message, 400);
    }
    return error("Failed to update MCP server", 503);
  }
}

async function handleDeleteMcpServer(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Missing server ID", 400);
  if (!env.DB) return error("Database not configured", 503);

  const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
  const deleted = await store.delete(id);
  if (!deleted) return error("MCP server not found", 404);

  logger.info("MCP server deleted", {
    event: "mcp_server.deleted",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json({ ok: true });
}

export const mcpServerRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/mcp-servers"),
    handler: handleListMcpServers,
  },
  {
    method: "POST",
    pattern: parsePattern("/mcp-servers"),
    handler: handleCreateMcpServer,
  },
  {
    method: "GET",
    pattern: parsePattern("/mcp-servers/:id"),
    handler: handleGetMcpServer,
  },
  {
    method: "PUT",
    pattern: parsePattern("/mcp-servers/:id"),
    handler: handleUpdateMcpServer,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/mcp-servers/:id"),
    handler: handleDeleteMcpServer,
  },
];
