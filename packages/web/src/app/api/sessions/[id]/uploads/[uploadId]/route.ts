import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId, uploadId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return NextResponse.json({ error: "Invalid upload ID" }, { status: 400 });
  }

  try {
    const range = request.headers.get("Range");
    const uploadPath = `/sessions/${sessionId}/uploads/${uploadId}`;
    const response = range
      ? await controlPlaneFetch(uploadPath, { headers: { Range: range } })
      : await controlPlaneFetch(uploadPath);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch upload: ${errorText}`);
      return NextResponse.json({ error: "Failed to fetch upload" }, { status: response.status });
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });

    for (const headerName of [
      "Content-Type",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "ETag",
    ]) {
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
    console.error("Failed to fetch upload:", error);
    return NextResponse.json({ error: "Failed to fetch upload" }, { status: 500 });
  }
}
