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
    const jwt = await getToken({ req: request });
    const provider = (jwt?.provider as "github" | "bitbucket" | undefined) ?? session.provider;
    const accessToken = jwt?.accessToken as string | undefined;

    const headers: Record<string, string> = {};
    if (provider) {
      headers["X-VCS-Provider"] = provider;
    }
    if (accessToken) {
      headers["X-User-Token"] = accessToken;
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
    return NextResponse.json({ error: "Internal server error", detail: message }, { status: 500 });
  }
}
