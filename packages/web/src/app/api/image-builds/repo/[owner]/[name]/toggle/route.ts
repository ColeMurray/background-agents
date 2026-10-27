import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { rejectUnsupportedRepoImages } from "@/lib/repo-images-unsupported";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; name: string }> }
) {
  try {
    const rejection = await rejectUnsupportedRepoImages();
    if (rejection) return rejection;

    const authRejection = rejectMissingBrowserSessionCookie(request);
    if (authRejection) return authRejection;

    const { owner, name } = await params;
    const body = await request.json();

    const response = await controlPlaneUserFetch(
      `/image-builds/toggle/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to toggle image build:", error);
    return NextResponse.json({ error: "Failed to toggle image build" }, { status: 500 });
  }
}
