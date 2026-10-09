import { parseBody } from "./body";
import {
  createMcpServerInputSchema,
  updateMcpServerInputSchema,
} from "@open-inspect/shared/types/integrations";
import {
  McpServerConflictError,
  McpServerStore,
  McpServerValidationError,
} from "../db/mcp-servers";
import { Hono } from "hono";
import type { Env } from "../types";
import { createLogger } from "../logger";
import { McpToolDiscoveryError, discoverRemoteMcpTools } from "../mcp/tool-discovery";
import { requireRepoSecretsEncryptionKey } from "../env-validation";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  type RequestContext,
  json,
  error,
  requirePermission,
} from "./shared";

const logger = createLogger("router:mcp-servers");

async function handleListMcpServers(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);

  const url = new URL(request.url);
  const repo = url.searchParams.get("repo") ?? undefined;

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
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
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);

  const parsed = await parseBody(
    request,
    createMcpServerInputSchema,
    "Invalid MCP server configuration"
  );
  if (parsed instanceof Response) return parsed;

  const encryptionKey = requireRepoSecretsEncryptionKey(env);
  try {
    const store = new McpServerStore(ctx.db, encryptionKey);
    const server = await store.create(parsed);
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
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);

  const parsed = await parseBody(
    request,
    updateMcpServerInputSchema,
    "Invalid MCP server configuration"
  );
  if (parsed instanceof Response) return parsed;

  const encryptionKey = requireRepoSecretsEncryptionKey(env);
  try {
    const store = new McpServerStore(ctx.db, encryptionKey);
    const { revision, ...patch } = parsed;
    const updated = await store.update(id, patch, revision);
    if (!updated) return error("MCP server not found", 404);

    logger.info("MCP server updated", {
      event: "mcp_server.updated",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
    });
    return json(updated);
  } catch (err) {
    if (err instanceof McpServerConflictError) {
      return error(err.message, 409);
    }
    if (err instanceof McpServerValidationError) {
      return error(err.message, 400);
    }
    return error("Failed to update MCP server", 503);
  }
}

async function handleDeleteMcpServer(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
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

/** Connects to a saved remote server with its stored headers and lists its tools. */
/** The underlying error messages, for logs only: they can quote the server's response. */
function causeMessage(cause: unknown): string | undefined {
  if (cause instanceof AggregateError) {
    return cause.errors.map((error) => causeMessage(error)).join("; ");
  }
  return cause instanceof Error ? cause.message : undefined;
}

async function handleDiscoverMcpTools(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const { id } = params;
  if (!ctx.db) return error("Database not configured", 503);

  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  const server = await store.getDecrypted(id);
  if (!server) return error("MCP server not found", 404);
  if (server.type !== "remote") {
    return error("Only remote MCP servers can list their tools", 400);
  }

  try {
    const tools = await discoverRemoteMcpTools(server);
    logger.info("MCP server tools discovered", {
      event: "mcp_server.tools_discovered",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
      tool_count: tools.length,
    });
    return json({ tools });
  } catch (err) {
    logger.warn("MCP server tool discovery failed", {
      event: "mcp_server.tool_discovery_failed",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      id,
      error: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error ? causeMessage(err.cause) : undefined,
    });
    const reason = err instanceof McpToolDiscoveryError ? `: ${err.message}` : "";
    return error(`Could not load tools from the MCP server${reason}`, 502);
  }
}

const MCP_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("mcp_servers.read"),
});
const MCP_MANAGE = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("mcp_servers.manage"),
});

export const mcpServerRoutes = new Hono<ControlPlaneHonoEnv>();

mcpServerRoutes.get("/mcp-servers", MCP_READ, (c) => dispatch(c, handleListMcpServers));
mcpServerRoutes.post("/mcp-servers", MCP_MANAGE, (c) => dispatch(c, handleCreateMcpServer));
mcpServerRoutes.get("/mcp-servers/:id", MCP_READ, (c) => dispatch(c, handleGetMcpServer));
mcpServerRoutes.put("/mcp-servers/:id", MCP_MANAGE, (c) => dispatch(c, handleUpdateMcpServer));
mcpServerRoutes.delete("/mcp-servers/:id", MCP_MANAGE, (c) => dispatch(c, handleDeleteMcpServer));
// Manage, not read: the control plane connects out with the server's stored credentials.
mcpServerRoutes.post("/mcp-servers/:id/tools", MCP_MANAGE, (c) =>
  dispatch(c, handleDiscoverMcpTools)
);
