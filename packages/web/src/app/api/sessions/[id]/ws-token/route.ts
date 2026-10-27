import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";

/**
 * Generate a WebSocket authentication token for the current user.
 *
 * The control plane authenticates the browser session and generates the token.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStart = Date.now();

  const { id: sessionId } = await params;

  try {
    const fetchStart = Date.now();
    const response = await controlPlaneUserFetch(
      `/sessions/${encodeURIComponent(sessionId)}/ws-token`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
    const fetchMs = Date.now() - fetchStart;
    const totalMs = Date.now() - routeStart;

    console.log(
      `[ws-token] session=${sessionId} total=${totalMs}ms fetch=${fetchMs}ms status=${response.status}`
    );

    if (!response.ok) {
      const error = await response.text();
      console.error(`Failed to generate WS token: ${error}`);
      return NextResponse.json({ error: "Failed to generate token" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Failed to generate WS token:", error);
    return NextResponse.json({ error: "Failed to generate token" }, { status: 500 });
  }
}
