import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import type { AuthIdentityUser } from "./build-auth-identity";

export type ServerAuthUser = AuthIdentityUser;

/**
 * App-owned session contract consumed by server-side BFF routes.
 *
 * Provider-specific session implementations adapt to this shape at the seam so
 * route authorization does not depend on framework-owned session types.
 */
export interface ServerAuthSession {
  user?: ServerAuthUser | null;
}

/**
 * Server-side authentication seam for BFF routes.
 *
 * This deliberately delegates to the existing NextAuth implementation. A
 * later terminal-auth change can replace this boundary without another
 * repository-wide route migration.
 */
export function getServerAuthSession(): Promise<ServerAuthSession | null> {
  return getServerSession(authOptions);
}
