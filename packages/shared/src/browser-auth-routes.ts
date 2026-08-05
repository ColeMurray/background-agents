/**
 * Exact browser-reachable Better Auth surface shared by the web BFF and
 * control plane. Keeping one declaration prevents either side from silently
 * widening or narrowing the signed proxy contract.
 */
export const BROWSER_AUTH_CLIENT_IP_HEADER = "X-OpenInspect-Client-IP";

export const BROWSER_AUTH_PROXY_ROUTES = [
  ["POST", "/api/auth/sign-in/social"],
  ["GET", "/api/auth/callback/github"],
  ["GET", "/api/auth/callback/google"],
  ["GET", "/api/auth/get-session"],
  ["POST", "/api/auth/sign-out"],
  ["GET", "/api/auth/error"],
] as const;

export function isBrowserAuthProxyRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return BROWSER_AUTH_PROXY_ROUTES.some(
    ([allowedMethod, allowedPath]) => allowedMethod === normalizedMethod && allowedPath === path
  );
}
