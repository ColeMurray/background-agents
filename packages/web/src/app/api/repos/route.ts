import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import type { EnrichedRepository } from "@open-inspect/shared";

interface ControlPlaneReposResponse {
  repos: EnrichedRepository[];
  cached: boolean;
  cachedAt: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const headers: Record<string, string> = {};
    if (session.provider) {
      headers["X-VCS-Provider"] = session.provider;
    }
    if (session.accessToken) {
      headers["X-User-Token"] = session.accessToken;
    }

    const response = await controlPlaneFetch("/repos", {
      headers,
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
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error fetching repos:", message, error);
    return NextResponse.json(
      { error: "Internal server error", detail: message },
      { status: 500 }
    );
  }
}
