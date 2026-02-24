/**
 * Control Plane API utilities.
 *
 * Handles authentication and communication with the control plane.
 * On Cloudflare Workers, uses a service binding to avoid same-account
 * worker-to-worker fetch restrictions (error 1042). Falls back to
 * URL-based fetch for Vercel / local development.
 */

import { generateInternalToken } from "@open-inspect/shared";

/**
 * Get the control plane URL from environment.
 * Throws if not configured.
 */
function getControlPlaneUrl(): string {
  const url = process.env.CONTROL_PLANE_URL;
  if (!url) {
    console.error("[control-plane] CONTROL_PLANE_URL not configured");
    throw new Error("CONTROL_PLANE_URL not configured");
  }
  return url;
}

/**
 * Get the shared secret for control plane authentication.
 * Throws if not configured.
 */
function getInternalSecret(): string {
  const secret = process.env.INTERNAL_CALLBACK_SECRET;
  if (!secret) {
    console.error("[control-plane] INTERNAL_CALLBACK_SECRET not configured");
    throw new Error("INTERNAL_CALLBACK_SECRET not configured");
  }
  return secret;
}

/**
 * Create authenticated headers for control plane requests.
 *
 * @returns Headers object with Content-Type and Authorization
 */
async function getControlPlaneHeaders(): Promise<HeadersInit> {
  const secret = getInternalSecret();
  const token = await generateInternalToken(secret);

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

/**
 * A minimal interface for a Cloudflare service binding's fetch method.
 */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Try to get the Cloudflare Workers service binding for the control plane.
 * Returns null when not running on Cloudflare Workers.
 */
async function getServiceBinding(): Promise<ServiceBinding | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const binding = (ctx.env as Record<string, unknown>)["CONTROL_PLANE_WORKER"] as
      | ServiceBinding
      | undefined;
    return binding ?? null;
  } catch (err) {
    // Expected on non-Cloudflare runtimes (missing package). Log on edge
    // so binding misconfigurations don't silently fall back to URL fetch.
    if (typeof caches !== "undefined") {
      console.warn("[control-plane] getCloudflareContext failed, falling back to URL fetch:", err);
    }
    return null;
  }
}

/**
 * Make an authenticated request to the control plane.
 *
 * On Cloudflare Workers, uses the CONTROL_PLANE_WORKER service binding
 * to avoid error 1042 (same-account worker-to-worker restriction).
 * Falls back to URL-based fetch on other platforms.
 *
 * @param path - API path (e.g., "/sessions")
 * @param options - Fetch options (method, body, etc.)
 * @returns Fetch Response
 */
export async function controlPlaneFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const headers = await getControlPlaneHeaders();
  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  };

  // On Cloudflare Workers, use the service binding to call the control plane
  const binding = await getServiceBinding();
  if (binding) {
    const baseUrl = getControlPlaneUrl().replace(/\/+$/, "");
    return binding.fetch(`${baseUrl}${normalizedPath}`, fetchOptions);
  }

  // Fallback: direct fetch (works on Vercel / local dev)
  const baseUrl = getControlPlaneUrl().replace(/\/+$/, "");
  return fetch(`${baseUrl}${normalizedPath}`, fetchOptions);
}
