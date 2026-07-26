import { cookies } from "next/headers";
import { proxyBrowserAuthRequest } from "./browser-auth-proxy";
import {
  browserAuthSessionResponseSchema,
  type BrowserAuthSessionUser,
} from "./browser-auth-session-contract";

const SESSION_COOKIE_NAME = "__Secure-openinspect.session_token";

export type ServerAuthUser = BrowserAuthSessionUser;

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
 * The web is a framework-free BFF for browser authentication. Only the opaque
 * Better Auth session cookie crosses this boundary; OAuth transaction cookies
 * and unrelated browser cookies are never forwarded by server-side callers.
 */
export async function getServerAuthSession(): Promise<ServerAuthSession | null> {
  const cookieStore = await cookies();
  const sessionCookies = cookieStore
    .getAll()
    .filter(
      ({ name }) => name === SESSION_COOKIE_NAME || name.startsWith(`${SESSION_COOKIE_NAME}.`)
    );
  if (sessionCookies.length === 0) return null;

  const cookieHeader = sessionCookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const response = await proxyBrowserAuthRequest(
    new Request("https://browser-auth.internal/api/auth/get-session", {
      headers: { Cookie: cookieHeader },
    })
  );

  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Browser authentication failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (payload === null) return null;
  const session = browserAuthSessionResponseSchema.parse(payload);
  return { user: session.user };
}
