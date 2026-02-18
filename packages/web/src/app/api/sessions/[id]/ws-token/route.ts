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

    const jwt = await getToken({ req: request });
    const accessToken = session.accessToken;
    const provider = session.provider ?? "github";

    const tokenBody: Record<string, unknown> = {
      userId,
      vcsProvider: provider,
    };

    if (provider === "bitbucket") {
      tokenBody.bitbucketUuid = user.id;
      tokenBody.bitbucketLogin = user.login;
      tokenBody.bitbucketDisplayName = user.name;
      tokenBody.bitbucketEmail = user.email;
      tokenBody.bitbucketToken = accessToken;
      tokenBody.bitbucketTokenExpiresAt = session.accessTokenExpiresAt;
    } else {
      tokenBody.githubUserId = user.id;
      tokenBody.githubLogin = user.login;
      tokenBody.githubName = user.name;
      tokenBody.githubEmail = user.email;
      tokenBody.githubToken = accessToken;
      tokenBody.githubTokenExpiresAt = session.accessTokenExpiresAt;
      tokenBody.githubRefreshToken = jwt?.refreshToken as string | undefined;
    }

    const response = await controlPlaneFetch(`/sessions/${sessionId}/ws-token`, {
      method: "POST",
      body: JSON.stringify(tokenBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Failed to generate WS token: status=${response.status} body=${errorBody}`);
      return NextResponse.json(
        { error: "Failed to generate token", detail: errorBody },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to generate WS token:", message, error);
    return NextResponse.json(
      { error: "Failed to generate token", detail: message },
      { status: 500 }
    );
  }
}
