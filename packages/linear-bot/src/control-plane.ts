/**
 * Control-plane read plumbing shared by the bot's cached data modules
 * (repos, environments): the authenticated fetch and the cache TTLs every
 * cached read uses. Mirrors slack-bot's classifier/control-plane.ts.
 */

import { buildInternalAuthHeaders } from "@open-inspect/shared";
import type { Env } from "./types";

/** Local cache TTL in milliseconds (1 minute). */
export const LOCAL_CACHE_TTL_MS = 60 * 1000;

/**
 * Expiration for the KV last-known-good caches (repos, environments), in
 * seconds — the unit Cloudflare KV's `expirationTtl` expects.
 */
export const KV_CACHE_TTL_SECONDS = 300;

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
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
  const response = await env.CONTROL_PLANE.fetch(`https://internal${path}`, { headers });
  if (!response.ok) {
    throw new ControlPlaneRequestError(path, response.status);
  }
  return response.json();
}
