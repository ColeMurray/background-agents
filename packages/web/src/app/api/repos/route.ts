import { NextResponse, type NextRequest } from "next/server";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { controlPlaneReposResponseSchema } from "@open-inspect/shared/types/repository-catalog";
import { buildControlPlanePath } from "@/lib/control-plane-query";

export async function GET(request: NextRequest) {
  const session = await getServerAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch repositories from control plane using GitHub App installation token.
    // This ensures we only show repos the App has access to, not all repos the user can see.
    const response = await controlPlaneUserFetch(
      buildControlPlanePath("/repos", request.nextUrl.searchParams, ["teamId"])
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Control plane API error:", error);
      return NextResponse.json(
        { error: "Failed to fetch repositories" },
        { status: response.status }
      );
    }

    const parsed = controlPlaneReposResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid control plane repositories response");

    // The control plane returns repos in the format we need
    return NextResponse.json({
      repos: parsed.data.repos,
      teamHasRepositoryGrants: parsed.data.teamHasRepositoryGrants,
    });
  } catch (error) {
    console.error("Error fetching repos:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
