import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET() {
  try {
    const response = await controlPlaneUserFetch("/secrets");
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch global secrets:", error);
    return NextResponse.json({ error: "Failed to fetch global secrets" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch("/secrets", {
      method: "PUT",
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update global secrets:", error);
    return NextResponse.json({ error: "Failed to update global secrets" }, { status: 500 });
  }
}
