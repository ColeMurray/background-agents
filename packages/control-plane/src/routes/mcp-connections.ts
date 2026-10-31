import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { ACTIVE_SELF, SCM_AGNOSTIC_HUMAN_USER_ROUTE, type UserRouteContext } from "./shared";
import type { Env } from "../types";
import { McpServerStore } from "../db/mcp-servers";
import { McpConnectionStore } from "../db/mcp-connections";
import { McpOAuthService } from "../mcp/oauth";
import { McpError, mcpErrorResponse } from "../mcp/errors";
import { parseBody } from "./body";
import { requireRepoSecretsEncryptionKey, requireTokenEncryptionKey } from "../env-validation";

const self = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});
function services(ctx: UserRouteContext, env: Env) {
  const store = new McpConnectionStore(ctx.db, requireTokenEncryptionKey(env));
  return {
    store,
    registry: new McpServerStore(ctx.db, requireRepoSecretsEncryptionKey(env)),
    oauth: new McpOAuthService(store),
  };
}
async function list(_request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  try {
    const { store, registry } = services(ctx, env);
    await store.pruneTransactions(ctx.principal.userId);
    const servers = await registry.list();
    const candidates = await Promise.all(
      servers.map(async (server) => {
        const row = await store.get(ctx.principal.userId, server.id);
        if (server.authMode !== "user_oauth" && !row) return null;
        return {
          serverId: server.id,
          name: server.name,
          enabled: server.enabled && server.authMode === "user_oauth",
          authMode: server.authMode,
          status: !row
            ? "not_connected"
            : row.status === "disconnected"
              ? "disconnected"
              : row.auth_revision !== server.authRevision
                ? "reconnect_required"
                : row.status,
        };
      })
    );
    return Response.json({ connections: candidates.filter((connection) => connection !== null) });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
async function connect(
  _request: Request,
  env: Env,
  params: { serverId: string },
  ctx: UserRouteContext
) {
  try {
    const { registry, oauth } = services(ctx, env);
    const server = await registry.get(params.serverId);
    if (!server || !ctx.authentication?.credentialId) throw new McpError("mcp_denied");
    const callback = new URL("/api/mcp-connections/oauth/callback", env.WEB_APP_URL);
    if (callback.protocol !== "https:") throw new McpError("mcp_unsupported");
    return Response.json({
      authorizationUrl: await oauth.start(
        ctx.principal.userId,
        ctx.authentication.credentialId,
        server,
        callback.toString()
      ),
    });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
async function callback(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(
    request,
    z.strictObject({
      code: z.string().min(1).max(4096),
      state: z.string().min(1).max(256),
      iss: z.string().max(2048).optional(),
    }),
    "Invalid OAuth callback"
  );
  if (body instanceof Response) return body;
  try {
    if (!ctx.authentication?.credentialId) throw new McpError("mcp_denied");
    await services(ctx, env).oauth.callback(
      ctx.principal.userId,
      ctx.authentication.credentialId,
      body
    );
    return Response.json({ ok: true });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
async function disconnect(
  _request: Request,
  env: Env,
  params: { serverId: string },
  ctx: UserRouteContext
) {
  try {
    await services(ctx, env).store.disconnect(ctx.principal.userId, params.serverId);
    return Response.json({ ok: true });
  } catch (error) {
    return mcpErrorResponse(error);
  }
}
export const mcpConnectionRoutes = new Hono<ControlPlaneHonoEnv>();
mcpConnectionRoutes.get("/mcp-connections", self, (c) => dispatch(c, list));
mcpConnectionRoutes.post("/mcp-connections/oauth/callback", self, (c) => dispatch(c, callback));
mcpConnectionRoutes.post("/mcp-connections/:serverId/connect", self, (c) => dispatch(c, connect));
mcpConnectionRoutes.delete("/mcp-connections/:serverId", self, (c) => dispatch(c, disconnect));
