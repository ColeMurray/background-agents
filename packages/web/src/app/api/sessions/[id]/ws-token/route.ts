import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
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
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;

  try {
    // Extract user info from NextAuth session
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    // Read refresh token from the JWT directly (not exposed on session)
    const jwt = await getToken({ req: request });

    const response = await controlPlaneFetch(`/sessions/${sessionId}/ws-token`, {
      method: "POST",
      body: JSON.stringify({
        userId,
        githubUserId: user.id,
        githubLogin: user.login,
        githubName: user.name,
        githubEmail: user.email,
        // Pass user's GitHub token for PR creation (will be encrypted by control plane)
        githubToken: (session as { accessToken?: string }).accessToken,
        githubTokenExpiresAt: (session as { accessTokenExpiresAt?: number }).accessTokenExpiresAt,
        githubRefreshToken: jwt?.refreshToken as string | undefined,
      }),
    });

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
