/**
 * Control-plane read plumbing shared by the classifier's data modules: the
 * authenticated fetch and the cache TTLs every cached read uses.
 */

import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { Env } from "../types";

/**
 * Local cache TTL in milliseconds (1 minute).
 * This is shorter than the control plane's 5-minute cache because
 * the slack-bot might be restarted more frequently.
 */
export const LOCAL_CACHE_TTL_MS = 60 * 1000;

/**
 * Expiration for the shared KV caches (repos, routing rules, environments,
 * watched channels), in seconds — the unit Cloudflare KV's `expirationTtl`
 * expects.
 */
export const KV_CACHE_TTL_SECONDS = 300;

/**
 * Issue an authenticated GET to the control plane, preferring the service
 * binding and falling back to URL-based fetch. Centralizes the internal-auth
 * headers and binding-vs-URL switch shared by every control-plane read.
 */
export async function controlPlaneFetch(
  env: Env,
  path: string,
  traceId?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
  return env.CONTROL_PLANE
    ? env.CONTROL_PLANE.fetch(`https://internal${path}`, { headers })
    : fetch(`${env.CONTROL_PLANE_URL}${path}`, {
        headers: { ...headers, "User-Agent": "open-inspect-slack-bot" },
      });
}
