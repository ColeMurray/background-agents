import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { buildControlPlanePath } from "@/lib/control-plane-query";

const SESSION_INBOX_QUERY_PARAMS = ["category", "cursor", "mine"] as const;

export async function GET(request: NextRequest) {
  try {
    const path = buildControlPlanePath(
      "/sessions/inbox",
      request.nextUrl.searchParams,
      SESSION_INBOX_QUERY_PARAMS
    );
    const response = await controlPlaneUserFetch(path);
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to fetch session inbox:", error);
    return NextResponse.json({ error: "Failed to fetch session inbox" }, { status: 500 });
  }
}
