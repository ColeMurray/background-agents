import { getServerSession } from "next-auth";
import { authOptions } from "./auth";

/**
 * Server-side authentication seam for BFF routes.
 *
 * This deliberately delegates to the existing NextAuth implementation. A
 * later terminal-auth change can replace this boundary without another
 * repository-wide route migration.
 */
export function getServerAuthSession() {
  return getServerSession(authOptions);
}
