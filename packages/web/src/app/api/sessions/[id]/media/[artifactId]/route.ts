import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; artifactId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId, artifactId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    return NextResponse.json({ error: "Invalid artifact ID" }, { status: 400 });
  }

  try {
    const response = await controlPlaneFetch(`/sessions/${sessionId}/media/${artifactId}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch media: ${errorText}`);
      return NextResponse.json({ error: "Failed to fetch media" }, { status: response.status });
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });

    for (const headerName of ["Content-Type", "Content-Length", "ETag"]) {
      const headerValue = response.headers.get(headerName);
      if (headerValue) {
        headers.set(headerName, headerValue);
      }
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    console.error("Failed to fetch media:", error);
    return NextResponse.json({ error: "Failed to fetch media" }, { status: 500 });
  }
}
