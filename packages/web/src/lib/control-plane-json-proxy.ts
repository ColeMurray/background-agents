import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

const RELAYED_RESPONSE_HEADERS = ["etag", "retry-after", "x-request-id"] as const;
export const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function relayJsonResponse(response: Response): Promise<NextResponse> {
  const text = await response.text();
  const headers = new Headers(PRIVATE_NO_STORE_HEADERS);
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const init = { status: response.status, headers };
  return text ? NextResponse.json(JSON.parse(text), init) : new NextResponse(null, init);
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
