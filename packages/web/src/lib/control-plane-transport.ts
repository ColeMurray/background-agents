/**
 * Control-plane transport: URL resolution, the Cloudflare service binding,
 * and request dispatch.
 *
 * On Cloudflare Workers, requests go through a service binding to avoid
 * same-account worker-to-worker fetch restrictions (error 1042). Falls back
 * to URL-based fetch for Vercel / local development.
 *
 * This module sits below both `control-plane.ts` (user-credentialed
 * requests) and `oi-session.ts` (token exchange/refresh), keeping the import
 * graph a DAG.
 */

import { buildServiceAuthHeaders } from "@open-inspect/shared";
import { createLogger } from "@/lib/logger";
import { getCorrelationLogFields } from "@/lib/request-correlation";
import { getRequestCorrelation } from "@/lib/request-context";

const log = createLogger("control-plane-transport");

/**
 * Get the control plane base URL (no trailing slash) from environment.
 * Throws if not configured.
 */
export function getControlPlaneUrl(): string {
  const url = process.env.CONTROL_PLANE_URL;
  if (!url) {
    console.error("[control-plane] CONTROL_PLANE_URL not configured");
    throw new Error("CONTROL_PLANE_URL not configured");
  }
  return url.replace(/\/+$/, "");
}

/**
 * A minimal interface for a Cloudflare service binding's fetch method.
 */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

function isServiceBinding(value: unknown): value is ServiceBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function"
  );
}

/**
 * Try to get the Cloudflare Workers service binding for the control plane.
 * Returns null when not running on Cloudflare Workers.
 */
async function getServiceBinding(
  correlationFields: Record<string, string>
): Promise<ServiceBinding | null> {
  // In local development (next dev), always use URL-based fetch. When
  // @opennextjs/cloudflare is loaded in a Node.js dev server it can return a
  // stub service binding whose fetch fails with a "no local dev session" error.
  if (process.env.NODE_ENV === "development") {
    return null;
  }

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const binding = (ctx as { env?: { CONTROL_PLANE_WORKER?: unknown } }).env?.CONTROL_PLANE_WORKER;
    return isServiceBinding(binding) ? binding : null;
  } catch (err) {
    // Expected on non-Cloudflare runtimes (missing package). Log on edge
    // so binding misconfigurations don't silently fall back to URL fetch.
    if (typeof caches !== "undefined") {
      log.warn("control_plane.binding_lookup_failed", {
        ...correlationFields,
        outcome: "fallback",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
    return null;
  }
}

/**
 * Route a fully-built control-plane request via the service binding or
 * direct fetch. Callers build the URL exactly once — for signed requests the
 * dispatched URL is always the URL that was signed.
 */
export async function dispatchControlPlaneFetch(
  url: string,
  fetchOptions: RequestInit,
  correlationFields: Record<string, string>
): Promise<Response> {
  // On Cloudflare Workers, use the service binding to call the control plane
  const binding = await getServiceBinding(correlationFields);
  if (binding) {
    return binding.fetch(url, fetchOptions);
  }

  // Fallback: direct fetch (works on Vercel / local dev)
  return fetch(url, fetchOptions);
}

/**
 * Make a control-plane request signed with web's own sig1 service
 * credential — never a user token.
 *
 * Reserved for the token endpoints (exchange/refresh): issuance must be
 * reachable only through web's per-service identity. Throws when
 * SERVICE_AUTH_SECRET is not configured; callers treat that as an exchange
 * failure.
 */
/**
 * Token calls sit on the sign-in path and the background refresh ping — an
 * unresponsive control plane must fail fast into the callers' existing
 * exchange_fallback/request_failed paths, not hang until the platform's own
 * timeout.
 */
const SERVICE_FETCH_TIMEOUT_MS = 10_000;

export async function controlPlaneServiceFetch(
  path: string,
  init: { method: string; body?: string }
): Promise<Response> {
  const secret = process.env.SERVICE_AUTH_SECRET;
  if (!secret) {
    throw new Error("SERVICE_AUTH_SECRET not configured");
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const correlation = await getRequestCorrelation();
  const correlationFields = getCorrelationLogFields(correlation);
  // The signature covers method, path, query, and body hash — not the host —
  // so signing the URL-based form stays valid across the service binding.
  const url = `${getControlPlaneUrl()}${normalizedPath}`;

  const headers = {
    "Content-Type": "application/json",
    ...(await buildServiceAuthHeaders({
      service: "web",
      secret,
      method: init.method,
      url,
      body: init.body,
      traceId: correlation.traceId,
    })),
  };

  return dispatchControlPlaneFetch(
    url,
    {
      method: init.method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(SERVICE_FETCH_TIMEOUT_MS),
    },
    correlationFields
  );
}
