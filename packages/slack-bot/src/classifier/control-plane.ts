/**
 * Control-plane read plumbing shared by the classifier's data modules: the
 * authenticated fetch and the cache TTLs every cached read uses.
 */

import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";

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
 * Issue an authenticated GET to the control plane through the service
 * binding — the one signed read path shared by every classifier data module.
 */
export async function controlPlaneFetch(
  env: Env,
  path: string,
  traceId?: string
): Promise<Response> {
  return signedControlPlaneFetch(
    env,
    { method: "GET", url: `https://internal${path}`, traceId },
    { headers: { Accept: "application/json" } }
  );
}

/** A non-OK control-plane response, carrying the status for structured logs. */
export class ControlPlaneRequestError extends Error {
  constructor(
    path: string,
    readonly status: number
  ) {
    super(`Control plane GET ${path} failed with ${status}`);
    this.name = "ControlPlaneRequestError";
  }
}

/**
 * GET a control-plane endpoint and return its JSON body, throwing
 * {@link ControlPlaneRequestError} on a non-OK response — the loader shape
 * cached resources expect.
 */
export async function fetchControlPlaneJson(
  env: Env,
  path: string,
  traceId?: string
): Promise<unknown> {
  const response = await controlPlaneFetch(env, path, traceId);
  if (!response.ok) {
    throw new ControlPlaneRequestError(path, response.status);
  }
  return response.json();
}
