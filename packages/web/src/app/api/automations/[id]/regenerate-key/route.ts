import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rejectMissingBrowserSessionCookie } from "@/lib/browser-session-guard";
import { controlPlaneUserFetch } from "@/lib/control-plane";

// Key rotation accepts only an optional client secret, not a bulk payload.
const MAX_REGENERATE_KEY_BODY_BYTES = 16 * 1024;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rejection = rejectMissingBrowserSessionCookie(request);
  if (rejection) return rejection;

  const { id } = await params;

  try {
    const contentLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_REGENERATE_KEY_BODY_BYTES) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const bytes = await readBodyCapped(request.body, MAX_REGENERATE_KEY_BODY_BYTES);
    if (bytes === null) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    const body = new TextDecoder().decode(bytes);
    const response = await controlPlaneUserFetch(
      `/automations/${encodeURIComponent(id)}/regenerate-key`,
      {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}),
      }
    );
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to regenerate key:", error);
    return NextResponse.json({ error: "Failed to regenerate key" }, { status: 500 });
  }
}
