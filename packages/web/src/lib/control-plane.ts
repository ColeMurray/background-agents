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

type FetchTransportMode = "auto" | "binding" | "direct";

/**
 * Resolve how requests are sent from Cloudflare Workers.
 *
 * - auto: use service binding only for control-plane workers.dev targets.
 * - binding: always prefer service binding for control-plane targets.
 * - direct: never use service binding.
 */
function getFetchTransportMode(): FetchTransportMode {
  const mode = (process.env.CONTROL_PLANE_FETCH_MODE || "auto").toLowerCase();
  if (mode === "auto" || mode === "binding" || mode === "direct") {
    return mode;
  }

  console.warn(
    `[control-plane] Invalid CONTROL_PLANE_FETCH_MODE="${process.env.CONTROL_PLANE_FETCH_MODE}", defaulting to "auto"`
  );
  return "auto";
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

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
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

function shouldUseServiceBinding(requestUrl: string, controlPlaneBaseUrl: string): boolean {
  const mode = getFetchTransportMode();
  if (mode === "direct") {
    return false;
  }

  try {
    const request = new URL(requestUrl);
    const controlPlane = new URL(controlPlaneBaseUrl);
    const isControlPlaneTarget = request.host === controlPlane.host;
    if (!isControlPlaneTarget) {
      return false;
    }

    if (mode === "binding") {
      return true;
    }

    // auto mode: only use service binding for workers.dev targets.
    return controlPlane.hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

function isControlPlaneTarget(requestUrl: string, controlPlaneBaseUrl: string): boolean {
  try {
    const request = new URL(requestUrl);
    const controlPlane = new URL(controlPlaneBaseUrl);
    return request.host === controlPlane.host;
  } catch {
    return false;
  }
}

/**
 * Make an authenticated request to the control plane.
 *
 * On Cloudflare Workers, uses the CONTROL_PLANE_WORKER service binding
 * to avoid error 1042 (same-account worker-to-worker restriction).
 * Falls back to URL-based fetch on other platforms.
 *
 * @param path - API path (e.g., "/sessions") or absolute URL
 * @param options - Fetch options (method, body, etc.)
 * @returns Fetch Response
 */
export async function controlPlaneFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  let normalizedPath = path;
  if (!isAbsoluteHttpUrl(path) && !path.startsWith("/")) {
    normalizedPath = `/${path}`;
  }
  const baseUrl = getControlPlaneUrl().replace(/\/+$/, "");
  const requestUrl = isAbsoluteHttpUrl(normalizedPath)
    ? normalizedPath
    : `${baseUrl}${normalizedPath}`;
  const controlPlaneTarget = isControlPlaneTarget(requestUrl, baseUrl);
  const headers = controlPlaneTarget ? await getControlPlaneHeaders() : {};
  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  };

  // On Cloudflare Workers, use the service binding when targeting control-plane Worker URLs.
  const binding = await getServiceBinding();
  if (binding && shouldUseServiceBinding(requestUrl, baseUrl)) {
    return binding.fetch(requestUrl, fetchOptions);
  }

  // Direct fetch works on Vercel/local and for tunnel/custom-domain targets.
  return fetch(requestUrl, fetchOptions);
}
