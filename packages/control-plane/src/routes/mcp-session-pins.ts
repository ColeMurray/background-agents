/**
 * Session attachments for personal MCP connections.
 *
 * A personal MCP connection belongs to one account. It becomes available to
 * a session only when that owner grants it, and the grant names the reviewed
 * tools and the catalog snapshot the grant was made against. Revoking a
 * grant stays available even when the capability is switched off, so an
 * operator can always take a connection away.
 */

import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { McpConnectionStore } from "../db/mcp-connections";
import { McpSessionPinStore } from "../db/mcp-session-pins";
import { SessionInternalPaths } from "../session/contracts";
import { mcpSessionGrantInputSchema } from "@open-inspect/shared/types/mcp-read";
import { dispatchSession, type SessionRouteContext } from "./session-route";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  error,
  json,
  requireSession,
  type RequestContext,
} from "./shared";

/** The owner of a connection acts on their own connections only. */
const OWNER_ROUTE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: { kind: "active-self", auditAllowed: false },
  cacheControl: "private, no-store",
});

/**
 * Attach one of the caller's own MCP connections to a session.
 *
 * The session is the caller's own act, so the session's authority is
 * resolved first: the caller must be able to act in the session they are
 * attaching to. The session then applies the server's repository scope, the
 * same rule the shared MCP servers obey.
 */
async function handleGrant(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const ownerUserId = ctx.authorization?.userId ?? null;
  if (!ownerUserId) return error("Unauthorized", 401);
  const body = await parseBody(request, mcpSessionGrantInputSchema, "connectionId is required");
  if (body instanceof Response) return body;

  const connections = new McpConnectionStore(ctx.db);
  const connection = await connections.getOwned(body.connectionId, ownerUserId);
  if (!connection) return error("MCP connection not found", 404);

  // The session owns the grant: it knows its own repositories, it applies
  // the server's scope, and it writes the attachment.
  const response = await ctx.sessionRuntime.fetch(params.id, SessionInternalPaths.mcpPinGrant, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Mcp-Pin-Owner-ID": ownerUserId,
    },
    body: JSON.stringify({
      connectionId: connection.id,
      catalogSnapshotSha256: connection.catalogSnapshotSha256,
      toolNames: connection.tools.map((tool) => tool.name),
    }),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    return error(failure?.error ?? "The MCP connection could not be attached", 400);
  }
  const pin = (await response.json()) as {
    id: string;
    sessionId: string;
    connectionId: string;
    toolNames: string[];
    createdAt: number;
  };
  return json({
    pin: {
      ...pin,
      serverName: connection.serverName,
      endpointHost: new URL(connection.endpointUrl).host,
    },
  });
}

async function handleRevoke(
  _request: Request,
  _env: Env,
  params: { id: string; pinId: string },
  ctx: RequestContext
): Promise<Response> {
  const ownerUserId = ctx.principal?.kind === "user" ? ctx.principal.userId : null;
  if (!ownerUserId) return error("Unauthorized", 401);
  // The revocation does not consult the capability switch: a connection must
  // always be removable.
  const revoked = await new McpSessionPinStore(ctx.db).revoke(params.pinId, ownerUserId);
  return json({ ok: true, revoked });
}

async function handleListForSession(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const pins = await new McpSessionPinStore(ctx.db).listForSession(params.id);
  if (pins.length === 0) return json({ pins: [] });
  const connections = new McpConnectionStore(ctx.db);
  const views = [];
  for (const pin of pins) {
    const connection = await connections.getOwned(pin.connectionId, pin.ownerUserId);
    if (!connection) continue;
    views.push({
      id: pin.id,
      sessionId: pin.sessionId,
      connectionId: pin.connectionId,
      serverName: connection.serverName,
      endpointHost: new URL(connection.endpointUrl).host,
      toolNames: pin.toolNames,
      createdAt: pin.createdAt,
    });
  }
  return json({ pins: views });
}

export const mcpSessionPinRoutes = new Hono<ControlPlaneHonoEnv>();

mcpSessionPinRoutes.post(
  "/sessions/:id/mcp-pins",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    // Attaching a credential to a session is an action in that session, so
    // the session's own authority decides. A private break-glass reader and
    // a workspace administrator without current owning-team membership are
    // both refused.
    authorization: requireSession("collaborate"),
  }),
  (c) => dispatchSession(c, handleGrant)
);
mcpSessionPinRoutes.delete("/mcp-connections/:id/session-pins/:pinId", OWNER_ROUTE, (c) =>
  dispatch(c, handleRevoke)
);
mcpSessionPinRoutes.get(
  "/sessions/:id/mcp-pins",
  admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") }),
  (c) => dispatch(c, handleListForSession)
);

export const mcpSessionPinSchema = z.object({ id: z.string().min(1) });
