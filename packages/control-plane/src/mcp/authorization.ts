import { checkSessionAccess } from "@open-inspect/shared";
import { AuthorizationService } from "../authorization/service";
import {
  legacyPermissionForAction,
  parseTeamsEnforcementMode,
  resolverDecides,
} from "../authorization/teams-enforcement";
import { SessionIndexStore } from "../db/session-index";
import { TeamMembershipStore } from "../db/team-memberships";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { McpError } from "./errors";
import { mcpDestination } from "./destination";

/** No request/session positive cache: invoked again after credential I/O. */
export async function assertMcpUserAccess(
  db: SqlDatabase,
  env: Env,
  userId: string,
  sessionId: string
): Promise<void> {
  const [authorization, session, memberships, collaboratorIds] = await Promise.all([
    new AuthorizationService(db).getEffectiveAuthorization(userId),
    new SessionIndexStore(db).get(sessionId),
    new TeamMembershipStore(db).listForUser(userId),
    new SessionCollaboratorStore(db).listUserIds(sessionId),
  ]);
  if (!session || authorization.suspendedAt !== null) throw new McpError("mcp_denied");
  const mode = parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT);
  const row = { ...session, ownerUserId: session.userId ?? null, collaboratorIds };
  const viewer = {
    kind: "user" as const,
    userId,
    roleKey: authorization.role.key,
    permissions: authorization.permissions,
    suspended: false,
    memberships,
  };
  for (const action of ["read", "collaborate"] as const) {
    const decision = checkSessionAccess(viewer, row, action);
    if (
      resolverDecides(mode, row, action)
        ? !decision.allowed
        : !authorization.permissions.includes(legacyPermissionForAction(action))
    )
      throw new McpError("mcp_denied");
  }
}

export type McpDestinationPolicy = (value: string, expectedOrigin?: string) => URL;

/** Read current configuration at use, including after credential I/O. */
export function createMcpDestinationPolicy(
  env: Pick<Env, "MCP_ALLOWED_UPSTREAM_ORIGINS">
): McpDestinationPolicy {
  return (value, expectedOrigin) => {
    const url = mcpDestination(value, expectedOrigin);
    const allowed = (env.MCP_ALLOWED_UPSTREAM_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim());
    if (!allowed.includes(url.origin)) throw new McpError("mcp_unsupported");
    return url;
  };
}

export function assertMcpDestinationEnabled(env: Env, server: McpServerMetadata): void {
  if (!server.url) throw new McpError("mcp_unsupported");
  const destination = createMcpDestinationPolicy(env);
  destination(server.url);
  if (server.oauth) {
    destination(server.oauth.issuer);
    destination(server.oauth.resource);
  }
}
