import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const { owner, name } = await params;

  try {
    const response = await controlPlaneUserFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets`
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch repo secrets:", error);
    return NextResponse.json({ error: "Failed to fetch repo secrets" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { owner, name } = await params;

  try {
    const body = await request.json();

    const response = await controlPlaneUserFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to update repo secrets:", error);
    return NextResponse.json({ error: "Failed to update repo secrets" }, { status: 500 });
  }
}
