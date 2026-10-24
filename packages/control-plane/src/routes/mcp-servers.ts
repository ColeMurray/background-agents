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
import {
  buildMcpToolReview,
  McpReviewValidationError,
  McpServerReviewStore,
} from "../db/mcp-server-reviews";
import { mcpServerReviewInputSchema } from "@open-inspect/shared/types/mcp-read";
import { Hono } from "hono";
import type { Env } from "../types";
import { createLogger } from "../logger";
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
  let deleted: boolean;
  try {
    deleted = await store.delete(id);
  } catch (err) {
    if (err instanceof McpServerConflictError) return error(err.message, 409);
    throw err;
  }
  if (!deleted) return error("MCP server not found", 404);

  logger.info("MCP server deleted", {
    event: "mcp_server.deleted",
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    id,
  });
  return json({ ok: true });
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

/**
 * The reviewed catalog of one server revision.
 *
 * Only an account that holds `mcp_servers.manage` may write a review, and
 * the review is not delegable to a personal connection: a connection stages
 * an immutable, hash-pinned copy of the reviewed reads.
 */
async function handleReviewMcpServer(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const body = await parseBody(
    request,
    mcpServerReviewInputSchema,
    "serverRevision and tools are required"
  );
  if (body instanceof Response) return body;
  const reviewerId = ctx.authorization?.userId;
  if (!reviewerId) return error("Unauthorized", 401);
  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  const server = await store.get(params.id);
  if (!server) return error("MCP server not found", 404);
  try {
    const reviewed = await new McpServerReviewStore(ctx.db).review({
      reviewedByUserId: reviewerId,
      serverId: server.id,
      serverRevision: body.serverRevision,
      tools: await Promise.all(
        body.tools.map((tool) =>
          buildMcpToolReview({
            toolName: tool.toolName,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            effect: tool.effect,
          })
        )
      ),
    });
    return json({
      review: {
        serverId: reviewed.serverId,
        serverRevision: reviewed.serverRevision,
        reviewedByUserId: reviewed.reviewedByUserId,
        reviewedAt: reviewed.reviewedAt,
        tools: reviewed.tools.map((tool) => ({
          stableToolId: tool.stableToolId,
          toolName: tool.toolName,
          title: tool.title,
          description: tool.description,
          effect: tool.effect,
          reviewedAt: tool.reviewedAt,
        })),
      },
    });
  } catch (cause) {
    if (cause instanceof McpReviewValidationError) return error(cause.message, 400);
    throw cause;
  }
}

async function handleGetMcpServerReview(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const store = new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env));
  const server = await store.get(params.id);
  if (!server) return error("MCP server not found", 404);
  const review = await new McpServerReviewStore(ctx.db).get(server.id, server.revision);
  if (!review) return error("MCP server has no reviewed catalog", 404);
  return json({
    review: {
      serverId: review.serverId,
      serverRevision: review.serverRevision,
      reviewedByUserId: review.reviewedByUserId,
      reviewedAt: review.reviewedAt,
      tools: review.tools.map((tool) => ({
        stableToolId: tool.stableToolId,
        toolName: tool.toolName,
        title: tool.title,
        description: tool.description,
        effect: tool.effect,
        reviewedAt: tool.reviewedAt,
      })),
    },
  });
}

mcpServerRoutes.put("/mcp-servers/:id/review", MCP_MANAGE, (c) =>
  dispatch(c, handleReviewMcpServer)
);
mcpServerRoutes.get("/mcp-servers/:id/review", MCP_READ, (c) =>
  dispatch(c, handleGetMcpServerReview)
);
