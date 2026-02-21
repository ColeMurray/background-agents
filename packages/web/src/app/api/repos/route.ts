import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import type { EnrichedRepository } from "@open-inspect/shared";

interface ControlPlaneReposResponse {
  repos: EnrichedRepository[];
  cached: boolean;
  cachedAt: string;
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const jwt = await getToken({
      req: request,
      secret: process.env.NEXTAUTH_SECRET,
    });

    // Fetch repositories from control plane using GitHub App installation token.
    // For Bitbucket deployments, forward the user's OAuth token for repo listing.
    const response = await controlPlaneFetch("/repos", {
      headers: {
        ...(jwt?.vcsProvider ? { "x-scm-provider": String(jwt.vcsProvider) } : {}),
        ...(jwt?.accessToken ? { "x-scm-token": String(jwt.accessToken) } : {}),
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Control plane API error:", error);
      return NextResponse.json(
        { error: "Failed to fetch repositories" },
        { status: response.status }
      );
    }

    const data: ControlPlaneReposResponse = await response.json();

    // The control plane returns repos in the format we need
    return NextResponse.json({ repos: data.repos });
  } catch (error) {
    console.error("Error fetching repos:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
