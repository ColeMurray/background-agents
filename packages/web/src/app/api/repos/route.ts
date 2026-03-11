import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, getRequestScmTokenState } from "@/lib/auth";
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
    const { accessToken } = await getRequestScmTokenState(request);
    // Forward the user's SCM token when available so provider-specific discovery
    // can fall back to user auth (required for Bitbucket deployments).
    const response = await controlPlaneFetch("/repos", {
      headers: accessToken
        ? {
            "x-scm-token": accessToken,
          }
        : undefined,
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
