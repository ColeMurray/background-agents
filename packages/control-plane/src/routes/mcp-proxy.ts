import { createSessionRuntimeClient } from "../session/runtime-client";
import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SCM_AGNOSTIC_SANDBOX_ROUTE, NO_AUTHORIZATION, type RequestContext } from "./shared";
import type { Env } from "../types";
import { SessionInternalPaths } from "../session/contracts";
import type { McpProxySnapshot } from "../session/mcp-context";
import { McpServerStore } from "../db/mcp-servers";
import { McpConnectionStore } from "../db/mcp-connections";
import { McpOAuthService } from "../mcp/oauth";
import { relayMcpRequest, readMcpBody } from "../mcp/relay";
import { McpError, mcpErrorResponse, type McpErrorCode } from "../mcp/errors";
import {
  assertMcpDestinationEnabled,
  assertMcpUserAccess,
  createMcpDestinationPolicy,
} from "../mcp/authorization";
import { createLogger } from "../logger";

const log = createLogger("mcp-proxy");
async function proxy(
  request: Request,
  env: Env,
  params: { id: string; serverId: string },
  ctx: RequestContext
): Promise<Response> {
  const started = Date.now();
  let captured: McpProxySnapshot | undefined;
  const leaseId = crypto.randomUUID();
  const runtime = createSessionRuntimeClient(env, ctx);
  const internal = (body: object) =>
    runtime.fetch(params.id, SessionInternalPaths.mcpContext, {
      method: "POST",
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverId: params.serverId, leaseId, ...body }),
    });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      ctx.executionCtx.submit(() => internal({ release: true }), { name: "mcp.release" });
    }
  };
  try {
    const capture = async (expected?: McpProxySnapshot) => {
      const result = await internal({ expected });
      if (!result.ok) {
        const failure = (await result.json()) as { code: McpErrorCode };
        throw new McpError(failure.code, result.status);
      }
      return (await result.json()) as McpProxySnapshot;
    };
    captured = await capture();
    const body = await readMcpBody(request);
    const snapshot = captured;
    const registry = new McpServerStore(ctx.db, env.REPO_SECRETS_ENCRYPTION_KEY!);
    const connections = new McpConnectionStore(ctx.db, env.TOKEN_ENCRYPTION_KEY!);
    const eligible = async () => {
      const server = await registry.get(params.serverId);
      if (
        !server?.enabled ||
        !server.managedRouting ||
        server.type !== "remote" ||
        server.authRevision !== snapshot.serverAuthRevision ||
        server.authMode !== snapshot.authMode
      )
        throw new McpError("mcp_context_changed", 409);
      const names = new Set(
        snapshot.repositories.map((r) => `${r.repoOwner}/${r.repoName}`.toLowerCase())
      );
      if (
        server.repoScopes?.length &&
        !server.repoScopes.some((scope) => names.has(scope.toLowerCase()))
      )
        throw new McpError("mcp_denied");
      assertMcpDestinationEnabled(env, server);
      if (snapshot.grant) {
        await assertMcpUserAccess(ctx.db, env, snapshot.grant.canonicalUserId, params.id);
        const row = await connections.require(snapshot.grant);
        if (row.issuer !== server.oauth?.issuer || row.resource !== server.oauth?.resource)
          throw new McpError("mcp_context_changed", 409);
      }
      return server;
    };
    const server = await eligible();
    const upstreamHeaders: Record<string, string> =
      snapshot.authMode === "service_credentials"
        ? await registry.getServiceHeaders(server.id, snapshot.serverAuthRevision)
        : snapshot.authMode === "user_oauth" && snapshot.grant
          ? {
              Authorization: `Bearer ${await new McpOAuthService(connections, createMcpDestinationPolicy(env)).credential(snapshot.grant)}`,
            }
          : {};
    if (snapshot.authMode === "user_oauth" && !snapshot.grant)
      throw new McpError("mcp_execution_inactive");
    const response = await relayMcpRequest(request, {
      target: server.url!,
      upstreamHeaders,
      body,
      bodyRead: true,
      onComplete: release,
      personal: snapshot.authMode === "user_oauth",
      revalidate: async () => {
        await eligible();
        await capture(snapshot);
      },
    });
    log.info("MCP upstream response started", {
      event: "mcp.response_started",
      request_id: ctx.request_id,
      session_id: params.id,
      server_id: params.serverId,
      auth_mode: snapshot.authMode,
      admitted_message_id: snapshot.messageId,
      admitted_revision: snapshot.revision,
      canonical_user_id: snapshot.grant?.canonicalUserId,
      grant_revision: snapshot.grant?.grantRevision,
      status: response.status,
      elapsed_ms: Date.now() - started,
    });
    return response;
  } catch (error) {
    release();
    log.warn("MCP admission or forwarding failed", {
      event: "mcp.failed",
      request_id: ctx.request_id,
      session_id: params.id,
      server_id: params.serverId,
      admitted_message_id: captured?.messageId,
      code: error instanceof McpError ? error.code : "mcp_unavailable",
    });
    return mcpErrorResponse(error);
  }
}
async function close(request: Request, env: Env, params: { id: string }, ctx: RequestContext) {
  try {
    const body = await readMcpBody(request, 1024);
    return createSessionRuntimeClient(env, ctx).fetch(params.id, SessionInternalPaths.mcpClose, {
      method: "POST",
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
        "Content-Type": "application/json",
      },
      body: body?.buffer as ArrayBuffer | undefined,
    });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
const sandbox = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  cacheControl: "no-store",
  authorization: NO_AUTHORIZATION,
});
export const mcpProxyRoutes = new Hono<ControlPlaneHonoEnv>();
mcpProxyRoutes.on(["GET", "POST", "DELETE"], "/sessions/:id/mcp/:serverId", sandbox, (c) =>
  dispatch(c, proxy)
);
mcpProxyRoutes.post("/sessions/:id/mcp-context/close", sandbox, (c) => dispatch(c, close));
