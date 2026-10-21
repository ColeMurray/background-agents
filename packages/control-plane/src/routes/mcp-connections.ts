import {
  mcpConnectionAuthorizeInputSchema,
  mcpConnectionCreateInputSchema,
} from "@open-inspect/shared/types/integrations";
import { Hono } from "hono";
import {
  McpConnectionConflictError,
  McpConnectionStore,
  McpConnectionValidationError,
} from "../db/mcp-connections";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseBody } from "./body";
import {
  ACTIVE_SELF,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  error,
  json,
  type UserRouteContext,
} from "./shared";
import type { Env } from "../types";
import { mcpConnectionsEnabled } from "../mcp/feature";
import { McpConnectionSaga } from "../mcp/connection-saga";

const OWNER_ROUTE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});

async function listConnections(
  _request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const connections = await new McpConnectionStore(ctx.db).listOwned(ctx.principal.userId);
  return json({ enabled: mcpConnectionsEnabled(env), connections });
}

async function getConnection(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const connection = await new McpConnectionStore(ctx.db).getOwned(params.id, ctx.principal.userId);
  return connection ? json(connection) : error("MCP connection not found", 404);
}

async function createConnection(
  request: Request,
  env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  if (!mcpConnectionsEnabled(env) || !env.MCP_CONNECTION) {
    return error("Personal MCP connections are disabled", 503);
  }
  const body = await parseBody(request, mcpConnectionCreateInputSchema, "Invalid MCP connection");
  if (body instanceof Response) return body;
  try {
    const store = new McpConnectionStore(ctx.db);
    const connection = await new McpConnectionSaga(store, env.MCP_CONNECTION).create(
      ctx.principal.userId,
      body.serverId
    );
    return json(connection, 201);
  } catch (errorValue) {
    if (errorValue instanceof McpConnectionValidationError) {
      return error(errorValue.message, 400);
    }
    if (errorValue instanceof McpConnectionConflictError) {
      return error(errorValue.message, 409);
    }
    throw errorValue;
  }
}

async function deleteConnection(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  if (!env.MCP_CONNECTION) return error("Personal MCP connections are disabled", 503);
  const result = await new McpConnectionSaga(
    new McpConnectionStore(ctx.db),
    env.MCP_CONNECTION
  ).revoke(ctx.principal.userId, params.id);
  return json({ ok: true, result });
}

/**
 * Make one of the caller's own connections usable.
 *
 * The connection is resolved by the owner's own authority first, so the owner
 * can only act on a connection that belongs to them. The broker then opens the
 * transport against the reviewed endpoint and, when the server wants the
 * owner's approval, answers with the server's own authorization URL. The URL
 * is a URL: the credential stays in the broker and never reaches the browser.
 */
async function authorizeConnection(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  if (!env.MCP_CONNECTION) return error("Personal MCP connections are disabled", 503);
  // The body is optional: an owner who only wants to start the authorization
  // sends nothing. Anything else is parsed and validated.
  const raw = await request.text();
  let parsed: unknown = {};
  if (raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return error("Invalid JSON body", 400);
    }
  }
  const body = mcpConnectionAuthorizeInputSchema.safeParse(parsed);
  if (!body.success) return error("Invalid MCP connection", 400);
  const authorization = await new McpConnectionSaga(
    new McpConnectionStore(ctx.db),
    env.MCP_CONNECTION
  ).authorize(ctx.principal.userId, params.id, { reconnect: body.data.reconnect === true });
  if (!authorization) return error("MCP connection not found", 404);
  return json(authorization);
}

async function oauthCallback(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  if (!env.MCP_CONNECTION) return error("Personal MCP connections are disabled", 503);
  const connection = await new McpConnectionStore(ctx.db).getOwned(params.id, ctx.principal.userId);
  if (!connection) return error("MCP connection not found", 404);
  return env.MCP_CONNECTION.handleCallback(params.id, request);
}

export const mcpConnectionRoutes = new Hono<ControlPlaneHonoEnv>();
/**
 * The server sends the owner back here after an OAuth approval.
 *
 * The request goes to the broker that owns the connection, and the broker
 * handles it. Nothing else is reachable on this route.
 */
mcpConnectionRoutes.get("/mcp/oauth/callback/:id", OWNER_ROUTE, (c) => dispatch(c, oauthCallback));

mcpConnectionRoutes.get("/mcp-connections", OWNER_ROUTE, (c) => dispatch(c, listConnections));
mcpConnectionRoutes.post("/mcp-connections", OWNER_ROUTE, (c) => dispatch(c, createConnection));
mcpConnectionRoutes.get("/mcp-connections/:id", OWNER_ROUTE, (c) => dispatch(c, getConnection));
mcpConnectionRoutes.post("/mcp-connections/:id/authorize", OWNER_ROUTE, (c) =>
  dispatch(c, authorizeConnection)
);
mcpConnectionRoutes.delete("/mcp-connections/:id", OWNER_ROUTE, (c) =>
  dispatch(c, deleteConnection)
);
