import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";
import { WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES } from "@/lib/session-attachment-limits";

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: sessionId } = await params;
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Attachment is too large" }, { status: 413 });
  }

  try {
    // Forward the raw body so the original multipart boundary stays intact.
    const body = await request.arrayBuffer();
    if (body.byteLength > WEB_SESSION_ATTACHMENT_MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "Attachment is too large" }, { status: 413 });
    }

    const response = await controlPlaneFetch(`/sessions/${sessionId}/attachments`, {
      method: "POST",
      body,
      headers: { "Content-Type": contentType },
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to upload attachment:", error);
    return NextResponse.json({ error: "Failed to upload attachment" }, { status: 500 });
  }
}
