import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const RELAYED_RESPONSE_HEADERS = ["etag", "retry-after", "x-request-id"] as const;
export const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * Relays a control-plane response as JSON, keeping its status.
 *
 * A body that is not JSON (a plain-text 401 or an HTML 502 from a layer in
 * front of the control plane) is replaced by a JSON error rather than parsed:
 * a parse failure would otherwise surface as a 500 and lose the status the
 * caller needs to act on. A success status is not relayed with such a body,
 * because the browser could not read it; that becomes a 502.
 */
export async function relayJsonResponse(response: Response): Promise<NextResponse> {
  const text = await response.text();
  const headers = new Headers(PRIVATE_NO_STORE_HEADERS);
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!text) return new NextResponse(null, { status: response.status, headers });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Unexpected response from control plane" },
      { status: response.status >= 400 ? response.status : 502, headers }
    );
  }
  return NextResponse.json(body, { status: response.status, headers });
}

/** Creates a GET handler for an ordinary authenticated JSON/no-content resource. */
export function controlPlaneJsonGetProxy(
  buildPath: (request: NextRequest) => string,
  label: string
): { GET: (request: NextRequest) => Promise<NextResponse> } {
  return {
    async GET(request) {
      try {
        return relayJsonResponse(await controlPlaneUserFetch(buildPath(request)));
      } catch (error) {
        console.error(`Failed to fetch ${label}:`, error);
        return NextResponse.json({ error: `Failed to fetch ${label}` }, { status: 500 });
      }
    },
  };
}
