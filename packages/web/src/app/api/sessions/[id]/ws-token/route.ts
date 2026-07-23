import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { buildAuthDisplay, buildScmAttribution } from "@/lib/build-auth-identity";
import { controlPlaneFetch } from "@/lib/control-plane";

/**
 * Generate a WebSocket authentication token for the current user.
 *
 * This endpoint:
 * 1. Verifies the user is authenticated via NextAuth
 * 2. Extracts user info from the session
 * 3. Proxies the request to the control plane to generate a token
 * 4. Returns the token to the client for WebSocket connection
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeStart = Date.now();

  const session = await getServerSession(authOptions);
  const authMs = Date.now() - routeStart;

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  try {
    // Extract user info from NextAuth session. Participant identity (userId)
    // and SCM credentials are derived by the control plane from the Bearer
    // principal and are rejected in the body under strict enforcement — the
    // body carries display/attribution fields only.
    const user = session.user;
    const { authName } = buildAuthDisplay(user);

    const fetchStart = Date.now();
    const response = await controlPlaneFetch(`/sessions/${sessionId}/ws-token`, {
      method: "POST",
      body: JSON.stringify({
        authName,
        // GitHub-only commit attribution; empty for Google.
        ...buildScmAttribution(user),
      }),
    });
    const fetchMs = Date.now() - fetchStart;
    const totalMs = Date.now() - routeStart;

    console.log(
      `[ws-token] session=${sessionId} total=${totalMs}ms auth=${authMs}ms fetch=${fetchMs}ms status=${response.status}`
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
