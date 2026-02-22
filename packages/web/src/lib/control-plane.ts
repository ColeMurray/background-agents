/**
 * Control Plane API utilities.
 *
 * Handles authentication and communication with the control plane.
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
 * Make an authenticated request to the control plane.
 *
 * @param path - API path (e.g., "/sessions")
 * @param options - Fetch options (method, body, etc.)
 * @returns Fetch Response
 */
export async function controlPlaneFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = getControlPlaneUrl().replace(/\/+$/, ""); // Remove trailing slashes
  const normalizedPath = path.startsWith("/") ? path : `/${path}`; // Ensure leading slash
  const headers = await getControlPlaneHeaders();

  return fetch(`${baseUrl}${normalizedPath}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });
}
