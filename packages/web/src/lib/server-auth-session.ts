import { cookies } from "next/headers";
import { dispatchBrowserAuthRequest } from "./browser-auth-proxy";
import {
  browserAuthSessionResponseSchema,
  type BrowserAuthSessionUser,
} from "./browser-auth-session-contract";
import { serializeBrowserSessionCookies } from "./browser-session-cookie";

export type ServerAuthUser = BrowserAuthSessionUser;

/**
 * App-owned session contract consumed by server-side BFF routes.
 *
 * Provider-specific session implementations adapt to this shape at the seam so
 * route authorization does not depend on framework-owned session types.
 */
export interface ServerAuthSession {
  user: ServerAuthUser;
}

/**
 * Server-side authentication seam for BFF routes.
 *
 * The web is a framework-free BFF for browser authentication. Only the opaque
 * Better Auth session cookie crosses this boundary; OAuth transaction cookies
 * and unrelated browser cookies are never forwarded by server-side callers.
 */
export async function getServerAuthSession(): Promise<ServerAuthSession | null> {
  const cookieStore = await cookies();
  const cookieHeader = serializeBrowserSessionCookies(cookieStore.getAll());
  if (!cookieHeader) return null;
  const response = await dispatchBrowserAuthRequest({
    method: "GET",
    pathname: "/api/auth/get-session",
    headers: { Cookie: cookieHeader },
  });

  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Browser authentication failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (payload === null) return null;
  const session = browserAuthSessionResponseSchema.parse(payload);
  return { user: session.user };
}
