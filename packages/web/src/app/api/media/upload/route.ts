import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { controlPlaneFetch } from "@/lib/control-plane";

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    const filename = request.headers.get("x-filename") ?? "upload";

    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
      return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
    }

    const body = await request.arrayBuffer();

    const response = await controlPlaneFetch("/api/media/upload", {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "X-Filename": filename,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Media upload failed: ${errorText}`);
      return NextResponse.json({ error: "Upload failed" }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Media upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
