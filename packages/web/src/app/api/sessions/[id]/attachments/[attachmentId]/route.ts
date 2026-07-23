import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId, attachmentId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    return NextResponse.json({ error: "Invalid attachment ID" }, { status: 400 });
  }

  try {
    const range = request.headers.get("Range");
    const attachmentPath = `/sessions/${sessionId}/attachments/${attachmentId}`;
    const response = range
      ? await controlPlaneFetch(attachmentPath, { headers: { Range: range } })
      : await controlPlaneFetch(attachmentPath);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch attachment: ${errorText}`);
      return NextResponse.json(
        { error: "Failed to fetch attachment" },
        { status: response.status }
      );
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
    console.error("Failed to fetch attachment:", error);
    return NextResponse.json({ error: "Failed to fetch attachment" }, { status: 500 });
  }
}
