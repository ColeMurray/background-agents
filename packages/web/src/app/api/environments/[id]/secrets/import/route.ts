import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { id } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch(
      `/environments/${encodeURIComponent(id)}/secrets/import`,
      { method: "POST", body: JSON.stringify(body) }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to import environment secrets:", error);
    return NextResponse.json({ error: "Failed to import environment secrets" }, { status: 500 });
  }
}
