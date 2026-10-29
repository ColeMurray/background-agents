import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { buildControlPlanePath } from "@/lib/control-plane-query";

export async function GET(request: NextRequest) {
  try {
    const response = await controlPlaneUserFetch(
      buildControlPlanePath("/environments", request.nextUrl.searchParams, [
        "teamId",
        "ownerTeamId",
      ])
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to list environments:", error);
    return NextResponse.json({ error: "Failed to list environments" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch("/environments", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create environment:", error);
    return NextResponse.json({ error: "Failed to create environment" }, { status: 500 });
  }
}
