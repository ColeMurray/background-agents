import { NextResponse } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import type { EnrichedRepository } from "@open-inspect/shared";

interface ControlPlaneReposResponse {
  repos: EnrichedRepository[];
  cached: boolean;
  cachedAt: string;
}

export async function GET() {
  const session = await getServerAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch repositories from control plane using GitHub App installation token.
    // This ensures we only show repos the App has access to, not all repos the user can see.
    const response = await controlPlaneUserFetch("/repos");

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
